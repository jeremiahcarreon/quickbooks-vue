import { createHash } from 'node:crypto';
import type { Db } from './client.js';
import { jsonb } from './json.js';
import type { JsonValue, ReportCacheRow } from './schema.js';

/** Stable cache key for a report + params (key order independent). */
export function reportCacheKey(report: string, params: JsonValue = {}): string {
  const canon = (v: JsonValue): JsonValue =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canon(v[k]!)]),
          )
        : v;
  const hash = createHash('sha256')
    .update(JSON.stringify(canon(params)))
    .digest('hex')
    .slice(0, 32);
  return `${report}:${hash}`;
}

export async function getReportCache(
  db: Db,
  key: string,
  opts: { includeExpired?: boolean; now?: Date } = {},
): Promise<ReportCacheRow | undefined> {
  let q = db.selectFrom('report_cache').selectAll().where('key', '=', key);
  if (!opts.includeExpired) q = q.where('expires_at', '>', opts.now ?? new Date());
  return q.executeTakeFirst();
}

export async function putReportCache(
  db: Db,
  e: {
    key: string;
    report: string;
    params?: JsonValue;
    result: JsonValue;
    ttlMs: number;
    fetchedAt?: Date;
  },
): Promise<ReportCacheRow> {
  const fetchedAt = e.fetchedAt ?? new Date();
  const values = {
    key: e.key,
    report: e.report,
    params: jsonb(e.params ?? {}),
    result: jsonb(e.result),
    fetched_at: fetchedAt,
    expires_at: new Date(fetchedAt.getTime() + e.ttlMs),
  };
  return db
    .insertInto('report_cache')
    .values(values)
    .onConflict((oc) =>
      oc.column('key').doUpdateSet({
        report: values.report,
        params: values.params,
        result: values.result,
        fetched_at: values.fetched_at,
        expires_at: values.expires_at,
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function deleteReportCache(db: Db, key: string): Promise<void> {
  await db.deleteFrom('report_cache').where('key', '=', key).execute();
}

export async function purgeExpiredReports(db: Db, now: Date = new Date()): Promise<number> {
  const r = await db.deleteFrom('report_cache').where('expires_at', '<=', now).executeTakeFirst();
  return Number(r.numDeletedRows);
}
