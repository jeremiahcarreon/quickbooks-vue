import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * Manual sync requests (POST /admin/sync/:type in the api). Requests are JSON
 * strings pushed onto a Redis list; the sync leader drains the list between
 * units, so a request made while no sync instance is running is kept until
 * one starts.
 *
 *   RPUSH <QUEUE_PREFIX>:sync:requests '{"type":"Customer","mode":"full"}'
 */
export const SYNC_REQUESTS_SUFFIX = 'sync:requests';

export const SYNC_MODES = ['incremental', 'full', 'reconcile'] as const;
export type SyncMode = (typeof SYNC_MODES)[number];

export interface SyncRequest {
  id: string;
  /** Entity name (e.g. Customer), or '*' for every synced entity. */
  type: string;
  /**
   * incremental: changes since the cursor now (initial load if never loaded).
   * full: forget the cursor and reload everything (initial load, priority 10).
   * reconcile: ID-only comparison now.
   */
  mode: SyncMode;
  requestedBy?: string | null;
  requestedAt: string;
}

export function syncRequestsKey(prefix = 'qbv'): string {
  return `${prefix}:${SYNC_REQUESTS_SUFFIX}`;
}

/** Parse one list entry; null when malformed. */
export function parseSyncRequest(raw: string): SyncRequest | null {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  if (typeof r.type !== 'string' || r.type.length === 0) return null;
  const mode = r.mode ?? 'incremental';
  if (typeof mode !== 'string' || !(SYNC_MODES as readonly string[]).includes(mode)) return null;
  return {
    id: typeof r.id === 'string' ? r.id : randomUUID(),
    type: r.type,
    mode: mode as SyncMode,
    requestedBy: typeof r.requestedBy === 'string' ? r.requestedBy : null,
    requestedAt: typeof r.requestedAt === 'string' ? r.requestedAt : new Date().toISOString(),
  };
}

/** Ask the running sync service to sync `type` now. Returns the stored request. */
export async function requestSync(
  redis: Redis,
  req: { type: string; mode?: SyncMode; requestedBy?: string | null },
  opts: { prefix?: string } = {},
): Promise<SyncRequest> {
  const mode = req.mode ?? 'incremental';
  if (!(SYNC_MODES as readonly string[]).includes(mode))
    throw new Error(`Unknown sync mode "${mode}"`);
  const full: SyncRequest = {
    id: randomUUID(),
    type: req.type,
    mode,
    requestedBy: req.requestedBy ?? null,
    requestedAt: new Date().toISOString(),
  };
  await redis.rpush(syncRequestsKey(opts.prefix), JSON.stringify(full));
  return full;
}

/** Take every pending request (oldest first). */
export async function drainSyncRequests(
  redis: Redis,
  opts: { prefix?: string; max?: number } = {},
): Promise<SyncRequest[]> {
  const raw = await redis.lpop(syncRequestsKey(opts.prefix), opts.max ?? 1000);
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map(parseSyncRequest).filter((r): r is SyncRequest => r !== null);
}
