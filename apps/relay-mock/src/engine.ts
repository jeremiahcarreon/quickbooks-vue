// The fake company file: processes qbXML request documents against an
// in-memory store and returns QuickBooks-shaped responses. Every response
// document is validated against the XSD before it is returned.
import {
  buildResponse,
  QbxmlValidationError,
  validate,
  type EntityDef,
  type ObjectDef,
  type RequestDef,
  type ResponsePart,
} from '@qbv/qbxml';
import { buildDerived } from './derived.js';
import { cascadeHierarchy, prepareList } from './lists.js';
import { fillRequired, mapToRet, type RequiredValue } from './mapping.js';
import {
  cat,
  entity as entityDef,
  entityByDelType,
  entityByVoidType,
  field,
  fullNameOf,
  lineFields,
  obj,
  QbStatus,
  status,
} from './qb.js';
import { handleQuery, handleSpecialQuery, type IteratorState } from './query.js';
import { referencedIds, refTo, resolveRefs } from './refs.js';
import { handleReport, REPORT_REQUESTS } from './reports.js';
import { type Rec, Store } from './store.js';
import {
  AP_PAYMENTS,
  AR_PAYMENTS,
  applyDepositLines,
  applyPayment,
  applyTxnDefaults,
  checkJournalBalance,
  computeTotals,
  voidAmounts,
} from './txns.js';
import {
  amt,
  arr,
  isObj,
  localYmd,
  lower,
  num,
  qbDateTime,
  systemClock,
  text,
  type Clock,
  type Json,
} from './util.js';
import { parseRequestDoc, type ParsedRequestDoc, type ParsedRq } from './xml.js';

export interface EngineOptions {
  clock?: Clock;
  /** Name returned by CompanyQuery. */
  companyName?: string;
  /** Called with a description of any internal error (a bug in the mock). */
  onInternalError?: (err: unknown, rq: string) => void;
}

/** The outcome of one request: a structured response part or a pre-rendered fragment. */
export type Outcome =
  | { kind: 'part'; part: ResponsePart }
  | { kind: 'raw'; rs: string; xml: string; requestID?: string };

export interface ProcessResult {
  xml: string;
  outcomes: { rq: string; statusCode: number; statusMessage: string }[];
}

const SPECIAL_ACCOUNT: Record<string, { name: string; type: string }> = {
  AccountsPayable: { name: 'Accounts Payable', type: 'AccountsPayable' },
  AccountsReceivable: { name: 'Accounts Receivable', type: 'AccountsReceivable' },
  CostOfGoodsSold: { name: 'Cost of Goods Sold', type: 'CostOfGoodsSold' },
  InventoryAssets: { name: 'Inventory Asset', type: 'OtherCurrentAsset' },
  OpeningBalanceEquity: { name: 'Opening Balance Equity', type: 'Equity' },
  RetainedEarnings: { name: 'Retained Earnings', type: 'Equity' },
  SalesTaxPayable: { name: 'Sales Tax Payable', type: 'OtherCurrentLiability' },
  UndepositedFunds: { name: 'Undeposited Funds', type: 'OtherCurrentAsset' },
  UncategorizedIncome: { name: 'Uncategorized Income', type: 'Income' },
  UncategorizedExpenses: { name: 'Uncategorized Expenses', type: 'Expense' },
  PayrollExpenses: { name: 'Payroll Expenses', type: 'Expense' },
  PayrollLiabilities: { name: 'Payroll Liabilities', type: 'OtherCurrentLiability' },
  PettyCash: { name: 'Petty Cash', type: 'Bank' },
  Estimates: { name: 'Estimates', type: 'NonPosting' },
  PurchaseOrders: { name: 'Purchase Orders', type: 'NonPosting' },
  SalesOrders: { name: 'Sales Orders', type: 'NonPosting' },
};

type SpecialKind =
  | 'AR'
  | 'AP'
  | 'UndepositedFunds'
  | 'SalesTaxPayable'
  | 'OpeningBalanceEquity'
  | 'RetainedEarnings'
  | 'InventoryAsset'
  | 'COGS';

export class Engine {
  readonly store = new Store();
  readonly iterators = new Map<string, IteratorState>();
  clock: Clock;
  companyName: string;
  private onInternalError?: EngineOptions['onInternalError'];
  private derivedCache?: { revision: number; data: ReturnType<typeof buildDerived> };

  constructor(opts: EngineOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.companyName = opts.companyName ?? 'Sample HVAC Company';
    this.onInternalError = opts.onInternalError;
  }

  // -------------------------------------------------------------------------
  // Time and identifiers

  today(): string {
    return localYmd(this.clock.now());
  }

  stamp(): string {
    return qbDateTime(this.clock.now());
  }

  private unix(): number {
    return Math.floor(this.clock.now().getTime() / 1000);
  }

  /** ListID like 80000001-1700000000. */
  newListId(): string {
    const n = 0x80000000 + ++this.store.counters.list;
    return `${n.toString(16).toUpperCase()}-${this.unix()}`;
  }

  /** TxnID / TxnLineID like 1A-1700000000. */
  newTxnId(): string {
    return `${(++this.store.counters.txn).toString(16).toUpperCase()}-${this.unix()}`;
  }

  /** EditSequence: the modification time in seconds, strictly increasing per object. */
  nextEditSequence(prev?: unknown): string {
    const p = Number(text(prev) ?? 0);
    return String(Math.max(this.unix(), Number.isFinite(p) ? p + 1 : 0));
  }

  /** Set TimeModified / EditSequence (and TimeCreated when new) on a Ret. */
  touchStamp(ret: Json, prev?: Json): void {
    const now = this.stamp();
    if (!prev?.TimeCreated) ret.TimeCreated = now;
    ret.TimeModified = now;
    if ('EditSequence' in ret || prev === undefined)
      ret.EditSequence = this.nextEditSequence(prev?.EditSequence);
  }

  // -------------------------------------------------------------------------
  // Lookups

  entityOf(name: string): EntityDef {
    return entityDef(name);
  }

  retDefOf(name: string): ObjectDef {
    return obj(entityDef(name).retElement);
  }

  findById(entities: string[], id: string): Rec | undefined {
    for (const e of entities) {
      const r = this.store.get(e, id);
      if (r) return r;
    }
    return undefined;
  }

  findByName(entities: string[], name: string): Rec | undefined {
    const n = lower(name);
    for (const e of entities) {
      for (const r of this.store.all(e)) if (lower(fullNameOf(r.ret)) === n) return r;
    }
    return undefined;
  }

  txnEntities(): string[] {
    return Object.values(cat().entities)
      .filter((e) => e.category === 'txn')
      .map((e) => e.name);
  }

  findTxn(id: string, entities?: string[]): Rec | undefined {
    return this.findById(entities ?? this.txnEntities(), id);
  }

  /** Accounts QuickBooks treats specially (A/R, A/P, Undeposited Funds, ...). */
  special(kind: SpecialKind): Rec | undefined {
    const accounts = this.store.all('Account').sort((a, b) => a.seq - b.seq);
    const by = (pred: (r: Rec) => boolean) => accounts.find(pred);
    const type = (t: string) => (r: Rec) => r.ret.AccountType === t;
    const named = (n: string) => (r: Rec) => lower(text(r.ret.Name)) === lower(n);
    const sp = (t: string) => (r: Rec) => r.ret.SpecialAccountType === t;
    switch (kind) {
      case 'AR':
        return by(type('AccountsReceivable'));
      case 'AP':
        return by(type('AccountsPayable'));
      case 'UndepositedFunds':
        return by(sp('UndepositedFunds')) ?? by(named('Undeposited Funds')) ?? by(type('Bank'));
      case 'SalesTaxPayable':
        return by(sp('SalesTaxPayable')) ?? by(named('Sales Tax Payable'));
      case 'OpeningBalanceEquity':
        return by(sp('OpeningBalanceEquity')) ?? by(named('Opening Balance Equity'));
      case 'RetainedEarnings':
        return by(sp('RetainedEarnings')) ?? by(named('Retained Earnings'));
      case 'InventoryAsset':
        return by(sp('InventoryAssets')) ?? by(named('Inventory Asset'));
      case 'COGS':
        return by(sp('CostOfGoodsSold')) ?? by(type('CostOfGoodsSold'));
    }
  }

  /** True when `id` is `parentId` or one of its jobs / sub-customers. */
  isSameOrChild(parentId: string, id: string): boolean {
    let cur: string | undefined = id;
    for (let i = 0; cur && i < 50; i++) {
      if (cur === parentId) return true;
      const r = this.findById(['Customer', 'Vendor'], cur);
      cur = r && isObj(r.ret.ParentRef) ? text(r.ret.ParentRef.ListID) : undefined;
    }
    return false;
  }

  /** Payments applied to an invoice / bill: total and LinkedTxn entries. */
  appliedTo(txnId: string): { total: number; links: Json[] } {
    let total = 0;
    const links: Json[] = [];
    for (const pe of [...AR_PAYMENTS, ...AP_PAYMENTS]) {
      for (const p of this.store.all(pe)) {
        for (const a of arr<Json>(p.ret.AppliedToTxnRet)) {
          if (a.TxnID !== txnId) continue;
          const amount = (num(a.Amount) ?? 0) + (num(a.DiscountAmount) ?? 0);
          total += amount;
          const link: Json = {
            TxnID: p.key,
            TxnType: p.entity,
            TxnDate: p.ret.TxnDate,
            RefNumber: p.ret.RefNumber,
            LinkType: 'AMTTYPE',
            Amount: amt(-amount),
          };
          if (link.RefNumber === undefined) delete link.RefNumber;
          links.push(link);
        }
      }
    }
    return { total, links };
  }

  /** Clone a record, apply `fn` to the copy and store it. */
  update(rec: Rec, fn: (ret: Json, meta: Json) => void): Rec {
    const next: Rec = structuredClone(rec);
    fn(next.ret, next.meta);
    this.store.put(next);
    return next;
  }

  /** Recompute a transaction's balances after a payment changed (bumps TimeModified). */
  recalcTxn(key: string): void {
    const rec = this.findTxn(key);
    if (!rec) return;
    this.update(rec, (ret, meta) => {
      computeTotals(this, entityDef(rec.entity), { key, ret, meta });
      this.touchStamp(ret, rec.ret);
    });
  }

  /** Balances and other read-time values, cached per store revision. */
  derived(): ReturnType<typeof buildDerived> {
    if (this.derivedCache?.revision !== this.store.revision)
      this.derivedCache = { revision: this.store.revision, data: buildDerived(this) };
    return this.derivedCache.data;
  }

  // -------------------------------------------------------------------------
  // Static objects every company file has.

  ensureSingletons(): void {
    const put = (entity: string, ret: Json) => {
      if (this.store.all(entity).length) return;
      this.store.put({ entity, key: `${entity}-1`, ret, seq: this.store.nextSeq(), meta: {} });
    };
    put('Host', {
      ProductName: 'QuickBooks Enterprise Solutions: Contractor 24.0 (relay mock)',
      MajorVersion: '34',
      MinorVersion: '0',
      Country: 'US',
      SupportedQBXMLVersion: [
        '1.0',
        '1.1',
        '2.0',
        '2.1',
        '3.0',
        '4.0',
        '4.1',
        '5.0',
        '6.0',
        '7.0',
        '8.0',
        '9.0',
        '10.0',
        '11.0',
        '12.0',
        '13.0',
        '14.0',
        '15.0',
        '16.0',
      ],
      IsAutomaticLogin: 'false',
      QBFileMode: 'MultiUser',
    });
    put('Company', {
      IsSampleCompany: 'false',
      CompanyName: this.companyName.slice(0, 59),
      LegalCompanyName: this.companyName.slice(0, 59),
      Address: {
        Addr1: '1200 Industrial Way',
        City: 'Springfield',
        State: 'CO',
        PostalCode: '80000',
        Country: 'US',
      },
      Phone: '555-0100',
      Email: 'office@example.com',
      FirstMonthFiscalYear: 'January',
      FirstMonthIncomeTaxYear: 'January',
      TaxForm: 'Form1120S',
    });
    put(
      'Preferences',
      fillRequired({}, obj('PreferencesRet'), () => undefined),
    );
  }

  // -------------------------------------------------------------------------
  // Request processing

  /**
   * Validate a request document against the XSD, process it and return the
   * (validated) response document. Throws QbxmlValidationError for invalid input.
   */
  processXml(xml: string): string {
    const r = validate(xml);
    if (!r.valid) throw new QbxmlValidationError(r.errors, xml);
    return this.processDocument(parseRequestDoc(xml)).xml;
  }

  /** Process a parsed (already XSD-validated) request document. */
  processDocument(doc: ParsedRequestDoc): ProcessResult {
    const outcomes: Outcome[] = [];
    const before = doc.onError === 'rollbackOnError' ? this.store.snapshot() : undefined;
    for (const rq of doc.requests) {
      const out = this.handle(rq);
      outcomes.push(out);
      const code = out.kind === 'part' ? (out.part.statusCode ?? 0) : 0;
      const severity = out.kind === 'part' ? out.part.statusSeverity : 'Info';
      if (code >= 1000 || severity === 'Error') {
        if (doc.onError === 'continueOnError') continue;
        if (before) {
          this.store.load(before);
          this.iterators.clear();
        }
        break;
      }
    }
    return {
      xml: this.render(outcomes),
      outcomes: outcomes.map((o) =>
        o.kind === 'part'
          ? {
              rq: o.part.rs,
              statusCode: o.part.statusCode ?? 0,
              statusMessage: o.part.statusMessage ?? 'Status OK',
            }
          : { rq: o.rs, statusCode: 0, statusMessage: 'Status OK' },
      ),
    };
  }

  /** Handle one request element atomically. */
  handle(rq: ParsedRq): Outcome {
    const def = cat().requests[rq.name];
    const requestID = rq.attrs.requestID;
    const rs = def?.response ?? rq.name.replace(/Rq$/, 'Rs');
    this.store.begin();
    try {
      if (!def) throw status.notSupported();
      const out = this.dispatch(rq, def);
      this.store.commit();
      if (out.kind === 'part') out.part.requestID = requestID;
      else out.requestID = requestID;
      return out;
    } catch (err) {
      this.store.rollback();
      if (err instanceof QbStatus) {
        return {
          kind: 'part',
          part: {
            rs,
            requestID,
            statusCode: err.code,
            statusSeverity: err.severity,
            statusMessage: err.message,
          },
        };
      }
      this.onInternalError?.(err, rq.name);
      const msg = err instanceof Error ? err.message : String(err);
      const s = status.internal(msg.split('\n')[0]!.slice(0, 300));
      return {
        kind: 'part',
        part: {
          rs,
          requestID,
          statusCode: s.code,
          statusSeverity: s.severity,
          statusMessage: s.message,
        },
      };
    }
  }

  private dispatch(rq: ParsedRq, def: RequestDef): Outcome {
    if (REPORT_REQUESTS.has(def.name)) return handleReport(this, rq, def);
    switch (def.name) {
      case 'ListDelRq':
        return this.listDel(rq, def);
      case 'TxnDelRq':
        return this.txnDel(rq, def);
      case 'TxnVoidRq':
        return this.txnVoid(rq, def);
      case 'SpecialAccountAddRq':
        return this.specialAccountAdd(rq, def);
    }
    const special = handleSpecialQuery(this, rq, def);
    if (special) return special;
    if (def.op === 'Query' && def.entity)
      return handleQuery(this, rq, def, [entityDef(def.entity)]);
    if (def.op === 'Add' && def.entity && def.bodyElement) return this.add(rq, def);
    if (def.op === 'Mod' && def.entity && def.bodyElement) return this.mod(rq, def);
    throw status.notSupported();
  }

  /** Value for a required Ret element the request did not supply. */
  private required: RequiredValue = (f, owner) => {
    if (f.name === 'TxnLineID' || f.name === 'TxnID') return this.newTxnId();
    if (f.name === 'ListID') return this.newListId();
    if (f.name === 'TimeCreated' || f.name === 'TimeModified') return this.stamp();
    if (f.name === 'IsPrintItemsInGroup') return 'false';
    if (f.name === 'TotalAmount') return '0.00';
    if (f.name === 'TxnType' && f.enum) return f.enum[0];
    void owner;
    return undefined;
  };

  /** Respond with a stored record, applying read-time values and IncludeRetElement. */
  retPart(def: RequestDef, rec: Rec, body: Json): Outcome {
    const view = this.view(rec, arr<string>(body.IncludeRetElement));
    const retName = this.entityOf(rec.entity).retElement;
    return { kind: 'part', part: { rs: def.response, body: { [retName]: view } } };
  }

  /** A record as returned to callers (balances filled, refs renamed, elements filtered). */
  view(rec: Rec, include: string[] = [], opts: { lines?: boolean; linked?: boolean } = {}): Json {
    const ret = this.derived().view(rec);
    if (opts.lines === false) {
      for (const lf of lineFields(this.retDefOf(rec.entity))) delete ret[lf.name];
    }
    if (opts.linked === false) delete ret.LinkedTxn;
    if (include.length) {
      const keep = new Set(include);
      for (const k of Object.keys(ret)) if (!keep.has(k)) delete ret[k];
    }
    return ret;
  }

  private add(rq: ParsedRq, def: RequestDef): Outcome {
    const e = entityDef(def.entity!);
    const retDef = obj(def.retElement ?? e.retElement);
    const input = this.bodyOf(rq, def);
    if (e.name === 'Deposit') renamePaymentTxnId(input);
    const ret = mapToRet(input, obj(def.bodyElement!), retDef);
    resolveRefs(this, ret, retDef, e.name);
    const meta: Json = {};
    let key: string;
    if (e.idField === 'ListID') key = ret.ListID = this.newListId();
    else if (e.idField === 'TxnID') key = ret.TxnID = this.newTxnId();
    else key = `${e.name}-${++this.store.counters.other}`;
    if (field(retDef, 'TimeCreated')) ret.TimeCreated = this.stamp();
    if (field(retDef, 'TimeModified')) ret.TimeModified = this.stamp();
    if (field(retDef, 'EditSequence')) ret.EditSequence = this.nextEditSequence();
    let touched: string[] = [];
    if (e.category === 'list') prepareList(this, e, ret, retDef, input, meta);
    if (e.category === 'txn') touched = this.prepareTxn(e, key, ret, retDef, input, meta);
    fillRequired(ret, retDef, this.required);
    const rec: Rec = { entity: e.name, key, ret, seq: this.store.nextSeq(), meta };
    this.store.put(rec);
    for (const t of touched) this.recalcTxn(t);
    return this.retPart(def, this.store.get(e.name, key)!, rq.body);
  }

  private prepareTxn(
    e: EntityDef,
    key: string,
    ret: Json,
    def: ObjectDef,
    input: Json,
    meta: Json,
    previous?: Json,
  ): string[] {
    applyTxnDefaults(this, e, ret, def);
    if (e.name === 'Deposit') applyDepositLines(this, ret);
    let touched: string[] = [];
    if ([...AR_PAYMENTS, ...AP_PAYMENTS].includes(e.name))
      touched = applyPayment(this, e, ret, input, previous);
    if (meta.voided) voidAmounts(def, ret);
    computeTotals(this, e, { key, ret, meta });
    if (e.name === 'JournalEntry') checkJournalBalance(ret);
    return touched;
  }

  private bodyOf(rq: ParsedRq, def: RequestDef): Json {
    const b = rq.body[def.bodyElement!];
    return isObj(b) ? structuredClone(b) : {};
  }

  private mod(rq: ParsedRq, def: RequestDef): Outcome {
    const e = entityDef(def.entity!);
    const retDef = obj(def.retElement ?? e.retElement);
    const input = this.bodyOf(rq, def);
    if (e.name === 'Deposit') renamePaymentTxnId(input);
    let rec: Rec | undefined;
    if (e.idField) {
      const id = text(input[e.idField]) ?? '';
      rec = this.store.get(e.name, id);
      if (!rec) throw status.notFound(id);
      const es = text(input.EditSequence);
      if (es !== undefined && es !== text(rec.ret.EditSequence)) throw status.staleEditSequence(es);
    } else {
      rec = this.store.all(e.name)[0];
      if (!rec) {
        rec = {
          entity: e.name,
          key: `${e.name}-${++this.store.counters.other}`,
          ret: {},
          seq: this.store.nextSeq(),
          meta: {},
        };
      }
    }
    const prev = rec.ret;
    const patch = mapToRet(input, obj(def.bodyElement!), retDef);
    delete patch.EditSequence;
    if (e.idField) delete patch[e.idField];
    if (e.name === 'JournalEntry' && input.JournalLineMod !== undefined)
      splitJournalLines(input, prev, patch);
    resolveRefs(this, patch, retDef, e.name);
    const ret = structuredClone(prev);
    const meta = structuredClone(rec.meta);
    // Journal lines may move between the debit and credit side.
    const journal = [...arr<Json>(prev.JournalDebitLine), ...arr<Json>(prev.JournalCreditLine)];
    for (const [k, v] of Object.entries(patch)) {
      const f = field(retDef, k);
      if (f && f.kind === 'complex' && lineFields(retDef).some((lf) => lf.name === k)) {
        ret[k] = this.mergeLines(
          e.name === 'JournalEntry' ? journal : arr<Json>(prev[k]),
          arr<Json>(v),
        );
      } else {
        ret[k] = v;
      }
    }
    // A Mod that touches one line kind of a choice drops the other kind.
    const touchedLines = lineFields(retDef).filter((lf) => lf.name in patch);
    for (const lf of lineFields(retDef)) {
      if (lf.name in patch || !lf.choiceGroup) continue;
      if (touchedLines.some((t) => t.choiceGroup === lf.choiceGroup)) delete ret[lf.name];
    }
    let touched: string[] = [];
    if (e.category === 'list') {
      prepareList(this, e, ret, retDef, input, meta, rec.key);
    }
    if (e.category === 'txn') touched = this.prepareTxn(e, rec.key, ret, retDef, input, meta, prev);
    if (field(retDef, 'TimeModified')) ret.TimeModified = this.stamp();
    if (field(retDef, 'EditSequence')) ret.EditSequence = this.nextEditSequence(prev.EditSequence);
    fillRequired(ret, retDef, this.required);
    const next: Rec = { ...rec, ret, meta };
    this.store.put(next);
    if (e.category === 'list' && (patch.Name !== undefined || patch.ParentRef !== undefined))
      cascadeHierarchy(this, e, next);
    for (const t of touched) this.recalcTxn(t);
    return this.retPart(def, this.store.get(e.name, rec.key)!, rq.body);
  }

  /**
   * Line Mod semantics: the listed lines replace the existing ones; TxnLineID
   * -1 adds a line; an existing TxnLineID updates that line (amounts are
   * recalculated when Quantity or Rate change without an Amount).
   */
  private mergeLines(existing: Json[], mods: Json[]): Json[] {
    return mods.map((m) => {
      const id = text(m.TxnLineID);
      if (!id || id === '-1') {
        const n = { ...m };
        delete n.TxnLineID;
        return n;
      }
      const old = existing.find((x) => x.TxnLineID === id);
      if (!old) throw status.notFound(id);
      const merged: Json = { ...old, ...m };
      const changesPrice = ['Quantity', 'Rate', 'Cost', 'ItemRef', 'RatePercent'].some(
        (k) => k in m,
      );
      if (changesPrice && !('Amount' in m)) delete merged.Amount;
      return merged;
    });
  }

  private specialAccountAdd(rq: ParsedRq, def: RequestDef): Outcome {
    const body = isObj(rq.body.SpecialAccountAdd) ? rq.body.SpecialAccountAdd : {};
    const type = text(body.SpecialAccountType) ?? '';
    const existing = this.store.all('Account').find((r) => r.ret.SpecialAccountType === type);
    if (existing) return this.retPart(def, existing, rq.body);
    const info = SPECIAL_ACCOUNT[type] ?? {
      name: type.replace(/([a-z])([A-Z])/g, '$1 $2'),
      type: 'OtherCurrentAsset',
    };
    let name = info.name.slice(0, 31);
    for (let i = 2; this.findByName(['Account'], name); i++)
      name = `${info.name.slice(0, 28)} ${i}`;
    const ret: Json = {
      ListID: this.newListId(),
      TimeCreated: this.stamp(),
      TimeModified: this.stamp(),
      EditSequence: this.nextEditSequence(),
      Name: name,
      FullName: name,
      IsActive: 'true',
      Sublevel: '0',
      AccountType: info.type,
      SpecialAccountType: type,
    };
    const rec: Rec = {
      entity: 'Account',
      key: String(ret.ListID),
      ret,
      seq: this.store.nextSeq(),
      meta: {},
    };
    this.store.put(rec);
    return this.retPart(def, rec, rq.body);
  }

  private listDel(rq: ParsedRq, def: RequestDef): Outcome {
    const type = text(rq.body.ListDelType) ?? '';
    const id = text(rq.body.ListID) ?? '';
    const e = entityByDelType('list', type);
    const rec = e ? this.store.get(e.name, id) : undefined;
    if (!e || !rec) throw status.notFound(id);
    for (const other of this.store.each()) {
      if (other === rec) continue;
      if (referencedIds(other.ret).has(id))
        throw new QbStatus(
          3170,
          `There was an error when deleting a ${type} list element "${fullNameOf(rec.ret) ?? id}". QuickBooks error message: This list element is in use and cannot be deleted.`,
        );
    }
    this.store.remove(e.name, id);
    const now = this.stamp();
    this.store.addDeleted({
      kind: 'list',
      delType: type,
      id,
      timeCreated: text(rec.ret.TimeCreated),
      timeDeleted: now,
      deletedAtMs: this.clock.now().getTime(),
      fullName: fullNameOf(rec.ret),
    });
    const body: Json = { ListDelType: type, ListID: id, TimeDeleted: now };
    const fn = fullNameOf(rec.ret);
    if (fn) body.FullName = fn;
    return { kind: 'part', part: { rs: def.response, body } };
  }

  private txnDel(rq: ParsedRq, def: RequestDef): Outcome {
    const type = text(rq.body.TxnDelType) ?? '';
    const id = text(rq.body.TxnID) ?? '';
    const e = entityByDelType('txn', type);
    const rec = e ? this.store.get(e.name, id) : undefined;
    if (!e || !rec) throw status.notFound(id);
    const linked = arr<Json>(rec.ret.AppliedToTxnRet).map((a) => String(a.TxnID));
    if (this.appliedTo(id).total > 0)
      throw status.saveError(
        type,
        'This transaction has payments applied to it. Delete or void the payments first.',
      );
    this.store.remove(e.name, id);
    const now = this.stamp();
    this.store.addDeleted({
      kind: 'txn',
      delType: type,
      id,
      timeCreated: text(rec.ret.TimeCreated),
      timeDeleted: now,
      deletedAtMs: this.clock.now().getTime(),
      refNumber: text(rec.ret.RefNumber),
    });
    for (const t of linked) this.recalcTxn(t);
    const body: Json = { TxnDelType: type, TxnID: id, TimeDeleted: now };
    if (text(rec.ret.RefNumber)) body.RefNumber = rec.ret.RefNumber;
    return { kind: 'part', part: { rs: def.response, body } };
  }

  private txnVoid(rq: ParsedRq, def: RequestDef): Outcome {
    const type = text(rq.body.TxnVoidType) ?? '';
    const id = text(rq.body.TxnID) ?? '';
    const e = entityByVoidType(type);
    const rec = e ? this.store.get(e.name, id) : undefined;
    if (!e || !rec) throw status.notFound(id);
    if (this.appliedTo(id).total > 0)
      throw status.saveError(
        type,
        'This transaction has payments applied to it. Delete or void the payments first.',
      );
    const linked = arr<Json>(rec.ret.AppliedToTxnRet).map((a) => String(a.TxnID));
    const retDef = obj(e.retElement);
    const next = this.update(rec, (ret, meta) => {
      meta.voided = true;
      voidAmounts(retDef, ret);
      computeTotals(this, e, { key: id, ret, meta });
      ret.TimeModified = this.stamp();
      ret.EditSequence = this.nextEditSequence(rec.ret.EditSequence);
    });
    for (const t of linked) this.recalcTxn(t);
    const body: Json = {
      TxnVoidType: type,
      TxnID: id,
      TimeCreated: next.ret.TimeCreated,
      TimeModified: next.ret.TimeModified,
    };
    if (text(next.ret.RefNumber)) body.RefNumber = next.ret.RefNumber;
    return { kind: 'part', part: { rs: def.response, body } };
  }

  // -------------------------------------------------------------------------
  // Response rendering

  /** Render outcomes as one response document; it is validated before it is returned. */
  render(outcomes: Outcome[]): string {
    const parts = outcomes.filter(
      (o): o is Extract<Outcome, { kind: 'part' }> => o.kind === 'part',
    );
    if (parts.length === outcomes.length && parts.length > 0) {
      try {
        return buildResponse(parts.map((p) => p.part));
      } catch {
        // Fall through: render part by part and replace the broken one.
      }
    }
    const fragments: string[] = [];
    let msgSet = 'QBXMLMsgsRs';
    for (const o of outcomes) {
      if (o.kind === 'raw') {
        fragments.push(o.xml);
        continue;
      }
      let doc: string;
      try {
        doc = buildResponse([o.part]);
      } catch (err) {
        this.onInternalError?.(err, o.part.rs);
        const s = status.internal('the response did not pass XSD validation');
        doc = buildResponse([
          {
            rs: o.part.rs,
            requestID: o.part.requestID,
            statusCode: s.code,
            statusSeverity: s.severity,
            statusMessage: s.message,
          },
        ]);
      }
      const m = /<(QBXML(?:Subscription)?MsgsRs)>\n?([\s\S]*?)\n?\s*<\/\1>/.exec(doc);
      if (m) {
        msgSet = m[1]!;
        fragments.push(m[2]!);
      }
    }
    const xml = [
      '<?xml version="1.0" ?>',
      '<QBXML>',
      `  <${msgSet}>`,
      ...fragments,
      `  </${msgSet}>`,
      '</QBXML>',
      '',
    ].join('\n');
    const r = validate(xml);
    if (!r.valid) {
      this.onInternalError?.(
        new Error(r.errors.map((e) => `line ${e.line}: ${e.message}`).join('; ')),
        'render',
      );
      throw new Error(
        `relay mock produced an invalid response: ${r.errors[0]?.message ?? 'unknown error'}`,
      );
    }
    return xml;
  }

  /** A reference element pointing at a record. */
  refTo(rec: Rec): Json {
    return refTo(rec);
  }
}

/** JournalEntryMod lists JournalLineMod elements with a JournalLineType; split them by side. */
function splitJournalLines(input: Json, prev: Json, patch: Json): void {
  const credits = new Set(arr<Json>(prev.JournalCreditLine).map((l) => text(l.TxnLineID)));
  const debit: Json[] = [];
  const credit: Json[] = [];
  for (const lm of arr<Json>(input.JournalLineMod).filter(isObj)) {
    const line = mapToRet(lm, obj('JournalLineMod'), obj('JournalDebitLine'));
    const side = text(lm.JournalLineType) ?? (credits.has(text(lm.TxnLineID)) ? 'Credit' : 'Debit');
    (side === 'Credit' ? credit : debit).push(line);
  }
  patch.JournalDebitLine = debit;
  patch.JournalCreditLine = credit;
}

function renamePaymentTxnId(input: Json): void {
  for (const l of arr<Json>(input.DepositLineAdd ?? input.DepositLineMod)) {
    if (isObj(l) && l.PaymentTxnID !== undefined) {
      l.TxnID = l.PaymentTxnID;
      delete l.PaymentTxnID;
    }
  }
}
