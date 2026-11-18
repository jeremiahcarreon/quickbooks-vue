import { isOk, type ParsedRs } from '@qbv/qbxml';
import {
  getSyncState,
  markDeleted,
  upsertObjects,
  upsertSyncState,
  type Db,
  type SyncStateRow,
} from '@qbv/db';
import { Priority, type EventBus, type QbvEvent } from '@qbv/queue';
import type { SyncUnit } from './plan.js';
import {
  buildDeletedQuery,
  buildFetchByIdsQuery,
  buildIncrementalQuery,
  buildInitialQuery,
  buildReconcileQuery,
  deletedQueryTypes,
  DEFAULT_PAGE_SIZE,
  ID_BATCH_SIZE,
  type BuiltQuery,
  type PageIterator,
  type QueryBuildOptions,
} from './queries.js';
import { SyncAbortedError, type QueryRunner, type SyncPhase } from './runner.js';
import { countLive, keyOverrides, localIndex, markMissingDeletedBefore, qbIdOf } from './store.js';

type Ret = Record<string, unknown>;

/** QuickBooks "no matching objects" (Info): an empty, successful query. */
export const QB_NO_MATCH = 1;

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
}

const silentLogger: Logger = { info() {}, warn() {}, error() {}, debug() {} };

export interface SyncEngineOptions {
  db: Db;
  runner: QueryRunner;
  events?: EventBus;
  logger?: Logger;
  /** qbXML version header (QBXML_VERSION). */
  version?: string;
  pageSize?: number;
  /** Overlap subtracted from the cursor on each incremental run (default 1 minute). */
  overlapMs?: number;
  includeCustomFields?: boolean;
  /** Clock (tests). */
  now?: () => Date;
  /** object.changed events are published per object only for pages up to this size. */
  maxChangeEvents?: number;
}

export class QbStatusError extends Error {
  constructor(
    readonly rq: string,
    readonly statusCode: number,
    readonly statusMessage: string,
  ) {
    super(`${rq} failed: ${statusCode} ${statusMessage}`);
    this.name = 'QbStatusError';
  }
}

export interface UnitState {
  /** Min cursor across the unit's entities (null when any has none). */
  cursor: Date | null;
  /** True when every entity has completed a full load. */
  loaded: boolean;
  lastReconcileAt: Date | null;
  rows: SyncStateRow[];
}

export interface LoadResult {
  unit: string;
  phase: SyncPhase;
  count: number;
  pages: number;
  deleted: number;
  cursor: Date | null;
}

export interface ReconcileResult {
  unit: string;
  checked: number;
  refetched: number;
  deleted: number;
}

export interface DeletionResult {
  kind: 'list' | 'txn';
  count: number;
  deleted: number;
}

const toDate = (v: unknown): Date | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Delete types per deleted query, for the units given (values checked against the schema enum). */
export function deleteGroups(units: readonly SyncUnit[]): { list: string[]; txn: string[] } {
  const listEnum = new Set(deletedQueryTypes('list'));
  const txnEnum = new Set(deletedQueryTypes('txn'));
  const out = { list: [] as string[], txn: [] as string[] };
  for (const u of units) {
    for (const t of u.delTypes) {
      if (u.category === 'list' && listEnum.has(t)) out.list.push(t);
      else if (u.category === 'txn' && txnEnum.has(t)) out.txn.push(t);
    }
  }
  out.list = [...new Set(out.list)].sort();
  out.txn = [...new Set(out.txn)].sort();
  return out;
}

/**
 * The sync operations for one unit at a time. Every query is built by
 * queries.ts (XSD-validated) and sent through the runner (the relay queue).
 */
export class SyncEngine {
  readonly db: Db;
  private readonly runner: QueryRunner;
  private readonly events?: EventBus;
  private readonly log: Logger;
  private readonly qopts: QueryBuildOptions;
  private readonly overlapMs: number;
  private readonly now: () => Date;
  private readonly maxChangeEvents: number;

  constructor(opts: SyncEngineOptions) {
    this.db = opts.db;
    this.runner = opts.runner;
    this.events = opts.events;
    this.log = opts.logger ?? silentLogger;
    this.qopts = {
      version: opts.version,
      pageSize: opts.pageSize ?? DEFAULT_PAGE_SIZE,
      includeCustomFields: opts.includeCustomFields ?? true,
    };
    this.overlapMs = opts.overlapMs ?? 60_000;
    this.now = opts.now ?? (() => new Date());
    this.maxChangeEvents = opts.maxChangeEvents ?? 100;
  }

  async state(unit: SyncUnit): Promise<UnitState> {
    const rows: SyncStateRow[] = [];
    for (const e of unit.entities) {
      const r = await getSyncState(this.db, e.name);
      if (r) rows.push(r);
    }
    const complete = rows.length === unit.entities.length;
    const cursors = rows.map((r) => toDate(r.last_modified_cursor));
    const reconciles = rows.map((r) => toDate(r.last_reconcile_at));
    const minDate = (ds: (Date | null)[]): Date | null =>
      complete && ds.every((d) => d) ? new Date(Math.min(...ds.map((d) => d!.getTime()))) : null;
    return {
      cursor: minDate(cursors),
      loaded: complete && rows.every((r) => r.last_full_sync_at !== null),
      lastReconcileAt: minDate(reconciles),
      rows,
    };
  }

  private async publish(e: QbvEvent): Promise<void> {
    await this.events?.publish(e).catch(() => undefined);
  }

  private async progress(unit: SyncUnit, status: string, count: number): Promise<void> {
    for (const e of unit.entities) {
      await this.publish({ type: 'sync.progress', objectType: e.name, status, count });
    }
  }

  async setStatus(unit: SyncUnit, status: string, error: string | null = null): Promise<void> {
    for (const e of unit.entities) {
      await upsertSyncState(this.db, e.name, { status, error, lastRunAt: this.now() });
    }
  }

  /** Run one query; a "no match" answer is an empty success, any other QB error throws. */
  private async query(
    q: BuiltQuery,
    unitKey: string,
    phase: SyncPhase,
    priority: number,
    signal?: AbortSignal,
  ): Promise<ParsedRs> {
    if (signal?.aborted) throw new SyncAbortedError();
    const { rs } = await this.runner.run({
      query: q,
      priority,
      objectType: unitKey,
      phase,
      signal,
    });
    if (rs.statusCode === QB_NO_MATCH) return { ...rs, rets: [], retNames: [] };
    if (!isOk(rs)) throw new QbStatusError(q.rq, rs.statusCode, rs.statusMessage);
    if (rs.statusSeverity === 'Warn') {
      this.log.warn(
        { rq: q.rq, statusCode: rs.statusCode, msg: rs.statusMessage },
        'QuickBooks warning',
      );
    }
    return rs;
  }

  /** Group a response's Rets by target entity (union queries return other kinds too). */
  private group(unit: SyncUnit, rs: ParsedRs): Map<string, Ret[]> {
    const out = new Map<string, Ret[]>();
    rs.rets.forEach((ret, i) => {
      const name = rs.retNames[i] ?? rs.retName;
      const entity = name ? unit.retToEntity[name] : undefined;
      if (!entity) return;
      const list = out.get(entity) ?? [];
      list.push(ret);
      out.set(entity, list);
    });
    return out;
  }

  /**
   * Fetch every page of a load query: `from` set = incremental, else full.
   * Rets are upserted as each page arrives. If a Continue page fails (the
   * iterator expired, e.g. the relay restarted) the load restarts once.
   */
  private async fetchAll(
    unit: SyncUnit,
    phase: SyncPhase,
    priority: number,
    from: Date | undefined,
    signal?: AbortSignal,
  ): Promise<{
    ids: Map<string, string[]>;
    count: number;
    pages: number;
    maxModified: Date | null;
  }> {
    let restarts = 0;
    for (;;) {
      const ids = new Map<string, string[]>(unit.entities.map((e) => [e.name, []]));
      let count = 0;
      let pages = 0;
      let maxModified: Date | null = null;
      let page: PageIterator = { iterator: 'Start' };
      try {
        for (;;) {
          const q = from
            ? buildIncrementalQuery(unit, from, { ...this.qopts, page })
            : buildInitialQuery(unit, { ...this.qopts, page });
          const rs = await this.query(q, unit.key, phase, priority, signal);
          pages++;
          for (const [entityName, rets] of this.group(unit, rs)) {
            const entity = unit.entities.find((e) => e.name === entityName)!;
            await upsertObjects(this.db, entity, rets, { overrides: keyOverrides(entity) });
            const list = ids.get(entityName)!;
            for (const r of rets) {
              const id = qbIdOf(entity, r);
              if (id) list.push(id);
              const tm = toDate(r.TimeModified);
              if (tm && (!maxModified || tm > maxModified)) maxModified = tm;
            }
            if (phase === 'incremental' && rets.length <= this.maxChangeEvents) {
              for (const r of rets) {
                const id = qbIdOf(entity, r);
                if (id)
                  await this.publish({
                    type: 'object.changed',
                    objectType: entityName,
                    qbId: id,
                    op: 'sync',
                  });
              }
            }
          }
          count += rs.rets.length;
          if (phase !== 'incremental' || count > 0) await this.progress(unit, 'running', count);
          const more = unit.paging && !!rs.iteratorID && (rs.iteratorRemainingCount ?? 0) > 0;
          if (!more) break;
          page = { iterator: 'Continue', iteratorID: rs.iteratorID! };
        }
        return { ids, count, pages, maxModified };
      } catch (err) {
        if (err instanceof QbStatusError && page.iterator === 'Continue' && restarts < 1) {
          restarts++;
          this.log.warn(
            { unit: unit.key, err: err.message },
            'iterator page failed; restarting load',
          );
          continue;
        }
        throw err;
      }
    }
  }

  private async finishLoad(
    unit: SyncUnit,
    phase: SyncPhase,
    runStart: Date,
    prevCursor: Date | null,
    res: { ids: Map<string, string[]>; count: number; pages: number; maxModified: Date | null },
    complete: boolean,
    firstLoad: boolean,
  ): Promise<LoadResult> {
    let deleted = 0;
    if (complete) {
      for (const e of unit.entities) {
        const gone = await markMissingDeletedBefore(
          this.db,
          e.name,
          res.ids.get(e.name) ?? [],
          runStart,
        );
        deleted += gone.length;
      }
    }
    // Cursor: newest TimeModified seen (QuickBooks' clock); with nothing seen,
    // a full load falls back to its start time and an incremental keeps its cursor.
    let cursor = prevCursor;
    if (res.maxModified && (!cursor || res.maxModified > cursor)) cursor = res.maxModified;
    if (!cursor && complete) cursor = runStart;
    const finishedAt = this.now();
    for (const e of unit.entities) {
      await upsertSyncState(this.db, e.name, {
        lastModifiedCursor: unit.modifiedFilter ? cursor : null,
        ...(complete ? { lastFullSyncAt: finishedAt } : {}),
        // A first full load is as good as a reconcile.
        ...(firstLoad && unit.idField ? { lastReconcileAt: finishedAt } : {}),
        lastRunAt: finishedAt,
        status: 'ok',
        error: null,
        rowCount: await countLive(this.db, e.name),
      });
    }
    await this.progress(unit, 'ok', res.count);
    this.log.info(
      { unit: unit.key, phase, count: res.count, pages: res.pages, deleted },
      'sync unit done',
    );
    return { unit: unit.key, phase, count: res.count, pages: res.pages, deleted, cursor };
  }

  /**
   * Full load of a unit: initial load (priority 10) or the periodic full
   * re-query of units without a modified filter. Rows not returned are
   * soft-deleted afterwards.
   */
  async fullLoad(
    unit: SyncUnit,
    opts: { phase?: 'initial' | 'full'; priority?: number; signal?: AbortSignal } = {},
  ): Promise<LoadResult> {
    const phase = opts.phase ?? 'initial';
    const st = await this.state(unit);
    await this.setStatus(unit, phase === 'initial' ? 'loading' : 'running');
    await this.progress(unit, 'running', 0);
    const runStart = this.now();
    try {
      const res = await this.fetchAll(
        unit,
        phase,
        opts.priority ?? Priority.BulkSync,
        undefined,
        opts.signal,
      );
      return await this.finishLoad(unit, phase, runStart, st.cursor, res, true, !st.loaded);
    } catch (err) {
      await this.fail(unit, err);
      throw err;
    }
  }

  /** Incremental load since cursor minus overlap (priority 5). Falls back to a full load when never loaded. */
  async incremental(
    unit: SyncUnit,
    opts: { priority?: number; signal?: AbortSignal } = {},
  ): Promise<LoadResult> {
    if (!unit.modifiedFilter) return this.fullLoad(unit, { phase: 'full', signal: opts.signal });
    const st = await this.state(unit);
    if (!st.loaded || !st.cursor)
      return this.fullLoad(unit, { phase: 'initial', signal: opts.signal });
    const from = new Date(st.cursor.getTime() - this.overlapMs);
    const runStart = this.now();
    try {
      const res = await this.fetchAll(
        unit,
        'incremental',
        opts.priority ?? Priority.IncrementalSync,
        from,
        opts.signal,
      );
      return await this.finishLoad(unit, 'incremental', runStart, st.cursor, res, false, false);
    } catch (err) {
      await this.fail(unit, err);
      throw err;
    }
  }

  /**
   * ListDeletedQuery / TxnDeletedQuery for the loaded units, since the oldest
   * of their cursors minus the overlap. Deleted objects are soft-deleted.
   */
  async deletions(
    units: readonly SyncUnit[],
    opts: { priority?: number; signal?: AbortSignal } = {},
  ): Promise<DeletionResult[]> {
    const out: DeletionResult[] = [];
    for (const kind of ['list', 'txn'] as const) {
      const eligible: SyncUnit[] = [];
      let oldest: Date | null = null;
      for (const u of units) {
        if (u.category !== kind || u.delTypes.length === 0 || !u.modifiedFilter) continue;
        const st = await this.state(u);
        if (!st.loaded || !st.cursor) continue;
        eligible.push(u);
        if (!oldest || st.cursor < oldest) oldest = st.cursor;
      }
      const types = deleteGroups(eligible)[kind];
      if (types.length === 0) continue;
      const entityByDelType = new Map<string, string>();
      for (const u of eligible)
        for (const e of u.entities) if (e.delType) entityByDelType.set(e.delType, e.name);
      const q = buildDeletedQuery(kind, types, {
        ...this.qopts,
        from: oldest ? new Date(oldest.getTime() - this.overlapMs) : undefined,
        now: this.now(),
      });
      const rs = await this.query(
        q,
        kind === 'list' ? 'ListDeleted' : 'TxnDeleted',
        'deleted',
        opts.priority ?? Priority.IncrementalSync,
        opts.signal,
      );
      const typeField = kind === 'list' ? 'ListDelType' : 'TxnDelType';
      const idField = kind === 'list' ? 'ListID' : 'TxnID';
      const byEntity = new Map<string, string[]>();
      for (const r of rs.rets) {
        const entity = entityByDelType.get(str(r[typeField]) ?? '');
        const id = str(r[idField]);
        if (!entity || !id) continue;
        byEntity.set(entity, [...(byEntity.get(entity) ?? []), id]);
      }
      let deleted = 0;
      for (const [entity, ids] of byEntity) {
        const at = this.now();
        const n = await markDeleted(this.db, entity, ids, at);
        deleted += n;
        if (n > 0) {
          if (ids.length <= this.maxChangeEvents) {
            for (const id of ids)
              await this.publish({
                type: 'object.changed',
                objectType: entity,
                qbId: id,
                op: 'del',
              });
          }
          await upsertSyncState(this.db, entity, { rowCount: await countLive(this.db, entity) });
        }
      }
      out.push({ kind, count: rs.rets.length, deleted });
    }
    return out;
  }

  /**
   * Nightly reconcile: ID-only query (IncludeRetElement id, EditSequence,
   * TimeModified) of every object, compared with the read model. Rows missing
   * locally or with a different EditSequence are fetched in full by id; rows
   * QuickBooks no longer has are soft-deleted.
   */
  async reconcile(
    unit: SyncUnit,
    opts: { priority?: number; signal?: AbortSignal } = {},
  ): Promise<ReconcileResult> {
    if (!unit.idField)
      throw new Error(`${unit.key} has no id field; it is re-queried in full instead`);
    const priority = opts.priority ?? Priority.BulkSync;
    const runStart = this.now();
    await this.setStatus(unit, 'reconciling');
    try {
      // 1. Every id + EditSequence in QuickBooks.
      const remote = new Map<string, Map<string, string | null>>(
        unit.entities.map((e) => [e.name, new Map()]),
      );
      let restarts = 0;
      let page: PageIterator = { iterator: 'Start' };
      for (;;) {
        try {
          const q = buildReconcileQuery(unit, { ...this.qopts, page });
          const rs = await this.query(q, unit.key, 'reconcile', priority, opts.signal);
          for (const [entityName, rets] of this.group(unit, rs)) {
            const m = remote.get(entityName)!;
            for (const r of rets) {
              const id = str(r[unit.idField]);
              if (id) m.set(id, str(r.EditSequence) ?? null);
            }
          }
          if (!(unit.paging && rs.iteratorID && (rs.iteratorRemainingCount ?? 0) > 0)) break;
          page = { iterator: 'Continue', iteratorID: rs.iteratorID };
        } catch (err) {
          if (err instanceof QbStatusError && page.iterator === 'Continue' && restarts < 1) {
            restarts++;
            for (const m of remote.values()) m.clear();
            page = { iterator: 'Start' };
            continue;
          }
          throw err;
        }
      }

      // 2. Compare with the read model.
      let checked = 0;
      let refetched = 0;
      let deleted = 0;
      const stale: string[] = [];
      for (const e of unit.entities) {
        const m = remote.get(e.name)!;
        checked += m.size;
        const local = await localIndex(this.db, e.name);
        for (const [id, seq] of m) {
          const l = local.get(id);
          if (!l || l.deleted || (seq !== null && l.editSequence !== seq)) stale.push(id);
        }
        const gone = await markMissingDeletedBefore(this.db, e.name, [...m.keys()], runStart);
        deleted += gone.length;
      }

      // 3. Fetch what is missing or out of date.
      for (let i = 0; i < stale.length; i += ID_BATCH_SIZE) {
        const ids = stale.slice(i, i + ID_BATCH_SIZE);
        const q = buildFetchByIdsQuery(unit, ids, this.qopts);
        const rs = await this.query(q, unit.key, 'fetch', priority, opts.signal);
        for (const [entityName, rets] of this.group(unit, rs)) {
          const entity = unit.entities.find((x) => x.name === entityName)!;
          refetched += await upsertObjects(this.db, entity, rets);
        }
      }

      const at = this.now();
      for (const e of unit.entities) {
        await upsertSyncState(this.db, e.name, {
          lastReconcileAt: at,
          lastRunAt: at,
          status: 'ok',
          error: null,
          rowCount: await countLive(this.db, e.name),
        });
      }
      await this.progress(unit, 'reconciled', checked);
      this.log.info({ unit: unit.key, checked, refetched, deleted }, 'reconcile done');
      return { unit: unit.key, checked, refetched, deleted };
    } catch (err) {
      await this.fail(unit, err);
      throw err;
    }
  }

  private async fail(unit: SyncUnit, err: unknown): Promise<void> {
    if (err instanceof SyncAbortedError) {
      await this.setStatus(unit, 'idle').catch(() => undefined);
      return;
    }
    const message = (err as Error).message ?? String(err);
    await this.setStatus(unit, 'error', message).catch(() => undefined);
    await this.progress(unit, 'error', 0);
    this.log.error({ unit: unit.key, err: message }, 'sync unit failed');
  }

  /** Forget the cursors so the next pass does a full (initial) load. */
  async reset(unit: SyncUnit): Promise<void> {
    for (const e of unit.entities) {
      await upsertSyncState(this.db, e.name, {
        lastModifiedCursor: null,
        lastFullSyncAt: null,
        status: 'idle',
        error: null,
      });
    }
  }
}
