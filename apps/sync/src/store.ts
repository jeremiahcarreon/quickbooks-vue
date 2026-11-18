import { sql, type Db, type ExtractOverrides } from '@qbv/db';

type Ret = Record<string, unknown>;

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && '#text' in v) {
    const t = (v as { '#text': unknown })['#text'];
    return typeof t === 'string' ? t : undefined;
  }
  return undefined;
}

const refId = (v: unknown): string | undefined =>
  v && typeof v === 'object' ? (str((v as Ret).ListID) ?? str((v as Ret).FullName)) : undefined;

/**
 * Row keys for entities without a ListID/TxnID. These are lists of settings
 * or singletons (Company, Preferences, Host); each Ret gets a stable key so a
 * full re-query can replace them.
 */
const KEYS: Record<string, (ret: Ret) => string | undefined> = {
  AccountTaxLineInfo: (r) => str(r.TaxLineID),
  DataExtDef: (r) => {
    const name = str(r.DataExtName);
    return name ? `${str(r.OwnerID) ?? '0'}:${name}` : undefined;
  },
  Form1099CategoryAccountMapping: (r) => str(r.FormType) ?? 'singleton',
  SalesTaxPayable: (r) => refId(r.PayeeEntityRef),
};

/** qb_id extraction overrides for an entity, or undefined to use @qbv/db's default. */
export function keyOverrides(entity: {
  name: string;
  idField: string | null;
}): ExtractOverrides | undefined {
  if (entity.idField) return undefined;
  const key = KEYS[entity.name];
  return {
    qbId: (ret) => key?.(ret) ?? str(ret.Name) ?? str(ret.FullName) ?? 'singleton',
  };
}

export function qbIdOf(entity: { name: string; idField: string | null }, ret: Ret): string | null {
  if (entity.idField) return str(ret[entity.idField]) ?? null;
  return keyOverrides(entity)!.qbId!(ret) ?? null;
}

/**
 * Soft-delete live rows of `type` that are not in `presentIds` and were last
 * written before `before`. Rows written during the run (a write-through by
 * the worker while a long load was in progress) are kept.
 */
export async function markMissingDeletedBefore(
  db: Db,
  type: string,
  presentIds: readonly string[],
  before: Date,
  at: Date = new Date(),
): Promise<string[]> {
  const rows = await db
    .updateTable('qb_object')
    .set({ deleted_at: at })
    .where('type', '=', type)
    .where('deleted_at', 'is', null)
    .where('synced_at', '<', before)
    .where(sql<boolean>`qb_id <> all(${[...presentIds]}::text[])`)
    .returning('qb_id')
    .execute();
  return rows.map((r) => r.qb_id);
}

export interface LocalIndexEntry {
  editSequence: string | null;
  deleted: boolean;
}

/** qb_id -> (EditSequence, deleted) for every row of a type, for reconcile. */
export async function localIndex(db: Db, type: string): Promise<Map<string, LocalIndexEntry>> {
  const rows = await db
    .selectFrom('qb_object')
    .select(['qb_id', 'edit_sequence', 'deleted_at'])
    .where('type', '=', type)
    .execute();
  return new Map(
    rows.map((r) => [r.qb_id, { editSequence: r.edit_sequence, deleted: r.deleted_at !== null }]),
  );
}

export async function countLive(db: Db, type: string): Promise<number> {
  const r = await db
    .selectFrom('qb_object')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('type', '=', type)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  return Number(r?.n ?? 0);
}
