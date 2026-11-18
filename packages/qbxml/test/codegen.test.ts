import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalog, catalogPath, getEntity, type FieldDef } from '../src/index.js';
// @ts-expect-error plain ESM script without type declarations
import { generate } from '../scripts/codegen.mjs';

const names = (fields: FieldDef[]): string[] => fields.map((f) => f.name);

describe('codegen', () => {
  it('is deterministic and matches the committed-to-disk catalog', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'qbv-codegen-'));
    const { counts } = generate({ out, log: () => {} }) as { counts: Record<string, number> };
    expect(readFileSync(path.join(out, 'catalog.json'), 'utf8')).toBe(
      readFileSync(catalogPath(), 'utf8'),
    );
    expect(counts.requests).toBeGreaterThan(250);
    expect(counts.objects).toBeGreaterThan(1000);
    expect(counts.entities).toBeGreaterThan(90);
    expect(counts.queryRequests).toBeGreaterThan(100);
    const types = readFileSync(path.join(out, 'types.ts'), 'utf8');
    expect(types).toMatch(/export interface CustomerAdd \{/);
    expect(types).toMatch(/export interface InvoiceRet \{/);
    expect(types).toMatch(/"InvoiceLineRet"\?: .*InvoiceLineRet\[\]/);
    expect(types).toMatch(/export type RequestName = .*"CustomerAddRq"/);
  });
});

describe('codegen without schemas', () => {
  it('fails with a clear message', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qbv-empty-'));
    expect(() => generate({ dir, out: dir, log: () => {} })).toThrow(
      /qbXML schema not found.*QBXML_SCHEMA_DIR/s,
    );
  });
});

describe('catalog.objects', () => {
  it('keeps fields in schema sequence order', () => {
    const f = names(catalog.objects.CustomerAdd!.fields);
    expect(f[0]).toBe('Name');
    expect(f.indexOf('IsActive')).toBeLessThan(f.indexOf('CompanyName'));
    expect(f.indexOf('CompanyName')).toBeLessThan(f.indexOf('BillAddress'));
    expect(names(catalog.objects.BillAddress!.fields).slice(0, 6)).toEqual([
      'Addr1',
      'Addr2',
      'Addr3',
      'Addr4',
      'Addr5',
      'City',
    ]);
  });

  it('records base types, maxLength, enums and occurrences', () => {
    const byName = (o: string, n: string) => catalog.objects[o]!.fields.find((x) => x.name === n)!;
    expect(byName('CustomerAdd', 'Name')).toMatchObject({
      kind: 'simple',
      type: 'STRTYPE',
      maxLength: 41,
      minOccurs: 1,
      maxOccurs: 1,
    });
    expect(byName('CustomerRet', 'ListID')).toMatchObject({ type: 'IDTYPE', maxLength: 36 });
    expect(byName('CustomerRet', 'Balance')).toMatchObject({ type: 'AMTTYPE', minOccurs: 0 });
    expect(byName('CustomerRet', 'IsActive')).toMatchObject({ type: 'BOOLTYPE' });
    expect(byName('CustomerRet', 'TimeModified')).toMatchObject({ type: 'DATETIMETYPE' });
    expect(byName('InvoiceAdd', 'TxnDate')).toMatchObject({ type: 'DATETYPE' });
    expect(byName('InvoiceLineAdd', 'Quantity')).toMatchObject({ type: 'QUANTYPE' });
    expect(byName('InvoiceLineAdd', 'Rate')).toMatchObject({ type: 'PRICETYPE' });
    expect(byName('InvoiceLineAdd', 'RatePercent')).toMatchObject({ type: 'PERCENTTYPE' });
    expect(byName('CustomerQueryRq', 'MaxReturned')).toMatchObject({ type: 'INTTYPE' });
    expect(byName('CustomerQueryRq', 'ActiveStatus').enum).toEqual([
      'ActiveOnly',
      'InactiveOnly',
      'All',
    ]);
    expect(byName('InvoiceAdd', 'CustomerRef')).toMatchObject({
      kind: 'complex',
      type: 'CustomerRef',
      children: 'CustomerRef',
    });
    expect(byName('InvoiceRet', 'InvoiceLineRet')).toMatchObject({
      kind: 'complex',
      maxOccurs: 'unbounded',
    });
    expect(byName('CustomerQueryRq', 'ListID')).toMatchObject({ maxOccurs: 'unbounded' });
  });

  it('marks choice groups and branches', () => {
    const f = catalog.objects.InvoiceLineAdd!.fields;
    const rate = f.find((x) => x.name === 'Rate')!;
    const pct = f.find((x) => x.name === 'RatePercent')!;
    expect(rate.choiceGroup).toBeDefined();
    expect(rate.choiceGroup).toBe(pct.choiceGroup);
    expect(rate.choiceBranch).not.toBe(pct.choiceBranch);
    const q = catalog.objects.CustomerQueryRq!.fields;
    const listId = q.find((x) => x.name === 'ListID')!;
    const name = q.find((x) => x.name === 'NameFilter')!;
    expect(listId.choiceGroup).toBe(q.find((x) => x.name === 'FullName')!.choiceGroup);
    // NameFilter lives inside a nested choice of the filter branch
    expect(name.choicePath?.length).toBeGreaterThanOrEqual(2);
  });

  it('describes simpleContent attributes and object attributes', () => {
    const dataRow = catalog.objects.DataRow!;
    expect(dataRow.attributes?.map((a) => a.name)).toContain('rowNumber');
    const rq = catalog.objects.CustomerQueryRq!;
    expect(rq.attributes?.find((a) => a.name === 'iterator')?.enum).toEqual([
      'Start',
      'Continue',
      'Stop',
    ]);
  });
});

describe('catalog.requests', () => {
  it('derives op, entity, body/ret elements and iterator support', () => {
    expect(catalog.requests.CustomerAddRq).toMatchObject({
      response: 'CustomerAddRs',
      op: 'Add',
      entity: 'Customer',
      bodyElement: 'CustomerAdd',
      retElement: 'CustomerRet',
      supportsIterator: false,
    });
    expect(catalog.requests.InvoiceModRq).toMatchObject({
      op: 'Mod',
      bodyElement: 'InvoiceMod',
      retElement: 'InvoiceRet',
    });
    expect(catalog.requests.InvoiceQueryRq).toMatchObject({
      op: 'Query',
      entity: 'Invoice',
      supportsIterator: true,
    });
    expect(catalog.requests.InvoiceQueryRq!.filters).toEqual(
      expect.arrayContaining(['TxnID', 'RefNumber', 'ModifiedDateRangeFilter', 'EntityFilter']),
    );
    expect(catalog.requests.ListDelRq).toMatchObject({ op: 'Del', response: 'ListDelRs' });
    expect(catalog.requests.TxnVoidRq).toMatchObject({ op: 'Void' });
    expect(catalog.requests.ItemQueryRq!.retElements).toEqual(
      expect.arrayContaining(['ItemServiceRet', 'ItemInventoryRet']),
    );
    expect(catalog.requests.ItemQueryRq!.retElement).toBeUndefined();
    expect(catalog.requests.DataEventSubscriptionAddRq!.msgSet).toBe('QBXMLSubscriptionMsgsRq');
    expect(catalog.requests.GeneralSummaryReportQueryRq).toMatchObject({
      op: 'Query',
      retElement: 'ReportRet',
    });
    expect(catalog.requests.GeneralSummaryReportQueryRq!.entity).toBeUndefined();
  });

  it('every request has a response', () => {
    for (const r of Object.values(catalog.requests)) expect(r.response, r.name).toMatch(/Rs$/);
  });
});

describe('catalog.entities', () => {
  it("prefers the entity's own Add/Mod/Query request over another that returns the same Ret", () => {
    expect(getEntity('Account').ops.add).toBe('AccountAddRq');
    for (const e of Object.values(catalog.entities)) {
      for (const op of ['add', 'mod', 'query'] as const) {
        const own = `${e.name}${op[0]!.toUpperCase()}${op.slice(1)}Rq`;
        if (catalog.requests[own]?.entity === e.name) expect(e.ops[op]).toBe(own);
      }
    }
  });

  it('derives list entities', () => {
    expect(getEntity('Customer')).toMatchObject({
      category: 'list',
      idField: 'ListID',
      ops: {
        add: 'CustomerAddRq',
        mod: 'CustomerModRq',
        query: 'CustomerQueryRq',
        del: 'ListDelRq',
      },
      retElement: 'CustomerRet',
      supportsModifiedFilter: true,
      modifiedFilter: 'FromModifiedDate',
      delType: 'Customer',
    });
    expect(getEntity('ItemService')).toMatchObject({
      category: 'list',
      unionQuery: 'ItemQueryRq',
      delType: 'ItemService',
    });
  });

  it('derives txn entities with void and delete', () => {
    expect(getEntity('Invoice')).toMatchObject({
      category: 'txn',
      idField: 'TxnID',
      ops: {
        add: 'InvoiceAddRq',
        mod: 'InvoiceModRq',
        query: 'InvoiceQueryRq',
        del: 'TxnDelRq',
        void: 'TxnVoidRq',
      },
      supportsModifiedFilter: true,
      modifiedFilter: 'ModifiedDateRangeFilter',
      delType: 'Invoice',
      voidType: 'Invoice',
    });
    expect(getEntity('ReceivePayment').ops.void).toBeUndefined();
    expect(getEntity('ReceivePayment').ops.del).toBe('TxnDelRq');
  });

  it('has "other" entities without an id field and excludes report/deleted rets', () => {
    expect(getEntity('Company')).toMatchObject({ category: 'other', idField: null });
    expect(catalog.entities.Report).toBeUndefined();
    expect(catalog.entities.ListDeleted).toBeUndefined();
    expect(() => getEntity('Custmer')).toThrow(/did you mean "Customer"/);
  });

  it('every entity ret element exists and core entities are present', () => {
    for (const e of Object.values(catalog.entities))
      expect(catalog.objects[e.retElement], e.name).toBeDefined();
    for (const n of [
      'Customer',
      'Vendor',
      'Employee',
      'Account',
      'ItemInventory',
      'Invoice',
      'Bill',
      'Check',
      'JournalEntry',
      'SalesReceipt',
      'ReceivePayment',
      'Deposit',
      'PurchaseOrder',
    ]) {
      expect(catalog.entities[n], n).toBeDefined();
    }
  });
});
