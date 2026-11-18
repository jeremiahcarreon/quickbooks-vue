// Query requests: generic filters for every entity, union queries
// (ItemQuery, EntityQuery, TermsQuery, PayrollItemQuery), deleted-object
// queries, TransactionQuery, iterators.
import { randomUUID } from 'node:crypto';
import { toDateTime, type EntityDef, type RequestDef } from '@qbv/qbxml';
import type { Engine, Outcome } from './engine.js';
import { field, fullNameOf, obj, status, unionMembers, type QbStatus } from './qb.js';
import { type Rec } from './store.js';
import { txnTotal } from './txns.js';
import { amt, arr, bool, dateMacro, isObj, lower, num, text, type Json } from './util.js';
import { type ParsedRq } from './xml.js';

type Mode = 'entity' | 'transaction';

export interface IteratorState {
  rq: string;
  mode: Mode;
  remaining: { entity: string; key: string }[];
  include: string[];
  lines: boolean;
  linked: boolean;
  createdAt: number;
}

/** Iterators unused for this long are dropped. */
const ITERATOR_TTL_MS = 60 * 60 * 1000;

function refId(v: unknown): string | undefined {
  return isObj(v) ? text(v.ListID) : undefined;
}

function texts(v: unknown): string[] {
  return arr(v)
    .map(text)
    .filter((s): s is string => s !== undefined);
}

function partyRef(ret: Json): unknown {
  return ret.CustomerRef ?? ret.VendorRef ?? ret.PayeeEntityRef ?? ret.EntityRef;
}

const HEADER_ACCOUNTS = [
  'ARAccountRef',
  'APAccountRef',
  'AccountRef',
  'BankAccountRef',
  'DepositToAccountRef',
  'CreditCardAccountRef',
  'TransferFromAccountRef',
  'TransferToAccountRef',
  'LiabilityAccountRef',
];

function accountIds(ret: Json): Set<string> {
  const ids = new Set<string>();
  for (const k of HEADER_ACCOUNTS) {
    const id = refId(ret[k]);
    if (id) ids.add(id);
  }
  for (const k of ['ExpenseLineRet', 'DepositLineRet', 'JournalDebitLine', 'JournalCreditLine'])
    for (const l of arr<Json>(ret[k])) {
      const id = refId(l.AccountRef);
      if (id) ids.add(id);
    }
  return ids;
}

function hierCompare(a: string, b: string): number {
  const x = lower(a).replace(/:/g, '\u0000');
  const y = lower(b).replace(/:/g, '\u0000');
  return x < y ? -1 : x > y ? 1 : 0;
}

function timeOf(v: unknown): number | undefined {
  const d = toDateTime(text(v));
  return d ? Math.floor(d.getTime() / 1000) : undefined;
}

function matchCriterion(value: string | undefined, crit: Json): boolean {
  const v = lower(value);
  const want = lower(text(crit.Name) ?? text(crit.RefNumber));
  switch (text(crit.MatchCriterion)) {
    case 'StartsWith':
      return v.startsWith(want);
    case 'EndsWith':
      return v.endsWith(want);
    default:
      return v.includes(want);
  }
}

function inRange(value: string | undefined, from?: string, to?: string): boolean {
  if (value === undefined) return false;
  const numeric = [value, from, to].every((s) => s === undefined || /^\d+$/.test(s));
  if (numeric) {
    const n = Number(value);
    return (from === undefined || n >= Number(from)) && (to === undefined || n <= Number(to));
  }
  const v = lower(value);
  return (from === undefined || v >= lower(from)) && (to === undefined || v <= lower(to));
}

interface Filtered {
  recs: Rec[];
  missing: string[];
}

/** Apply the query filters QuickBooks supports to a set of records. */
function filterRecords(engine: Engine, def: RequestDef, body: Json, candidates: Rec[]): Filtered {
  const ids = texts(body.ListID ?? body.TxnID);
  if (ids.length) {
    const found: Rec[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const r = candidates.find((c) => c.key === id);
      if (r) found.push(r);
      else missing.push(id);
    }
    return { recs: found, missing };
  }
  const names = texts(body.FullName);
  if (names.length) {
    const found: Rec[] = [];
    const missing: string[] = [];
    for (const n of names) {
      const r = candidates.find((c) => lower(fullNameOf(c.ret)) === lower(n));
      if (r) found.push(r);
      else missing.push(n);
    }
    return { recs: found, missing };
  }
  let recs = candidates;
  const refs = texts(body.RefNumber);
  if (refs.length) {
    const want = new Set(refs.map(lower));
    return { recs: recs.filter((r) => want.has(lower(text(r.ret.RefNumber)))), missing: [] };
  }
  const refsCs = texts(body.RefNumberCaseSensitive);
  if (refsCs.length) {
    const want = new Set(refsCs);
    return { recs: recs.filter((r) => want.has(text(r.ret.RefNumber) ?? '')), missing: [] };
  }

  const rqObj = obj(def.name);
  if (field(rqObj, 'ActiveStatus')) {
    const s = text(body.ActiveStatus) ?? 'ActiveOnly';
    if (s !== 'All')
      recs = recs.filter((r) => {
        if (r.ret.IsActive === undefined) return true;
        const active = bool(r.ret.IsActive) !== false;
        return s === 'ActiveOnly' ? active : !active;
      });
  }
  const mod = isObj(body.ModifiedDateRangeFilter) ? body.ModifiedDateRangeFilter : body;
  const fromMod = timeOf(mod.FromModifiedDate);
  const toMod = timeOf(mod.ToModifiedDate);
  if (fromMod !== undefined || toMod !== undefined) {
    recs = recs.filter((r) => {
      const t = timeOf(r.ret.TimeModified);
      if (t === undefined) return false;
      return (fromMod === undefined || t >= fromMod) && (toMod === undefined || t <= toMod);
    });
  }
  if (isObj(body.TxnDateRangeFilter)) {
    const f = body.TxnDateRangeFilter;
    const range = text(f.DateMacro)
      ? dateMacro(text(f.DateMacro)!, engine.today())
      : { from: text(f.FromTxnDate), to: text(f.ToTxnDate) };
    recs = recs.filter((r) => {
      const d = text(r.ret.TxnDate);
      if (!d) return false;
      return (!range.from || d >= range.from) && (!range.to || d <= range.to);
    });
  }
  if (isObj(body.EntityFilter)) {
    const f = body.EntityFilter;
    const types = texts(f.EntityTypeFilter);
    const idSet = new Set(texts(f.ListID));
    const nameSet = new Set(texts(f.FullName).map(lower));
    let parent = text(f.ListIDWithChildren);
    const parentName = text(f.FullNameWithChildren);
    if (parentName)
      parent =
        engine.findByName(['Customer', 'Vendor', 'Employee', 'OtherName'], parentName)?.key ??
        '\u0000';
    recs = recs.filter((r) => {
      const ref = partyRef(r.ret);
      const id = refId(ref);
      if (!id) return false;
      if (types.length) {
        const target = engine.findById(types, id);
        if (!target) return false;
      }
      if (idSet.size) return idSet.has(id);
      if (nameSet.size) return nameSet.has(lower(isObj(ref) ? text(ref.FullName) : undefined));
      if (parent) return engine.isSameOrChild(parent, id);
      return true;
    });
  }
  if (isObj(body.AccountFilter)) {
    const f = body.AccountFilter;
    let want = new Set(texts(f.ListID));
    for (const n of texts(f.FullName)) {
      const a = engine.findByName(['Account'], n);
      if (a) want.add(a.key);
    }
    const withChildren =
      text(f.ListIDWithChildren) ??
      (text(f.FullNameWithChildren)
        ? engine.findByName(['Account'], text(f.FullNameWithChildren)!)?.key
        : undefined);
    if (withChildren) {
      want = new Set([withChildren]);
      for (const a of engine.store.all('Account'))
        if (
          lower(fullNameOf(a.ret)).startsWith(
            lower(fullNameOf(engine.store.get('Account', withChildren)?.ret ?? {})) + ':',
          )
        )
          want.add(a.key);
    }
    recs = recs.filter((r) => [...accountIds(r.ret)].some((id) => want.has(id)));
  }
  if (isObj(body.RefNumberFilter)) {
    const f = body.RefNumberFilter;
    recs = recs.filter((r) => matchCriterion(text(r.ret.RefNumber), f));
  }
  if (isObj(body.RefNumberRangeFilter)) {
    const f = body.RefNumberRangeFilter;
    recs = recs.filter((r) =>
      inRange(text(r.ret.RefNumber), text(f.FromRefNumber), text(f.ToRefNumber)),
    );
  }
  if (isObj(body.NameFilter)) {
    const f = body.NameFilter;
    recs = recs.filter((r) => matchCriterion(fullNameOf(r.ret), f));
  }
  if (isObj(body.NameRangeFilter)) {
    const f = body.NameRangeFilter;
    recs = recs.filter((r) => inRange(fullNameOf(r.ret), text(f.FromName), text(f.ToName)));
  }
  const accountTypes = texts(body.AccountType);
  if (accountTypes.length)
    recs = recs.filter((r) => accountTypes.includes(text(r.ret.AccountType) ?? ''));
  const paid = text(body.PaidStatus);
  if (paid && paid !== 'All') {
    recs = recs.filter((r) => (bool(r.ret.IsPaid) === true) === (paid === 'PaidOnly'));
  }
  if (isObj(body.TotalBalanceFilter)) {
    const op = text(body.TotalBalanceFilter.Operator);
    const want = num(body.TotalBalanceFilter.Amount) ?? 0;
    recs = recs.filter((r) => {
      const view = engine.view(r);
      const v = num(view.TotalBalance) ?? num(view.Balance) ?? 0;
      switch (op) {
        case 'LessThan':
          return v < want;
        case 'LessThanEqual':
          return v <= want;
        case 'Equal':
          return v === want;
        case 'GreaterThan':
          return v > want;
        default:
          return v >= want;
      }
    });
  }
  const types = texts(body.TxnTypeFilter);
  if (types.length && !types.includes('All')) recs = recs.filter((r) => types.includes(r.entity));
  return { recs, missing: [] };
}

function sortRecords(recs: Rec[], category: string): Rec[] {
  if (category === 'list')
    return [...recs].sort(
      (a, b) => hierCompare(fullNameOf(a.ret) ?? '', fullNameOf(b.ret) ?? '') || a.seq - b.seq,
    );
  if (category === 'txn')
    return [...recs].sort(
      (a, b) =>
        String(a.ret.TxnDate ?? '').localeCompare(String(b.ret.TxnDate ?? '')) || a.seq - b.seq,
    );
  return [...recs].sort((a, b) => a.seq - b.seq);
}

/** The TransactionRet summary of a transaction. */
function transactionRet(rec: Rec): Json | undefined {
  const r = rec.ret;
  const def = obj('TransactionRet');
  const types = field(def, 'TxnType')?.enum ?? [];
  if (!types.includes(rec.entity)) return undefined;
  const amount = txnTotal(r);
  const out: Json = {
    TxnType: rec.entity,
    TxnID: rec.key,
    TimeCreated: r.TimeCreated,
    TimeModified: r.TimeModified,
    TxnDate: r.TxnDate,
    RefNumber: r.RefNumber,
    Amount: amt(amount),
    Memo: r.Memo,
  };
  const party = partyRef(r);
  if (isObj(party)) out.EntityRef = { ...party };
  for (const k of HEADER_ACCOUNTS) {
    if (isObj(r[k])) {
      out.AccountRef = { ...(r[k] as Json) };
      break;
    }
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

function render(
  engine: Engine,
  mode: Mode,
  rec: Rec,
  opts: { include: string[]; lines: boolean; linked: boolean },
): { name: string; ret: Json } | undefined {
  if (mode === 'transaction') {
    const ret = transactionRet(rec);
    if (!ret) return undefined;
    if (opts.include.length)
      for (const k of Object.keys(ret)) if (!opts.include.includes(k)) delete ret[k];
    return { name: 'TransactionRet', ret };
  }
  return {
    name: engine.entityOf(rec.entity).retElement,
    ret: engine.view(rec, opts.include, { lines: opts.lines, linked: opts.linked }),
  };
}

function page(
  engine: Engine,
  def: RequestDef,
  mode: Mode,
  recs: Rec[],
  opts: { include: string[]; lines: boolean; linked: boolean },
  max: number | undefined,
  iterator?: { id: string; state?: IteratorState },
  warn?: QbStatus,
): Outcome {
  const take = max !== undefined && max >= 0 ? recs.slice(0, max) : recs;
  const rest = recs.slice(take.length);
  const body: Json = {};
  let count = 0;
  for (const rec of take) {
    const r = render(engine, mode, rec, opts);
    if (!r) continue;
    const list = (body[r.name] as Json[] | undefined) ?? [];
    list.push(r.ret);
    body[r.name] = list;
    count++;
  }
  const part: Outcome = { kind: 'part', part: { rs: def.response, body } };
  if (iterator) {
    part.part.iteratorID = iterator.id;
    part.part.iteratorRemainingCount = rest.length;
    if (rest.length) {
      engine.iterators.set(iterator.id, {
        rq: def.name,
        mode,
        remaining: rest.map((r) => ({ entity: r.entity, key: r.key })),
        include: opts.include,
        lines: opts.lines,
        linked: opts.linked,
        createdAt: Date.now(),
      });
    } else engine.iterators.delete(iterator.id);
  }
  if (warn) {
    part.part.statusCode = warn.code;
    part.part.statusSeverity = warn.severity;
    part.part.statusMessage = warn.message;
  } else if (count === 0) {
    const s = status.noMatch();
    part.part.statusCode = s.code;
    part.part.statusSeverity = s.severity;
    part.part.statusMessage = s.message;
  }
  if (obj(def.response).attributes?.some((a) => a.name === 'retCount')) part.part.retCount = count;
  return part;
}

function sweepIterators(engine: Engine): void {
  const cutoff = Date.now() - ITERATOR_TTL_MS;
  for (const [id, st] of engine.iterators) if (st.createdAt < cutoff) engine.iterators.delete(id);
}

/** Generic query over one or more entities. */
export function handleQuery(
  engine: Engine,
  rq: ParsedRq,
  def: RequestDef,
  entities: EntityDef[],
  mode: Mode = 'entity',
): Outcome {
  sweepIterators(engine);
  const body = rq.body;
  const iterator = rq.attrs.iterator;
  const max = num(body.MaxReturned);
  if (iterator === 'Continue' || iterator === 'Stop') {
    const id = rq.attrs.iteratorID ?? '';
    const st = engine.iterators.get(id);
    if (!st || st.rq !== def.name) throw status.invalidId(id, 'iteratorID');
    if (iterator === 'Stop') {
      engine.iterators.delete(id);
      return {
        kind: 'part',
        part: { rs: def.response, iteratorID: id, iteratorRemainingCount: 0 },
      };
    }
    const recs = st.remaining
      .map((r) => engine.store.get(r.entity, r.key))
      .filter((r): r is Rec => r !== undefined);
    return page(engine, def, st.mode, recs, st, max, { id, state: st });
  }
  const rqObj = obj(def.name);
  const opts = {
    include: texts(body.IncludeRetElement),
    lines: field(rqObj, 'IncludeLineItems') ? bool(body.IncludeLineItems) === true : true,
    linked: field(rqObj, 'IncludeLinkedTxns') ? bool(body.IncludeLinkedTxns) === true : true,
  };
  const candidates = entities.flatMap((e) => engine.store.all(e.name));
  const { recs, missing } = filterRecords(engine, def, body, candidates);
  const category = entities.every((e) => e.category === 'list')
    ? 'list'
    : entities.every((e) => e.category === 'txn')
      ? 'txn'
      : 'other';
  const sorted = texts(body.ListID ?? body.TxnID ?? body.FullName).length
    ? recs
    : sortRecords(recs, category);
  const warn = missing.length ? status.partial(missing[0]!) : undefined;
  const it = iterator === 'Start' ? { id: `{${randomUUID().toUpperCase()}}` } : undefined;
  return page(engine, def, mode, sorted, opts, max, it, warn);
}

/** Queries with their own semantics. Returns undefined for ordinary entity queries. */
export function handleSpecialQuery(
  engine: Engine,
  rq: ParsedRq,
  def: RequestDef,
): Outcome | undefined {
  const members = unionMembers(def.name);
  if (members.length && !def.entity) return handleQuery(engine, rq, def, members);
  switch (def.name) {
    case 'ListDeletedQueryRq':
    case 'TxnDeletedQueryRq':
      return deletedQuery(engine, rq, def);
    case 'TransactionQueryRq':
      return transactionQuery(engine, rq, def);
    case 'ReceivePaymentToDepositQueryRq':
      return paymentsToDeposit(engine, rq, def);
    case 'BillToPayQueryRq':
      return billsToPay(engine, rq, def);
  }
  return undefined;
}

function deletedQuery(engine: Engine, rq: ParsedRq, def: RequestDef): Outcome {
  const list = def.name === 'ListDeletedQueryRq';
  const types = new Set(texts(list ? rq.body.ListDelType : rq.body.TxnDelType));
  const f = isObj(rq.body.DeletedDateRangeFilter) ? rq.body.DeletedDateRangeFilter : {};
  const from = timeOf(f.FromDeletedDate);
  const to = timeOf(f.ToDeletedDate);
  const include = texts(rq.body.IncludeRetElement);
  const rets = engine.store.deleted
    .filter((d) => d.kind === (list ? 'list' : 'txn') && types.has(d.delType))
    .filter((d) => {
      const t = Math.floor(d.deletedAtMs / 1000);
      return (from === undefined || t >= from) && (to === undefined || t <= to);
    })
    .map((d) => {
      const r: Json = list
        ? {
            ListDelType: d.delType,
            ListID: d.id,
            TimeCreated: d.timeCreated,
            TimeDeleted: d.timeDeleted,
            FullName: d.fullName,
          }
        : {
            TxnDelType: d.delType,
            TxnID: d.id,
            TimeCreated: d.timeCreated,
            TimeDeleted: d.timeDeleted,
            RefNumber: d.refNumber,
          };
      for (const k of Object.keys(r))
        if (r[k] === undefined || (include.length && !include.includes(k))) delete r[k];
      return r;
    });
  const retName = list ? 'ListDeletedRet' : 'TxnDeletedRet';
  if (!rets.length) {
    const s = status.noMatch();
    return {
      kind: 'part',
      part: {
        rs: def.response,
        statusCode: s.code,
        statusSeverity: s.severity,
        statusMessage: s.message,
      },
    };
  }
  return { kind: 'part', part: { rs: def.response, body: { [retName]: rets } } };
}

function transactionQuery(engine: Engine, rq: ParsedRq, def: RequestDef): Outcome {
  const b = { ...rq.body };
  // Map TransactionQuery's filter names onto the generic ones.
  if (isObj(b.TransactionModifiedDateRangeFilter)) {
    const f = b.TransactionModifiedDateRangeFilter;
    if (text(f.DateMacro)) {
      const r = dateMacro(text(f.DateMacro)!, engine.today());
      b.ModifiedDateRangeFilter = {
        FromModifiedDate: r.from ? `${r.from}T00:00:00` : undefined,
        ToModifiedDate: r.to ? `${r.to}T23:59:59` : undefined,
      };
    } else b.ModifiedDateRangeFilter = f;
  }
  if (isObj(b.TransactionDateRangeFilter)) b.TxnDateRangeFilter = b.TransactionDateRangeFilter;
  if (isObj(b.TransactionEntityFilter)) b.EntityFilter = b.TransactionEntityFilter;
  if (isObj(b.TransactionAccountFilter)) b.AccountFilter = b.TransactionAccountFilter;
  if (isObj(b.TransactionTypeFilter)) b.TxnTypeFilter = b.TransactionTypeFilter.TxnTypeFilter;
  const posting = text(b.TransactionPostingStatusFilter);
  const paid = text(b.TransactionPaidStatusFilter);
  const entities = engine.txnEntities().map((n) => engine.entityOf(n));
  const out = handleQuery(engine, { ...rq, body: b }, def, entities, 'transaction');
  if ((posting && posting !== 'Either') || (paid && paid !== 'Either')) {
    // Post-filter on posting / paid status.
    const nonPosting = new Set(['Estimate', 'SalesOrder', 'PurchaseOrder']);
    if (out.kind === 'part' && isObj(out.part.body)) {
      const rets = arr<Json>((out.part.body as Json).TransactionRet).filter((t) => {
        const type = String(t.TxnType);
        if (posting === 'Posting' && nonPosting.has(type)) return false;
        if (posting === 'NonPosting' && !nonPosting.has(type)) return false;
        if (paid && paid !== 'Either') {
          const rec = engine.findTxn(String(t.TxnID));
          const open = (num(rec?.ret.BalanceRemaining) ?? num(rec?.ret.OpenAmount) ?? 0) > 0;
          if (paid === 'Open' ? !open : open) return false;
        }
        return true;
      });
      out.part.body = rets.length ? { TransactionRet: rets } : {};
    }
  }
  return out;
}

function paymentsToDeposit(engine: Engine, rq: ParsedRq, def: RequestDef): Outcome {
  const uf = engine.special('UndepositedFunds');
  const deposited = new Set<string>();
  for (const d of engine.store.all('Deposit'))
    for (const l of arr<Json>(d.ret.DepositLineRet))
      if (text(l.TxnID)) deposited.add(String(l.TxnID));
  const include = texts(rq.body.IncludeRetElement);
  const rets: Json[] = [];
  for (const e of ['ReceivePayment', 'SalesReceipt']) {
    for (const r of engine.store.all(e).sort((a, b) => a.seq - b.seq)) {
      if (deposited.has(r.key) || r.meta.voided) continue;
      if (uf && refId(r.ret.DepositToAccountRef) !== uf.key) continue;
      const out: Json = {
        TxnID: r.key,
        TxnType: e,
        CustomerRef: r.ret.CustomerRef,
        TxnDate: r.ret.TxnDate,
        RefNumber: r.ret.RefNumber,
        Amount: r.ret.TotalAmount,
      };
      for (const k of Object.keys(out))
        if (out[k] === undefined || (include.length && !include.includes(k))) delete out[k];
      rets.push(out);
    }
  }
  if (!rets.length) {
    const s = status.noMatch();
    return {
      kind: 'part',
      part: {
        rs: def.response,
        statusCode: s.code,
        statusSeverity: s.severity,
        statusMessage: s.message,
      },
    };
  }
  return {
    kind: 'part',
    part: { rs: def.response, body: { ReceivePaymentToDepositRet: rets }, retCount: rets.length },
  };
}

function billsToPay(engine: Engine, rq: ParsedRq, def: RequestDef): Outcome {
  const payee = isObj(rq.body.PayeeEntityRef) ? rq.body.PayeeEntityRef : {};
  const vendor = text(payee.ListID)
    ? engine.findById(['Vendor'], text(payee.ListID)!)
    : text(payee.FullName)
      ? engine.findByName(['Vendor'], text(payee.FullName)!)
      : undefined;
  if (!vendor)
    throw status.badRef('Vendor', text(payee.FullName) ?? text(payee.ListID) ?? '', 'request');
  const due = text(rq.body.DueDate);
  const rets: Json[] = [];
  for (const b of engine.store
    .all('Bill')
    .sort((x, y) => String(x.ret.TxnDate).localeCompare(String(y.ret.TxnDate)))) {
    if (refId(b.ret.VendorRef) !== vendor.key) continue;
    const open = num(b.ret.OpenAmount) ?? 0;
    if (open <= 0) continue;
    if (due && text(b.ret.DueDate) && text(b.ret.DueDate)! > due) continue;
    const bill: Json = {
      TxnID: b.key,
      TxnType: 'Bill',
      APAccountRef:
        b.ret.APAccountRef ??
        (engine.special('AP')
          ? engine.refTo(engine.special('AP')!)
          : { FullName: 'Accounts Payable' }),
      TxnDate: b.ret.TxnDate,
      RefNumber: b.ret.RefNumber,
      DueDate: b.ret.DueDate,
      AmountDue: amt(open),
    };
    for (const k of Object.keys(bill)) if (bill[k] === undefined) delete bill[k];
    rets.push({ BillToPay: bill });
  }
  if (!rets.length) {
    const s = status.noMatch();
    return {
      kind: 'part',
      part: {
        rs: def.response,
        statusCode: s.code,
        statusSeverity: s.severity,
        statusMessage: s.message,
      },
    };
  }
  return { kind: 'part', part: { rs: def.response, body: { BillToPayRet: rets } } };
}
