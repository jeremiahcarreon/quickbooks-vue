import { describe, expect, it } from 'vitest';
import {
  editSequenceOf,
  entityForRet,
  entityOfRet,
  getEntity,
  idOf,
  nameOf,
  queryableEntities,
  refId,
} from '../src/index.js';

describe('entity helpers', () => {
  it('idOf uses the entity idField', () => {
    expect(idOf('Customer', { ListID: '80000001-1', TxnID: 'nope' })).toBe('80000001-1');
    expect(idOf('Invoice', { TxnID: '1A-1' })).toBe('1A-1');
    expect(idOf(getEntity('Bill'), { TxnID: { '#text': '2B-2' } })).toBe('2B-2');
    expect(idOf('Company', { CompanyName: 'x' })).toBeUndefined();
    expect(() => idOf('Nope', {})).toThrow(/Unknown qbXML entity/);
  });

  it('editSequenceOf, nameOf, refId', () => {
    expect(editSequenceOf({ EditSequence: '1700000000' })).toBe('1700000000');
    expect(editSequenceOf({})).toBeUndefined();
    expect(nameOf({ Name: 'Child', FullName: 'Parent:Child' })).toBe('Parent:Child');
    expect(nameOf({ RefNumber: 'INV-1' })).toBe('INV-1');
    expect(refId({ ListID: '80000001-1', FullName: 'A' })).toBe('80000001-1');
    expect(refId(undefined)).toBeUndefined();
  });

  it('maps Ret names to entities', () => {
    expect(entityOfRet('InvoiceRet')?.name).toBe('Invoice');
    expect(entityForRet('CustomerRet')?.name).toBe('Customer');
    expect(entityOfRet('ReportRet')).toBeUndefined();
  });

  it('queryableEntities includes union-query-only entities', () => {
    const names = queryableEntities().map((e) => e.name);
    expect(names).toContain('Customer');
    expect(names).toContain('PayrollItemTax');
  });
});
