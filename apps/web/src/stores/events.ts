import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { API_BASE } from '@/api/client';
import { fetchHealth } from '@/api/endpoints';
import { toEvent } from '@/api/normalize';
import type { QbvEvent, QbvEventType } from '@/api/types';

/** Minimal EventSource surface, so tests can supply a fake. */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((ev: Event) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
  onmessage: ((ev: MessageEvent) => unknown) | null;
  addEventListener(type: string, listener: (ev: MessageEvent) => void): void;
  close(): void;
}
export type EventSourceFactory = (url: string) => EventSourceLike;

let factory: EventSourceFactory = (url) =>
  new EventSource(url, { withCredentials: true }) as unknown as EventSourceLike;

/** For tests. */
export function setEventSourceFactory(f: EventSourceFactory): void {
  factory = f;
}

export const EVENT_TYPES: QbvEventType[] = [
  'object.changed',
  'command.updated',
  'sync.progress',
  'relay.health',
];
/** Reconnect delays (ms); the last one repeats. */
export const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000];

type Handler = (e: QbvEvent) => void;
export type StreamStatus = 'idle' | 'connecting' | 'open' | 'reconnecting';

/**
 * Live updates from GET /api/events (SSE). Reconnects with backoff, keeps the
 * relay health indicator current and bumps a per-type revision counter on
 * object.changed so lists and detail pages refresh themselves.
 */
export const useEventsStore = defineStore('events', () => {
  const status = ref<StreamStatus>('idle');
  const relayConnected = ref<boolean | null>(null);
  const relayError = ref<string | null>(null);
  const lastEventAt = ref<number | null>(null);
  /** object.changed counter per entity type. */
  const revisions = reactive<Record<string, number>>({});
  /** Last object.changed per `type:id` (op + time), for detail pages. */
  const lastChange = reactive<Record<string, { op: string; at: number }>>({});
  const sync = reactive<Record<string, { status: string; count: number; at: number }>>({});

  const handlers = new Map<string, Set<Handler>>();
  const reconnectHandlers = new Set<() => void>();
  let source: EventSourceLike | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wanted = false;
  let everOpened = false;

  function on(type: QbvEventType | '*', handler: Handler): () => void {
    if (!handlers.has(type)) handlers.set(type, new Set());
    handlers.get(type)!.add(handler);
    return () => handlers.get(type)?.delete(handler);
  }

  /** Called after the stream re-opens following a drop (events may have been missed). */
  function onReconnect(cb: () => void): () => void {
    reconnectHandlers.add(cb);
    return () => reconnectHandlers.delete(cb);
  }

  function dispatch(e: QbvEvent) {
    lastEventAt.value = Date.now();
    switch (e.type) {
      case 'object.changed':
        revisions[e.objectType] = (revisions[e.objectType] ?? 0) + 1;
        lastChange[`${e.objectType}:${e.qbId}`] = { op: e.op, at: Date.now() };
        break;
      case 'relay.health':
        relayConnected.value = e.connected;
        relayError.value = e.error ?? null;
        break;
      case 'sync.progress':
        sync[e.objectType] = { status: e.status, count: e.count, at: Date.now() };
        break;
    }
    for (const key of [e.type, '*']) {
      for (const h of handlers.get(key) ?? []) {
        try {
          h(e);
        } catch (err) {
          console.error('event handler failed', err);
        }
      }
    }
  }

  function handleRaw(data: string, name?: string) {
    const e = toEvent(data, name);
    if (e) dispatch(e);
  }

  function open() {
    if (source) return;
    status.value = attempt === 0 && !everOpened ? 'connecting' : 'reconnecting';
    const es = factory(`${API_BASE}/events`);
    source = es;
    es.onopen = () => {
      const wasReconnect = everOpened;
      everOpened = true;
      attempt = 0;
      status.value = 'open';
      if (wasReconnect) reconnectHandlers.forEach((cb) => cb());
    };
    es.onmessage = (ev) => handleRaw(String(ev.data), ev.type);
    for (const t of EVENT_TYPES) es.addEventListener(t, (ev) => handleRaw(String(ev.data), t));
    es.onerror = () => {
      // The browser retries some failures itself but gives up on HTTP errors;
      // always take over so the backoff is predictable.
      es.close();
      if (source === es) source = null;
      if (wanted) scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (timer) return;
    status.value = 'reconnecting';
    const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)]!;
    attempt++;
    timer = setTimeout(() => {
      timer = null;
      if (wanted) open();
    }, delay);
  }

  function connect() {
    wanted = true;
    open();
    void refreshHealth();
  }

  function disconnect() {
    wanted = false;
    if (timer) clearTimeout(timer);
    timer = null;
    source?.close();
    source = null;
    attempt = 0;
    everOpened = false;
    status.value = 'idle';
  }

  /** Initial relay status (and a manual refresh) from GET /health. */
  async function refreshHealth() {
    try {
      const h = await fetchHealth();
      if (h.relayConnected !== null) relayConnected.value = h.relayConnected;
    } catch {
      // the stream will report relay.health when it changes
    }
  }

  return {
    status,
    relayConnected,
    relayError,
    lastEventAt,
    revisions,
    lastChange,
    sync,
    on,
    onReconnect,
    dispatch,
    connect,
    disconnect,
    refreshHealth,
  };
});
