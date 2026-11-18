// In-memory company file: every object as its qbXML Ret shape, plus the
// deleted-object log that ListDeletedQuery / TxnDeletedQuery read.
import { type Json } from './util.js';

export interface Rec {
  entity: string;
  /** ListID / TxnID, or a synthetic key for entities without an id. */
  key: string;
  /** The object exactly as a *Ret element (element names as keys, leaf strings). */
  ret: Json;
  /** Insertion order (QuickBooks returns transactions in entry order on ties). */
  seq: number;
  /** Mock-private state (opening balances, void flag, ...). Never sent. */
  meta: Json;
}

export interface DeletedRec {
  kind: 'list' | 'txn';
  delType: string;
  id: string;
  timeCreated?: string;
  timeDeleted: string;
  deletedAtMs: number;
  fullName?: string;
  refNumber?: string;
}

export interface Counters {
  list: number;
  txn: number;
  other: number;
  seq: number;
  txnNumber: number;
}

export interface StoreSnapshot {
  format: 'qbv-relay-mock';
  version: 1;
  counters: Counters;
  records: Rec[];
  deleted: DeletedRec[];
}

interface Journal {
  counters: Counters;
  deletedLength: number;
  deletedCopy?: DeletedRec[];
  touched: Map<string, Rec | undefined>;
}

const k = (entity: string, key: string) => `${entity}\u0000${key}`;

export class Store {
  counters: Counters = { list: 0, txn: 0, other: 0, seq: 0, txnNumber: 0 };
  deleted: DeletedRec[] = [];
  /** Bumped on every mutation; derived caches key off it. */
  revision = 0;
  private recs = new Map<string, Rec>();
  private byEntity = new Map<string, Map<string, Rec>>();
  private journal: Journal | undefined;

  get size(): number {
    return this.recs.size;
  }

  get(entity: string, key: string): Rec | undefined {
    return this.byEntity.get(entity)?.get(key);
  }

  all(entity: string): Rec[] {
    return [...(this.byEntity.get(entity)?.values() ?? [])];
  }

  entities(): string[] {
    return [...this.byEntity.keys()].filter((e) => (this.byEntity.get(e)?.size ?? 0) > 0);
  }

  *each(): IterableIterator<Rec> {
    yield* this.recs.values();
  }

  /** Insert or replace a record. */
  put(rec: Rec): void {
    this.remember(rec.entity, rec.key);
    this.recs.set(k(rec.entity, rec.key), rec);
    let m = this.byEntity.get(rec.entity);
    if (!m) this.byEntity.set(rec.entity, (m = new Map()));
    m.set(rec.key, rec);
    this.revision++;
  }

  remove(entity: string, key: string): Rec | undefined {
    const rec = this.get(entity, key);
    if (!rec) return undefined;
    this.remember(entity, key);
    this.recs.delete(k(entity, key));
    this.byEntity.get(entity)?.delete(key);
    this.revision++;
    return rec;
  }

  addDeleted(d: DeletedRec): void {
    if (this.journal && !this.journal.deletedCopy) this.journal.deletedCopy = [...this.deleted];
    this.deleted.push(d);
    this.revision++;
  }

  nextSeq(): number {
    return ++this.counters.seq;
  }

  // -------------------------------------------------------------------------
  // Transactions: a request either applies completely or not at all.

  begin(): void {
    this.journal = {
      counters: { ...this.counters },
      deletedLength: this.deleted.length,
      touched: new Map(),
    };
  }

  commit(): void {
    this.journal = undefined;
  }

  rollback(): void {
    const j = this.journal;
    if (!j) return;
    this.journal = undefined;
    for (const [id, before] of j.touched) {
      const [entity, key] = id.split('\u0000') as [string, string];
      this.recs.delete(id);
      this.byEntity.get(entity)?.delete(key);
      if (before) {
        this.recs.set(id, before);
        let m = this.byEntity.get(entity);
        if (!m) this.byEntity.set(entity, (m = new Map()));
        m.set(key, before);
      }
    }
    this.counters = j.counters;
    if (j.deletedCopy) this.deleted = j.deletedCopy;
    else this.deleted.length = j.deletedLength;
    this.revision++;
  }

  private remember(entity: string, key: string): void {
    const j = this.journal;
    if (!j) return;
    const id = k(entity, key);
    if (j.touched.has(id)) return;
    const before = this.recs.get(id);
    j.touched.set(id, before ? structuredClone(before) : undefined);
  }

  // -------------------------------------------------------------------------

  snapshot(): StoreSnapshot {
    return structuredClone({
      format: 'qbv-relay-mock' as const,
      version: 1 as const,
      counters: this.counters,
      records: [...this.recs.values()],
      deleted: this.deleted,
    });
  }

  load(s: StoreSnapshot): void {
    if (s.format !== 'qbv-relay-mock' || s.version !== 1)
      throw new Error('Not a relay-mock data file (format/version mismatch)');
    this.clear();
    this.counters = { ...s.counters };
    this.deleted = [...s.deleted];
    for (const r of s.records) this.put(structuredClone(r));
  }

  clear(): void {
    this.recs.clear();
    this.byEntity.clear();
    this.deleted = [];
    this.counters = { list: 0, txn: 0, other: 0, seq: 0, txnNumber: 0 };
    this.journal = undefined;
    this.revision++;
  }
}
