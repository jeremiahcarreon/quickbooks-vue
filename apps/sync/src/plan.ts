import { loadCatalog, type Catalog, type EntityDef, type ObjectDef } from '@qbv/qbxml';

/** How a query request filters by modification time, read from its schema. */
export type ModifiedFilterKind = 'FromModifiedDate' | 'ModifiedDateRangeFilter';

/**
 * One query request that feeds one or more entities. Most entities have their
 * own query (CustomerQueryRq); a few only come back from a union query
 * (PayrollItemTax via PayrollItemQueryRq), and those are grouped into one unit
 * per union query.
 */
export interface SyncUnit {
  /** Entity name, or `<UnionQueryRq>` for a union group. */
  key: string;
  /** Query request name. */
  rq: string;
  /** Entities whose Rets this unit stores. */
  entities: EntityDef[];
  /** Ret element name -> entity (only target entities). */
  retToEntity: Record<string, string>;
  category: 'list' | 'txn' | 'other';
  idField: 'ListID' | 'TxnID' | null;
  /** Null when the query has no modified-date filter (fully re-queried on the slow interval). */
  modifiedFilter: ModifiedFilterKind | null;
  /** True when the query takes iterator + MaxReturned, so results are fetched in pages. */
  paging: boolean;
  /** ListDelType/TxnDelType values of the unit's entities (deletion detection). */
  delTypes: string[];
  /** Ret elements that carry EditSequence / TimeModified (used for reconcile). */
  hasEditSequence: boolean;
  hasTimeModified: boolean;
  /**
   * True when the query can filter by id and trim Rets with IncludeRetElement,
   * so it can be reconciled (ID-only listing + fetch by id). Units without a
   * modified filter are re-queried in full instead.
   */
  reconcilable: boolean;
}

export interface SkippedEntity {
  entity: string;
  reason: string;
}

export interface SyncPlan {
  units: SyncUnit[];
  skipped: SkippedEntity[];
  /** Entity name -> unit key. */
  unitOf: Record<string, string>;
}

export function detectModifiedFilter(obj: ObjectDef): ModifiedFilterKind | null {
  if (obj.fields.some((f) => f.name === 'FromModifiedDate')) return 'FromModifiedDate';
  if (obj.fields.some((f) => f.name === 'ModifiedDateRangeFilter'))
    return 'ModifiedDateRangeFilter';
  return null;
}

/** Required top-level elements of a query (they need caller input, so it cannot be synced generically). */
export function requiredQueryFields(obj: ObjectDef): string[] {
  return obj.fields.filter((f) => f.minOccurs > 0).map((f) => f.name);
}

function retHas(cat: Catalog, retElements: string[], field: string): boolean {
  return (
    retElements.length > 0 &&
    retElements.every((r) => cat.objects[r]?.fields.some((f) => f.name === field) ?? false)
  );
}

function makeUnit(
  cat: Catalog,
  key: string,
  rq: string,
  entities: EntityDef[],
): SyncUnit | SkippedEntity {
  const req = cat.requests[rq];
  const obj = cat.objects[rq];
  if (!req || !obj) return { entity: key, reason: `query ${rq} is not in the catalog` };
  const required = requiredQueryFields(obj);
  if (required.length > 0) {
    return { entity: key, reason: `${rq} requires ${required.join(', ')}` };
  }
  const first = entities[0]!;
  const retElements = entities.map((e) => e.retElement);
  const hasMaxReturned = obj.fields.some((f) => f.name === 'MaxReturned');
  return {
    key,
    rq,
    entities,
    retToEntity: Object.fromEntries(entities.map((e) => [e.retElement, e.name])),
    category: first.category,
    idField: first.idField,
    modifiedFilter: detectModifiedFilter(obj),
    paging: req.supportsIterator && hasMaxReturned,
    delTypes: entities.map((e) => e.delType).filter((d): d is string => !!d),
    hasEditSequence: retHas(cat, retElements, 'EditSequence'),
    hasTimeModified: retHas(cat, retElements, 'TimeModified'),
    reconcilable:
      !!first.idField &&
      obj.fields.some((f) => f.name === first.idField) &&
      obj.fields.some((f) => f.name === 'IncludeRetElement'),
  };
}

/**
 * Work out what to sync from the catalog: every entity with a query op gets a
 * unit; entities reachable only through a union query share a unit per union
 * query. Queries with required elements (they need a subscriber id, an
 * assembly, ...) are skipped with a reason. `include` limits the plan to the
 * named entities (SYNC_ENTITIES).
 */
export function planSync(opts: { include?: readonly string[]; catalog?: Catalog } = {}): SyncPlan {
  const cat = opts.catalog ?? loadCatalog();
  const include = opts.include && opts.include.length > 0 ? new Set(opts.include) : null;
  if (include) {
    const unknown = [...include].filter((n) => !cat.entities[n]);
    if (unknown.length > 0) {
      throw new Error(`SYNC_ENTITIES names unknown entities: ${unknown.join(', ')}`);
    }
  }
  const units: SyncUnit[] = [];
  const skipped: SkippedEntity[] = [];
  const unions = new Map<string, EntityDef[]>();

  const entities = Object.values(cat.entities).sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entities) {
    if (include && !include.has(e.name)) continue;
    if (e.ops.query) {
      const u = makeUnit(cat, e.name, e.ops.query, [e]);
      if ('rq' in u) units.push(u);
      else skipped.push(u);
    } else if (e.unionQuery) {
      const list = unions.get(e.unionQuery) ?? [];
      list.push(e);
      unions.set(e.unionQuery, list);
    } else {
      skipped.push({ entity: e.name, reason: 'no query request' });
    }
  }
  for (const [rq, members] of unions) {
    const u = makeUnit(cat, rq, rq, members);
    if ('rq' in u) units.push(u);
    else for (const m of members) skipped.push({ entity: m.name, reason: u.reason });
  }

  const unitOf: Record<string, string> = {};
  for (const u of units) for (const e of u.entities) unitOf[e.name] = u.key;
  return { units, skipped, unitOf };
}

/** Units that track changes with a modified-date filter (initial + incremental). */
export const isIncremental = (u: SyncUnit): boolean => u.modifiedFilter !== null;
