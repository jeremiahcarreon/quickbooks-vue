import { describe, expect, it } from 'vitest';
import { catalog, getObject, validate } from '@qbv/qbxml';
import { planSync, type SyncUnit } from '../src/plan.js';
import {
  buildDeletedQuery,
  buildFetchByIdsQuery,
  buildIncrementalQuery,
  buildInitialQuery,
  buildReconcileQuery,
  deletedQueryTypes,
  selectFields,
  type BuiltQuery,
} from '../src/queries.js';
import { deleteGroups } from '../src/engine.js';

const plan = planSync();
const from = new Date('2026-11-01T08:30:00Z');
const now = new Date('2026-11-17T12:00:00Z');

function expectValid(q: BuiltQuery): void {
  const res = validate(q.xml);
  expect(res.errors, `${q.rq}\n${q.xml}`).toEqual([]);
  expect(res.valid).toBe(true);
}

/** Parse the request's element (as a document) back to a plain object. */
function rqElement(q: BuiltQuery): string {
  const m = new RegExp(`<${q.rq}[^>]*>[\\s\\S]*?</${q.rq}>|<${q.rq}[^>]*/>`).exec(q.xml);
  expect(m, q.xml).not.toBeNull();
  return m![0];
}

describe('planSync', () => {
  it('covers every catalog entity: a unit or a recorded reason', () => {
    const covered = new Set([
      ...plan.units.flatMap((u) => u.entities.map((e) => e.name)),
      ...plan.skipped.map((s) => s.entity),
    ]);
    expect([...covered].sort()).toEqual(Object.keys(catalog.entities).sort());
  });

  it('creates a unit for every entity whose own query needs no input', () => {
    for (const e of Object.values(catalog.entities)) {
      if (!e.ops.query) continue;
      const required = getObject(e.ops.query).fields.filter((f) => f.minOccurs > 0);
      if (required.length === 0) expect(plan.unitOf[e.name], e.name).toBe(e.name);
      else expect(plan.skipped.find((s) => s.entity === e.name)?.reason).toMatch(/requires/);
    }
  });

  it('groups union-only entities under their union query', () => {
    const unit = plan.units.find((u) => u.key === 'PayrollItemQueryRq');
    expect(unit).toBeDefined();
    expect(unit!.entities.map((e) => e.name)).toContain('PayrollItemTax');
    expect(unit!.entities.map((e) => e.name)).not.toContain('PayrollItemWage'); // has its own query
    expect(unit!.retToEntity.PayrollItemTaxRet).toBe('PayrollItemTax');
    expect(plan.skipped.find((s) => s.entity === 'DataExt')?.reason).toBe('no query request');
  });

  it('reads modified filters and paging from the schema', () => {
    const by = (k: string) => plan.units.find((u) => u.key === k)!;
    expect(by('Customer')).toMatchObject({ modifiedFilter: 'FromModifiedDate', paging: true });
    expect(by('Account')).toMatchObject({ modifiedFilter: 'FromModifiedDate', paging: false });
    expect(by('Invoice')).toMatchObject({
      modifiedFilter: 'ModifiedDateRangeFilter',
      paging: true,
    });
    expect(by('Template')).toMatchObject({ modifiedFilter: null, paging: false });
    expect(by('BarCode').paging).toBe(false); // iterator but no MaxReturned
    expect(by('Company').idField).toBeNull();
  });

  it('honours an include list and rejects unknown names', () => {
    const p = planSync({ include: ['Customer', 'Invoice', 'PayrollItemTax'] });
    expect(p.units.map((u) => u.key).sort()).toEqual(['Customer', 'Invoice', 'PayrollItemQueryRq']);
    expect(() => planSync({ include: ['Nope'] })).toThrow(/Nope/);
  });
});

describe('every generated sync query validates against the XSD', () => {
  const units = plan.units;
  it('has units to test', () => expect(units.length).toBeGreaterThan(70));

  for (const unit of units) {
    describe(unit.key, () => {
      it('initial load (Start and Continue pages)', () => {
        const start = buildInitialQuery(unit, { pageSize: 500 });
        expectValid(start);
        if (unit.paging) {
          expect(start.iterator).toBe('Start');
          expect(rqElement(start)).toContain('<MaxReturned>500</MaxReturned>');
          const cont = buildInitialQuery(unit, {
            page: { iterator: 'Continue', iteratorID: '{eb05f701-e727-472f-8ade-6753c4f67a46}' },
          });
          expectValid(cont);
          expect(cont.xml).toContain('iterator="Continue"');
        } else {
          expect(start.xml).not.toContain('MaxReturned');
          expect(start.xml).not.toContain('iterator=');
        }
        if (getObject(unit.rq).fields.some((f) => f.name === 'ActiveStatus')) {
          expect(start.body.ActiveStatus).toBe('All');
        }
        if (getObject(unit.rq).fields.some((f) => f.name === 'IncludeLineItems')) {
          expect(start.body.IncludeLineItems).toBe(true);
        }
      });

      if (unit.modifiedFilter) {
        it('incremental', () => {
          const q = buildIncrementalQuery(unit, from, { pageSize: 500 });
          expectValid(q);
          expect(rqElement(q)).toMatch(/<FromModifiedDate>2026-11-01T/);
          if (unit.modifiedFilter === 'ModifiedDateRangeFilter') {
            expect(rqElement(q)).toContain('<ModifiedDateRangeFilter>');
          }
          expect(q.dropped).not.toContain('FromModifiedDate');
          expect(q.dropped).not.toContain('ModifiedDateRangeFilter');
        });
      }

      if (unit.reconcilable) {
        it('reconcile (ids only) and fetch by ids', () => {
          const r = buildReconcileQuery(unit, { pageSize: 500 });
          expectValid(r);
          expect(rqElement(r)).toContain(`<IncludeRetElement>${unit.idField}</IncludeRetElement>`);
          const f = buildFetchByIdsQuery(unit, ['80000001-1234567890', '80000002-1234567890']);
          expectValid(f);
          expect(rqElement(f)).toContain(`<${unit.idField}>80000002-1234567890</${unit.idField}>`);
          expect(f.xml).not.toContain('MaxReturned');
        });
      }
    });
  }

  it('deleted queries for every delete type (list and txn), with and without a date', () => {
    for (const kind of ['list', 'txn'] as const) {
      const types = deleteGroups(units)[kind];
      expect(types.length).toBeGreaterThan(10);
      for (const t of types) {
        const one = buildDeletedQuery(kind, [t], { from, now });
        expectValid(one);
        expect(one.xml).toContain('<FromDeletedDate>2026-11-01T');
      }
      const all = buildDeletedQuery(kind, types, { from, now });
      expectValid(all);
      const old = buildDeletedQuery(kind, types, { from: new Date('2020-01-01'), now });
      expectValid(old);
      expect(old.xml).not.toContain('DeletedDateRangeFilter');
      // The schema enum is the source of the values.
      for (const t of types) expect(deletedQueryTypes(kind)).toContain(t);
    }
  });

  it('every entity with a delete type is covered by a deleted query', () => {
    const groups = deleteGroups(units);
    for (const u of units) {
      for (const e of u.entities) {
        if (!e.delType) continue;
        const kind = deletedQueryTypes('list').includes(e.delType) ? 'list' : 'txn';
        expect(groups[kind], e.name).toContain(e.delType);
      }
    }
  });
});

describe('choice groups', () => {
  it('drops filters that sit in another branch of the same choice', () => {
    const { body, dropped } = selectFields('CustomerQueryRq', [
      ['ListID', ['1']],
      ['MaxReturned', 500],
      ['ActiveStatus', 'All'],
      ['IncludeRetElement', ['ListID']],
    ]);
    expect(body).toEqual({ ListID: ['1'], IncludeRetElement: ['ListID'] });
    expect(dropped).toEqual(['MaxReturned', 'ActiveStatus']);
  });

  it('respects nested choices (ModifiedDateRangeFilter vs TxnDateRangeFilter)', () => {
    const { body, dropped } = selectFields('InvoiceQueryRq', [
      ['ModifiedDateRangeFilter', { FromModifiedDate: from }],
      ['TxnDateRangeFilter', { FromTxnDate: '2026-01-01' }],
      ['MaxReturned', 10],
    ]);
    expect(Object.keys(body)).toEqual(['ModifiedDateRangeFilter', 'MaxReturned']);
    expect(dropped).toEqual(['TxnDateRangeFilter']);
  });

  it('drops elements a query does not have', () => {
    const { body, dropped } = selectFields('ChargeQueryRq', [
      ['IncludeLineItems', true],
      ['IncludeLinkedTxns', true],
    ]);
    expect(dropped).toEqual(['IncludeLineItems']);
    expect(body).toEqual({ IncludeLinkedTxns: true });
    const q = buildInitialQuery(plan.units.find((u) => u.key === 'Charge')!);
    expect(q.body).not.toHaveProperty('IncludeLineItems');
    expectValid(q);
  });

  it('refuses id-only and by-id queries for units that cannot filter by id', () => {
    const template = plan.units.find((u) => u.key === 'Template')!;
    expect(template.reconcilable).toBe(false);
    expect(() => buildReconcileQuery(template)).toThrow(/re-queried in full/);
    expect(() => buildFetchByIdsQuery(template, ['1'])).toThrow(/cannot filter/);
  });

  it('every incremental unit with an id can be reconciled', () => {
    for (const u of plan.units) {
      if (u.modifiedFilter && u.idField) expect(u.reconcilable, u.key).toBe(true);
    }
  });

  it('builds a response-parseable request id', () => {
    const q = buildInitialQuery(
      plan.units.find((u) => u.key === 'Customer')!,
      {
        requestID: 'abc',
      },
    );
    expect(q.xml).toContain('requestID="abc"');
  });
});

describe('unit fixture sanity', () => {
  it('SyncUnit retToEntity maps every member', () => {
    for (const u of plan.units as SyncUnit[]) {
      for (const e of u.entities) expect(u.retToEntity[e.retElement]).toBe(e.name);
    }
  });
});
