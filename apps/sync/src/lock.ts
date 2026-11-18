import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0`;

const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

export interface LeaderLockOptions {
  /** Redis key; default `<prefix>:sync:leader`. */
  key: string;
  /** Lock lifetime; renewed every ttl/3 while held. */
  ttlMs?: number;
  /** Unique id of this instance. */
  owner?: string;
  onAcquired?: () => void;
  onLost?: () => void;
  onError?: (err: Error) => void;
}

/**
 * Leader election with a Redis lock (SET NX PX + compare-and-renew), so only
 * one sync instance schedules work at a time. A standby instance keeps trying
 * and takes over within one TTL if the leader dies.
 */
export class LeaderLock {
  readonly key: string;
  readonly owner: string;
  readonly ttlMs: number;
  private held = false;
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;

  constructor(
    private readonly redis: Redis,
    private readonly opts: LeaderLockOptions,
  ) {
    this.key = opts.key;
    this.owner = opts.owner ?? randomUUID();
    this.ttlMs = opts.ttlMs ?? 30_000;
  }

  get isLeader(): boolean {
    return this.held;
  }

  /** Try once to take or renew the lock. Returns whether this instance holds it. */
  async tick(): Promise<boolean> {
    try {
      if (this.held) {
        const ok = await this.redis.eval(RENEW_SCRIPT, 1, this.key, this.owner, String(this.ttlMs));
        if (Number(ok) !== 1) this.setHeld(false);
      } else {
        const ok = await this.redis.set(this.key, this.owner, 'PX', this.ttlMs, 'NX');
        if (ok === 'OK') this.setHeld(true);
      }
    } catch (err) {
      this.opts.onError?.(err as Error);
      // Cannot confirm the lock: assume it is lost rather than risk two leaders.
      if (this.held) this.setHeld(false);
    }
    return this.held;
  }

  private setHeld(v: boolean): void {
    if (v === this.held) return;
    this.held = v;
    if (v) this.opts.onAcquired?.();
    else this.opts.onLost?.();
  }

  /** Keep trying/renewing in the background every ttl/3. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      await this.tick();
      if (!this.stopped)
        this.timer = setTimeout(() => void loop(), Math.max(50, Math.floor(this.ttlMs / 3)));
    };
    void loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.held) {
      await this.redis.eval(RELEASE_SCRIPT, 1, this.key, this.owner).catch(() => undefined);
      // Released on purpose: not reported through onLost.
      this.held = false;
    }
  }
}
