import type { Redis } from 'ioredis';
import { Priority } from '@qbv/queue';
import { parseCron, previousFire, type CronSchedule } from './cron.js';
import type { Logger, SyncEngine } from './engine.js';
import type { LeaderLock } from './lock.js';
import { isIncremental, type SyncPlan, type SyncUnit } from './plan.js';
import { SyncAbortedError } from './runner.js';
import { drainSyncRequests, type SyncRequest } from './triggers.js';

export interface SchedulerOptions {
  engine: SyncEngine;
  plan: SyncPlan;
  /** Redis for manual requests (and the lock's connection). */
  redis: Redis;
  prefix?: string;
  /** Incremental pass interval (SYNC_INTERVAL). */
  intervalMs: number;
  /** Full re-query interval for units without a modified filter (SYNC_FULL_INTERVAL). */
  fullIntervalMs: number;
  /** Reconcile schedule (SYNC_RECONCILE_CRON). */
  reconcileCron: string;
  /** Only the lock holder schedules work. Without a lock this instance always runs. */
  lock?: LeaderLock;
  logger: Logger;
  now?: () => Date;
  /** Main loop tick (default 1s). */
  tickMs?: number;
  /** Longest wait before retrying a failing unit (default 1h). */
  maxBackoffMs?: number;
}

interface Backoff {
  failures: number;
  until: number;
}

export interface PassSummary {
  ran: string[];
  failed: string[];
  skipped: string[];
}

/**
 * Decides what runs when. One pass at a time, units one after another: each
 * unit waits for its own relay commands, which is the natural back-pressure
 * when QuickBooks is slow or the relay is down.
 */
export class SyncScheduler {
  private readonly o: SchedulerOptions;
  private readonly cron: CronSchedule;
  private readonly now: () => Date;
  private readonly backoff = new Map<string, Backoff>();
  private nextIncrementalAt = 0;
  private nextFullAt = 0;
  private lastReconcileCheck = '';
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private abort = new AbortController();

  constructor(opts: SchedulerOptions) {
    this.o = opts;
    this.cron = parseCron(opts.reconcileCron);
    this.now = opts.now ?? (() => new Date());
  }

  get units(): SyncUnit[] {
    return this.o.plan.units;
  }

  /** Units a request names: an entity (its unit) or '*'. */
  resolveUnits(type: string): SyncUnit[] {
    if (type === '*') return this.units;
    const key = this.o.plan.unitOf[type];
    const u = key ? this.units.find((x) => x.key === key) : this.units.find((x) => x.key === type);
    return u ? [u] : [];
  }

  private inBackoff(key: string): boolean {
    const b = this.backoff.get(key);
    return !!b && b.until > this.now().getTime();
  }

  private recordFailure(key: string, baseMs: number): void {
    const b = this.backoff.get(key) ?? { failures: 0, until: 0 };
    b.failures++;
    const wait = Math.min(baseMs * 2 ** (b.failures - 1), this.o.maxBackoffMs ?? 3_600_000);
    b.until = this.now().getTime() + wait;
    this.backoff.set(key, b);
  }

  /** Run `fn` for a unit, recording failures; rethrows only aborts. */
  private async guard(
    key: string,
    baseMs: number,
    summary: PassSummary,
    fn: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await fn();
      this.backoff.delete(key);
      summary.ran.push(key);
    } catch (err) {
      if (err instanceof SyncAbortedError) throw err;
      this.recordFailure(key, baseMs);
      summary.failed.push(key);
      this.o.logger.warn({ unit: key, err: (err as Error).message }, 'sync step failed');
    }
  }

  /** Execute manual requests now (ignores backoff). */
  async handleRequests(reqs: SyncRequest[], signal: AbortSignal): Promise<PassSummary> {
    const { engine } = this.o;
    const summary: PassSummary = { ran: [], failed: [], skipped: [] };
    for (const req of reqs) {
      const units = this.resolveUnits(req.type);
      if (units.length === 0) {
        this.o.logger.warn({ request: req }, 'sync request names no synced entity');
        summary.skipped.push(req.type);
        continue;
      }
      this.o.logger.info({ request: req }, 'manual sync request');
      for (const u of units) {
        await this.guard(u.key, this.o.intervalMs, summary, async () => {
          if (req.mode === 'full') {
            if (isIncremental(u)) {
              await engine.reset(u);
              await engine.fullLoad(u, { phase: 'initial', priority: Priority.BulkSync, signal });
            } else {
              await engine.fullLoad(u, { phase: 'full', priority: Priority.BulkSync, signal });
            }
          } else if (req.mode === 'reconcile' && u.reconcilable && isIncremental(u)) {
            const st = await engine.state(u);
            if (st.loaded) await engine.reconcile(u, { signal });
            else await engine.incremental(u, { signal });
          } else {
            await engine.incremental(u, { priority: Priority.IncrementalSync, signal });
          }
        });
      }
      if (req.mode !== 'reconcile' && units.some((u) => isIncremental(u))) {
        await this.guard('deleted', this.o.intervalMs, summary, () =>
          engine.deletions(units, { signal }),
        );
      }
    }
    return summary;
  }

  /** Deletions, then incrementals for loaded units, then initial loads for the rest. */
  async incrementalPass(signal: AbortSignal): Promise<PassSummary> {
    const { engine } = this.o;
    const summary: PassSummary = { ran: [], failed: [], skipped: [] };
    const units = this.units.filter(isIncremental);
    const loaded: SyncUnit[] = [];
    const unloaded: SyncUnit[] = [];
    for (const u of units) ((await engine.state(u)).loaded ? loaded : unloaded).push(u);

    if (loaded.length > 0 && !this.inBackoff('deleted')) {
      await this.guard('deleted', this.o.intervalMs, summary, () =>
        engine.deletions(loaded, { signal }),
      );
    }
    for (const u of [...loaded, ...unloaded]) {
      if (signal.aborted) throw new SyncAbortedError();
      if (this.inBackoff(u.key)) {
        summary.skipped.push(u.key);
        continue;
      }
      await this.guard(u.key, this.o.intervalMs, summary, () => engine.incremental(u, { signal }));
    }
    return summary;
  }

  /** Full re-query of units without a modified-date filter. */
  async fullPass(signal: AbortSignal): Promise<PassSummary> {
    const summary: PassSummary = { ran: [], failed: [], skipped: [] };
    for (const u of this.units.filter((x) => !isIncremental(x))) {
      if (signal.aborted) throw new SyncAbortedError();
      if (this.inBackoff(u.key)) {
        summary.skipped.push(u.key);
        continue;
      }
      await this.guard(u.key, this.o.fullIntervalMs, summary, () =>
        this.o.engine.fullLoad(u, { phase: 'full', signal }),
      );
    }
    return summary;
  }

  /** Reconcile loaded units whose last reconcile is older than the latest cron fire time. */
  async reconcilePass(signal: AbortSignal, at: Date = this.now()): Promise<PassSummary> {
    const summary: PassSummary = { ran: [], failed: [], skipped: [] };
    const fire = previousFire(this.cron, at);
    if (!fire) return summary;
    for (const u of this.units) {
      if (!u.reconcilable || !isIncremental(u)) continue;
      if (signal.aborted) throw new SyncAbortedError();
      const st = await this.o.engine.state(u);
      if (!st.loaded) continue;
      if (st.lastReconcileAt && st.lastReconcileAt >= fire) continue;
      if (this.inBackoff(`reconcile:${u.key}`)) {
        summary.skipped.push(u.key);
        continue;
      }
      await this.guard(`reconcile:${u.key}`, this.o.intervalMs, summary, () =>
        this.o.engine.reconcile(u, { signal }),
      );
    }
    return summary;
  }

  /** One scheduling step: manual requests, then whatever is due. */
  async step(signal: AbortSignal = this.abort.signal): Promise<void> {
    const reqs = await drainSyncRequests(this.o.redis, { prefix: this.o.prefix });
    if (reqs.length > 0) await this.handleRequests(reqs, signal);

    const now = this.now().getTime();
    if (now >= this.nextIncrementalAt) {
      this.nextIncrementalAt = now + this.o.intervalMs;
      const s = await this.incrementalPass(signal);
      this.o.logger.debug({ ...s }, 'incremental pass');
    }
    if (now >= this.nextFullAt) {
      this.nextFullAt = now + this.o.fullIntervalMs;
      const s = await this.fullPass(signal);
      this.o.logger.debug({ ...s }, 'full pass');
    }
    const minute = this.now().toISOString().slice(0, 16);
    if (minute !== this.lastReconcileCheck) {
      this.lastReconcileCheck = minute;
      const s = await this.reconcilePass(signal);
      if (s.ran.length || s.failed.length) this.o.logger.info({ ...s }, 'reconcile pass');
    }
  }

  /** Start the loop (and the leader lock, when given). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    const lock = this.o.lock;
    lock?.start();
    this.loop = (async () => {
      while (this.running) {
        const leader = lock ? lock.isLeader : true;
        if (leader) {
          try {
            await this.step(this.abort.signal);
          } catch (err) {
            if (!(err instanceof SyncAbortedError)) {
              this.o.logger.error({ err: (err as Error).message }, 'sync step crashed');
            }
          }
        }
        if (!this.running) break;
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, this.o.tickMs ?? 1000);
          this.wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
        this.wake = undefined;
        if (this.abort.signal.aborted && this.running) this.abort = new AbortController();
      }
    })();
  }

  /** Abort the current pass (e.g. leadership lost); the loop keeps running. */
  interrupt(): void {
    this.abort.abort();
    // Run the next step from scratch once leadership returns.
    this.nextIncrementalAt = 0;
    this.nextFullAt = 0;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort.abort();
    this.wake?.();
    await this.loop;
    await this.o.lock?.stop();
  }
}
