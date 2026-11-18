// Values QuickBooks computes when it returns an object: customer / vendor /
// account balances, and the current names inside every reference.
import type { Engine } from './engine.js';
import { balances, buildLedger, PL_TYPES, type Ledger } from './ledger.js';
import { fullNameOf } from './qb.js';
import { type Rec } from './store.js';
import { amt, arr, isObj, num, text, type Json } from './util.js';

export interface Derived {
  ledger: Ledger;
  view(rec: Rec): Json;
  customerBalance(id: string): number;
  vendorBalance(id: string): number;
}

export function buildDerived(engine: Engine): Derived {
  const store = engine.store;
  const byId = new Map<string, Rec>();
  for (const r of store.each()) {
    const id = text(r.ret.ListID);
    if (id) byId.set(id, r);
  }

  // Customer and vendor own balances.
  const own = new Map<string, number>();
  const add = (ref: unknown, v: number) => {
    const id = isObj(ref) ? text(ref.ListID) : undefined;
    if (id && v) own.set(id, (own.get(id) ?? 0) + v);
  };
  for (const r of store.all('Invoice')) add(r.ret.CustomerRef, num(r.ret.BalanceRemaining) ?? 0);
  for (const r of store.all('Charge')) add(r.ret.CustomerRef, num(r.ret.BalanceRemaining) ?? 0);
  for (const r of store.all('CreditMemo'))
    add(r.ret.CustomerRef, -(num(r.ret.CreditRemaining) ?? 0));
  for (const r of store.all('ReceivePayment'))
    add(r.ret.CustomerRef, -(num(r.ret.UnusedPayment) ?? 0));
  for (const r of store.all('Bill')) add(r.ret.VendorRef, num(r.ret.OpenAmount) ?? 0);
  for (const r of store.all('VendorCredit')) add(r.ret.VendorRef, -(num(r.ret.OpenAmount) ?? 0));
  for (const e of ['Customer', 'Vendor'])
    for (const r of store.all(e)) {
      const ob = num(r.meta.openBalance);
      if (ob) own.set(r.key, (own.get(r.key) ?? 0) + ob);
    }

  const children = new Map<string, string[]>();
  for (const e of ['Customer', 'Account']) {
    for (const r of store.all(e)) {
      const p = isObj(r.ret.ParentRef) ? text(r.ret.ParentRef.ListID) : undefined;
      if (p) children.set(p, [...(children.get(p) ?? []), r.key]);
    }
  }
  const total = (id: string, own: (id: string) => number, depth = 0): number =>
    depth > 50
      ? 0
      : own(id) + (children.get(id) ?? []).reduce((s, c) => s + total(c, own, depth + 1), 0);

  // Account balances: balance-sheet accounts cumulative, P&L accounts fiscal year to date.
  let ledger: Ledger | undefined;
  let acctBal: Map<string, number> | undefined;
  const ledgerOnce = () => (ledger ??= buildLedger(engine));
  const accountBalance = (id: string): number => {
    if (!acctBal) {
      const l = ledgerOnce();
      const today = engine.today();
      const fyStart = `${today.slice(0, 4)}-01-01`;
      acctBal = balances(l, (p) => {
        const type = l.accounts.get(p.account)?.type ?? '';
        return PL_TYPES.has(type) ? p.date >= fyStart && p.date <= today : true;
      });
    }
    return acctBal.get(id) ?? 0;
  };

  const refresh = (o: unknown): void => {
    if (Array.isArray(o)) {
      for (const x of o) refresh(x);
      return;
    }
    if (!isObj(o)) return;
    for (const [k, v] of Object.entries(o)) {
      if (/Ref$/.test(k)) {
        for (const ref of arr<Json>(v)) {
          if (!isObj(ref) || typeof ref.ListID !== 'string' || !('FullName' in ref)) continue;
          const target = byId.get(ref.ListID);
          const name = target ? fullNameOf(target.ret) : undefined;
          if (name) ref.FullName = name;
        }
      } else if (typeof v === 'object') refresh(v);
    }
  };

  return {
    get ledger() {
      return ledgerOnce();
    },
    customerBalance: (id) => own.get(id) ?? 0,
    vendorBalance: (id) => own.get(id) ?? 0,
    view(rec: Rec): Json {
      const ret = structuredClone(rec.ret);
      refresh(ret);
      switch (rec.entity) {
        case 'Customer':
          ret.Balance = amt(own.get(rec.key) ?? 0);
          ret.TotalBalance = amt(total(rec.key, (id) => own.get(id) ?? 0));
          break;
        case 'Vendor':
          ret.Balance = amt(own.get(rec.key) ?? 0);
          break;
        case 'Account':
          ret.Balance = amt(accountBalance(rec.key));
          ret.TotalBalance = amt(total(rec.key, accountBalance));
          break;
      }
      return ret;
    },
  };
}
