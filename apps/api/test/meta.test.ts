import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalog } from '@qbv/qbxml';
import { refTargets } from '../src/lib/meta.js';
import { bearer, createTestApp, createToken, type TestApp } from './helpers.js';

let t: TestApp;
let token: string;
beforeAll(async () => {
  t = await createTestApp();
  token = (await createToken(t.db, ['object:Customer:write'])).token;
});
afterAll(async () => t?.close());

const get = (url: string) => t.app.inject({ method: 'GET', url, headers: bearer(token) });

describe('/meta', () => {
  it('lists every catalog entity with ops and the caller’s access', async () => {
    const res = await get('/api/meta/entities');
    expect(res.statusCode).toBe(200);
    const { entities, version } = res.json();
    expect(version).toBe(catalog.version);
    expect(entities).toHaveLength(Object.keys(catalog.entities).length);
    const customer = entities.find((e: { name: string }) => e.name === 'Customer');
    expect(customer).toMatchObject({
      category: 'list',
      idField: 'ListID',
      ops: {
        add: 'CustomerAddRq',
        mod: 'CustomerModRq',
        query: 'CustomerQueryRq',
        del: 'ListDelRq',
      },
      access: { read: true, write: true },
      listable: true,
    });
    const invoice = entities.find((e: { name: string }) => e.name === 'Invoice');
    expect(invoice.access).toEqual({ read: false, write: false });
    expect(invoice.voidType).toBe('Invoice');
  });

  it('describes one entity: fields in schema order, types, lengths, enums and refs', async () => {
    const res = await get('/api/meta/entities/Invoice');
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.roots).toEqual({
      add: 'InvoiceAdd',
      mod: 'InvoiceMod',
      ret: 'InvoiceRet',
      query: 'InvoiceQueryRq',
    });
    expect(d.requests.add.name).toBe('InvoiceAddRq');
    const add = d.objects.InvoiceAdd;
    expect(add.fields.map((f: { name: string }) => f.name)).toEqual(
      catalog.objects.InvoiceAdd!.fields.map((f) => f.name),
    );
    const cref = add.fields.find((f: { name: string }) => f.name === 'CustomerRef');
    expect(cref).toMatchObject({
      kind: 'complex',
      children: 'CustomerRef',
      minOccurs: 1,
      ref: ['Customer'],
    });
    expect(
      d.objects.CustomerRef.fields.find((f: { name: string }) => f.name === 'FullName').maxLength,
    ).toBeGreaterThan(0);
    const line = d.objects.InvoiceLineAdd.fields.find(
      (f: { name: string }) => f.name === 'ItemRef',
    );
    expect(line.ref).toEqual(
      expect.arrayContaining(['ItemService', 'ItemInventory', 'ItemNonInventory']),
    );
    expect(line.ref).not.toContain('ItemReceipt');
    const ar = add.fields.find((f: { name: string }) => f.name === 'ARAccountRef');
    expect(ar.ref).toEqual(['Account']);
    // Enums survive.
    const anyEnum = Object.values(d.objects as Record<string, { fields: { enum?: string[] }[] }>)
      .flatMap((o) => o.fields)
      .find((f) => f.enum && f.enum.length);
    expect(anyEnum).toBeTruthy();
  });

  it('resolves ParentRef to the entity itself', async () => {
    const d = (await get('/api/meta/entities/Customer')).json();
    const parent = d.objects.CustomerAdd.fields.find(
      (f: { name: string }) => f.name === 'ParentRef',
    );
    expect(parent.ref).toEqual(['Customer']);
  });

  it('404s unknown entities and objects', async () => {
    expect((await get('/api/meta/entities/Nope')).statusCode).toBe(404);
    expect((await get('/api/meta/objects/Nope')).statusCode).toBe(404);
  });

  it('lists requests and serves single objects for the qbXML console', async () => {
    const r = (await get('/api/meta/requests')).json();
    expect(r.requests.length).toBe(Object.keys(catalog.requests).length);
    const o = (await get('/api/meta/objects/HostQueryRq')).json();
    expect(o.root).toBe('HostQueryRq');
    expect(o.request.response).toBe('HostQueryRs');
  });

  it('requires authentication', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/meta/entities' })).statusCode).toBe(401);
  });
});

describe('refTargets', () => {
  it('maps reference fields onto entities', () => {
    const f = (name: string) => ({
      name,
      kind: 'complex' as const,
      type: name,
      children: name,
      minOccurs: 0,
      maxOccurs: 1 as const,
    });
    expect(refTargets(f('VendorRef'))).toEqual(['Vendor']);
    expect(refTargets(f('TermsRef'))).toEqual(['StandardTerms', 'DateDrivenTerms']);
    expect(refTargets(f('EntityRef'))).toEqual(['Customer', 'Vendor', 'Employee', 'OtherName']);
    expect(refTargets(f('DepositToAccountRef'))).toEqual(['Account']);
    expect(refTargets(f('ParentRef'), 'Class')).toEqual(['Class']);
    expect(refTargets({ ...f('Name'), kind: 'simple', children: undefined })).toBeUndefined();
  });
});
