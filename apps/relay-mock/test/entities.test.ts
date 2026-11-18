// Generic Add / Query / Mod / Void / Del semantics for every entity in the catalog.
import { catalog, getObject, minimalObject, minimalRequestBody } from '@qbv/qbxml';
import { describe, expect, it } from 'vitest';
import { testEngine } from './helpers.js';

// Adds whose minimal body must point at an existing transaction.
const NEEDS_EXISTING = new Set(['BillPaymentCheck', 'BillPaymentCreditCard']);

const entities = Object.values(catalog.entities)
  .map((e) => ({
    e,
    add: Object.values(catalog.requests).find(
      (r) => r.op === 'Add' && r.entity === e.name && r.name !== 'SpecialAccountAddRq',
    ),
  }))
  .filter((x) => x.add !== undefined)
  .sort((a, b) => a.e.name.localeCompare(b.e.name));

describe('every entity with an Add request', () => {
  const t = testEngine('2026-04-01T12:00:00Z');

  it.each(entities.map((x) => [x.e.name, x]))(
    '%s: add, query, mod, void, delete',
    (_name, { e, add }) => {
      const body = minimalRequestBody(add!.name);
      const inner = body[add!.bodyElement!] as Record<string, unknown> | undefined;
      if (inner && 'Name' in inner) {
        const max =
          getObject(add!.bodyElement!).fields.find((f) => f.name === 'Name')?.maxLength ?? 31;
        inner.Name = `${e.name.slice(0, 20)} 1`.slice(-max);
      }
      const rs = t.rq(add!.name, body);
      if (NEEDS_EXISTING.has(e.name)) {
        expect(rs.statusCode).toBe(3120);
        return;
      }
      expect(`${rs.statusCode} ${rs.statusMessage}`).toBe('0 Status OK');
      const created = rs.rets[0]!;
      expect(rs.retName).toBe(add!.retElement ?? e.retElement);
      if (!e.idField) return;
      const id = created[e.idField] as string;
      expect(id).toMatch(e.idField === 'ListID' ? /^8[0-9A-F]{7}-\d{10}$/ : /^[0-9A-F]+-\d{10}$/);
      expect(created.EditSequence).toMatch(/^\d+$/);
      expect(created.TimeCreated).toBeDefined();

      if (e.ops.query && getObject(e.ops.query).fields.some((f) => f.name === e.idField)) {
        const q = t.rq(e.ops.query, { [e.idField]: id });
        expect(q.statusCode).toBe(0);
        expect(q.rets[0]![e.idField]).toBe(id);
      }
      let es = created.EditSequence as string;
      if (e.ops.mod) {
        const modDef = catalog.requests[e.ops.mod]!;
        t.advance(1000);
        const modBody = {
          ...minimalObject(modDef.bodyElement!),
          [e.idField]: id,
          EditSequence: es,
        };
        const m = t.rq(e.ops.mod, { [modDef.bodyElement!]: modBody });
        expect(`${m.statusCode} ${m.statusMessage}`).toBe('0 Status OK');
        expect(Number(m.rets[0]!.EditSequence)).toBeGreaterThan(Number(es));
        const stale = t.rq(e.ops.mod, { [modDef.bodyElement!]: modBody });
        expect(stale.statusCode).toBe(3200);
        es = m.rets[0]!.EditSequence as string;
      }
      if (e.voidType) {
        const v = t.rq('TxnVoidRq', { TxnVoidType: e.voidType, TxnID: id });
        expect(v.statusCode).toBe(0);
      }
      if (e.delType) {
        const d =
          e.category === 'list'
            ? t.rq('ListDelRq', { ListDelType: e.delType, ListID: id })
            : t.rq('TxnDelRq', { TxnDelType: e.delType, TxnID: id });
        expect(`${d.statusCode} ${d.statusMessage}`).toBe('0 Status OK');
        const gone =
          e.category === 'list'
            ? t.rq('ListDeletedQueryRq', { ListDelType: e.delType })
            : t.rq('TxnDeletedQueryRq', { TxnDelType: e.delType });
        expect(gone.rets.some((r) => r[e.idField!] === id)).toBe(true);
      }
      expect(t.internalErrors).toEqual([]);
    },
  );
});
