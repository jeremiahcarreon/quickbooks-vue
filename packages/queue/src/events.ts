import { Redis, type RedisOptions } from 'ioredis';

/** Pub/sub channel for live updates (SSE, command tray, sync status). */
export const EVENTS_CHANNEL = 'qbv:events';

export type ObjectOp = 'add' | 'mod' | 'del' | 'void' | 'sync';

export interface ObjectChangedEvent {
  type: 'object.changed';
  objectType: string;
  qbId: string;
  op: ObjectOp;
}

export interface CommandUpdatedEvent {
  type: 'command.updated';
  id: string;
  status: string;
  /** Optional context so subscribers can filter without a DB read. */
  kind?: string;
  objectType?: string | null;
  objectId?: string | null;
  actorType?: string;
  actorId?: string | null;
}

export interface SyncProgressEvent {
  type: 'sync.progress';
  objectType: string;
  status: string;
  count: number;
}

export interface RelayHealthEvent {
  type: 'relay.health';
  connected: boolean;
  error?: string | null;
}

export type QbvEvent =
  ObjectChangedEvent | CommandUpdatedEvent | SyncProgressEvent | RelayHealthEvent;
export type QbvEventType = QbvEvent['type'];

const isStr = (v: unknown): v is string => typeof v === 'string';

/** Parse and check one message from the channel; null if malformed. */
export function parseEvent(raw: string): QbvEvent | null {
  let e: unknown;
  try {
    e = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!e || typeof e !== 'object') return null;
  const o = e as Record<string, unknown>;
  switch (o.type) {
    case 'object.changed':
      return isStr(o.objectType) && isStr(o.qbId) && isStr(o.op)
        ? (o as unknown as ObjectChangedEvent)
        : null;
    case 'command.updated':
      return isStr(o.id) && isStr(o.status) ? (o as unknown as CommandUpdatedEvent) : null;
    case 'sync.progress':
      return isStr(o.objectType) && isStr(o.status) && typeof o.count === 'number'
        ? (o as unknown as SyncProgressEvent)
        : null;
    case 'relay.health':
      return typeof o.connected === 'boolean' ? (o as unknown as RelayHealthEvent) : null;
    default:
      return null;
  }
}

/** Publish one event using any ioredis connection (not a subscriber connection). */
export async function publishEvent(
  redis: Redis,
  event: QbvEvent,
  channel = EVENTS_CHANNEL,
): Promise<number> {
  return redis.publish(channel, JSON.stringify(event));
}

export type EventHandler = (event: QbvEvent) => void;

export interface EventBus {
  publish(event: QbvEvent): Promise<void>;
  /** Resolves once the subscription is active. Returns an unsubscribe function. */
  subscribe(handler: EventHandler): Promise<() => void>;
  close(): Promise<void>;
}

/**
 * Publisher + lazily created subscriber sharing one channel. One bus per
 * process is enough; handlers are multiplexed over a single subscription.
 */
export function createEventBus(
  redis: string | Redis,
  opts: { channel?: string; redisOptions?: RedisOptions; onError?: (err: Error) => void } = {},
): EventBus {
  const channel = opts.channel ?? EVENTS_CHANNEL;
  const ownsPub = typeof redis === 'string';
  const pub =
    typeof redis === 'string'
      ? new Redis(redis, { lazyConnect: false, ...opts.redisOptions })
      : redis;
  let sub: Redis | undefined;
  let ready: Promise<void> | undefined;
  const handlers = new Set<EventHandler>();

  function ensureSub(): Promise<void> {
    if (ready) return ready;
    sub = pub.duplicate();
    sub.on('error', (err: Error) => opts.onError?.(err));
    sub.on('message', (ch: string, msg: string) => {
      if (ch !== channel) return;
      const e = parseEvent(msg);
      if (!e) return;
      for (const h of handlers) {
        try {
          h(e);
        } catch (err) {
          opts.onError?.(err as Error);
        }
      }
    });
    ready = sub.subscribe(channel).then(() => undefined);
    return ready;
  }

  return {
    async publish(event) {
      await publishEvent(pub, event, channel);
    },
    async subscribe(handler) {
      handlers.add(handler);
      await ensureSub();
      return () => {
        handlers.delete(handler);
      };
    },
    async close() {
      handlers.clear();
      if (sub) {
        sub.disconnect();
        sub = undefined;
      }
      ready = undefined;
      if (ownsPub) await pub.quit().catch(() => pub.disconnect());
    },
  };
}
