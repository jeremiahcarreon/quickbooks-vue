import type { Logger, RelayLike } from './types.js';
import { silentLogger } from './types.js';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface RelayCircuitOptions {
  relay: Pick<RelayLike, 'ping'>;
  /** Minimum time the circuit stays open before a trial request (CIRCUIT_BREAKER_COOLDOWN). */
  cooldownMs: number;
  /** How often relay health is polled (RELAY_HEALTH_INTERVAL). */
  healthIntervalMs: number;
  /** Stop taking jobs (pause the BullMQ worker). */
  onOpen?: () => void | Promise<void>;
  /** Start taking jobs again. */
  onHalfOpen?: () => void | Promise<void>;
  /** Called whenever the observed relay health changes (publish relay.health). */
  onHealth?: (connected: boolean, error: string | null) => void | Promise<void>;
  log?: Logger;
}

/**
 * Circuit breaker around the relay.
 *
 * - closed: jobs flow. A transient relay failure (503, 504, network) opens it.
 *   A health poll that cannot reach the relay at all also opens it.
 * - open: the worker is paused, so queued commands wait in Redis instead of
 *   burning their retry attempts. After the cooldown the relay is pinged; once
 *   it answers, the circuit goes half-open.
 * - half-open: the worker resumes; the next request decides. Success closes
 *   the circuit, another transient failure opens it again.
 *
 * The relay's own `connected` flag is reported in relay.health events but does
 * not keep the circuit open by itself: the relay notes that the flag can be
 * stale, and a trial request is the reliable test.
 */
export class RelayCircuit {
  private _state: CircuitState = 'closed';
  private openedAt = 0;
  private lastError: string | null = null;
  private healthTimer: NodeJS.Timeout | undefined;
  private probeTimer: NodeJS.Timeout | undefined;
  private lastHealth: { connected: boolean; error: string | null } | undefined;
  private stopped = true;
  private polling = false;
  private disposed = false;
  private readonly log: Logger;

  constructor(private readonly opts: RelayCircuitOptions) {
    this.log = opts.log ?? silentLogger;
  }

  get state(): CircuitState {
    return this._state;
  }

  isOpen(): boolean {
    return this._state === 'open';
  }

  /** Start periodic health polling (runs one poll immediately). */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.disposed = false;
    void this.poll();
    this.healthTimer = setInterval(() => void this.poll(), this.opts.healthIntervalMs);
    this.healthTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    this.disposed = true;
    clearInterval(this.healthTimer);
    clearTimeout(this.probeTimer);
    this.healthTimer = undefined;
    this.probeTimer = undefined;
  }

  /** A request reached QuickBooks and got an answer. */
  async recordSuccess(): Promise<void> {
    if (this._state !== 'closed') {
      this.log.info({ previous: this._state }, 'relay circuit closed');
      this._state = 'closed';
      clearTimeout(this.probeTimer);
      this.probeTimer = undefined;
    }
    await this.reportHealth(true, null);
  }

  /** A transient relay failure (503, 504, network error). */
  async recordFailure(error: string): Promise<void> {
    this.lastError = error;
    await this.reportHealth(false, error);
    if (this._state === 'open') return;
    await this.open(error);
  }

  private async open(error: string): Promise<void> {
    this.log.warn({ error, cooldownMs: this.opts.cooldownMs }, 'relay circuit opened');
    this._state = 'open';
    this.openedAt = Date.now();
    try {
      await this.opts.onOpen?.();
    } catch (err) {
      this.log.error({ err }, 'circuit onOpen failed');
    }
    this.scheduleProbe(this.opts.cooldownMs);
  }

  private scheduleProbe(delayMs: number): void {
    clearTimeout(this.probeTimer);
    if (this.disposed) return;
    this.probeTimer = setTimeout(() => void this.probe(), Math.max(0, delayMs));
    this.probeTimer.unref?.();
  }

  /** After the cooldown: go half-open once the relay answers its health check. */
  private async probe(): Promise<void> {
    if (this._state !== 'open' || this.disposed) return;
    const remaining = this.openedAt + this.opts.cooldownMs - Date.now();
    if (remaining > 0) return this.scheduleProbe(remaining);
    const h = await this.opts.relay.ping();
    if (this._state !== 'open') return;
    await this.reportHealth(
      h.ok && h.connected,
      h.ok ? (h.error ?? null) : (h.error ?? 'unreachable'),
    );
    if (!h.ok) {
      this.log.debug({ error: h.error }, 'relay still unreachable');
      return this.scheduleProbe(Math.min(this.opts.healthIntervalMs, this.opts.cooldownMs));
    }
    this.log.info({ connected: h.connected }, 'relay circuit half-open, trying the next job');
    this._state = 'half-open';
    try {
      await this.opts.onHalfOpen?.();
    } catch (err) {
      this.log.error({ err }, 'circuit onHalfOpen failed');
    }
  }

  /** One periodic health check. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const h = await this.opts.relay.ping();
      const connected = h.ok && h.connected;
      await this.reportHealth(connected, connected ? null : (h.error ?? this.lastError ?? null));
      if (!h.ok && this._state === 'closed') await this.open(h.error ?? 'relay unreachable');
    } finally {
      this.polling = false;
    }
  }

  private async reportHealth(connected: boolean, error: string | null): Promise<void> {
    if (this.lastHealth && this.lastHealth.connected === connected) return;
    this.lastHealth = { connected, error };
    try {
      await this.opts.onHealth?.(connected, error);
    } catch (err) {
      this.log.error({ err }, 'publishing relay health failed');
    }
  }
}
