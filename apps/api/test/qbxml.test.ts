import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getCommand, listAudit } from '@qbv/db';
import { buildBatch, buildRequest, buildResponse } from '@qbv/qbxml';
import { RELAY_QUEUE } from '@qbv/queue';
import { Queue } from 'bullmq';
import { permissionsForRequest, rawRequestAccess } from '../src/lib/raw-permissions.js';
import { requestNames } from '../src/routes/qbxml.js';
import {
  bearer,
  commandCount,
  createTestApp,
  createToken,
  expectXsdValid,
  startFakeWorker,
  userSession,
  type TestApp,
} from './helpers.js';

let t: TestApp;
let token: string;
beforeAll(async () => {
  t = await createTestApp();
  token = (await createToken(t.db, ['qbxml:raw', 'object:Customer:write'])).token;
});
afterAll(async () => t?.close());

const xmlHeaders = () => ({ ...bearer(token), 'content-type': 'application/xml' });

describe('POST /qbxml validation', () => {
  it('rejects XSD-invalid documents with libxml2 errors and line numbers; nothing is queued', async () => {
    const before = await commandCount(t.db);
    // Out of sequence: the schema puts MaxReturned before ActiveStatus.
    const bad = `<?xml version="1.0"?>
<?qbxml version="16.0"?>
<QBXML>
  <QBXMLMsgsRq onError="stopOnError">
    <CustomerQueryRq>
      <ActiveStatus>All</ActiveStatus>
      <MaxReturned>10</MaxReturned>
    </CustomerQueryRq>
  </QBXMLMsgsRq>
</QBXML>`;
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/qbxml',
      headers: xmlHeaders(),
      payload: bad,
    });
    expect(res.statusCode).toBe(400);
    const err = res.json().error;
    expect(err.code).toBe('qbxml_invalid');
    expect(err.details.errors[0].line).toBe(7);
    expect(err.details.errors[0].message).toMatch(/MaxReturned/);

    const unknown = bad.replace('<ActiveStatus>All</ActiveStatus>', '<Bogus>1</Bogus>');
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/qbxml',
          headers: xmlHeaders(),
          payload: unknown,
        })
      ).statusCode,
    ).toBe(400);

    const malformed = await t.app.inject({
      method: 'POST',
      url: '/api/qbxml',
      headers: xmlHeaders(),
      payload: '<QBXML><QBXMLMsgsRq>',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe('qbxml_invalid');

    const empty = await t.app.inject({
      method: 'POST',
      url: '/api/qbxml',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { qbxml: '  ' },
    });
    expect(empty.statusCode).toBe(400);
    expect(await commandCount(t.db)).toBe(before);
  });

  it('rejects a valid response document (not a request)', async () => {
    const rs = buildResponse([{ rs: 'HostQueryRs', statusCode: 0, statusMessage: 'Status OK' }]);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/qbxml',
      headers: xmlHeaders(),
      payload: rs,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('qbxml_not_request');
  });

  it('requires qbxml:raw', async () => {
    const s = await userSession(t, { roles: ['Accountant'] });
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/qbxml',
      headers: { ...s.headers(), 'content-type': 'application/xml' },
      payload: buildRequest('HostQueryRq', {}),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /qbxml/validate', () => {
  it('reports XSD validity without queueing anything', async () => {
    const before = await commandCount(t.db);
    const good = buildRequest('CustomerQueryRq', { MaxReturned: 5 });
    const ok = await t.app.inject({
      method: 'POST',
      url: '/api/qbxml/validate',
      headers: xmlHeaders(),
      payload: good,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({
      valid: true,
      errors: [],
      requests: ['CustomerQueryRq'],
      version: '16.0',
      access: [{ name: 'CustomerQueryRq', permissions: ['object:Customer:read'], allowed: true }],
    });

    const bad = good.replace('<MaxReturned>', '<Bogus>1</Bogus><MaxReturned>');
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/qbxml/validate',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: { qbxml: bad },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.valid).toBe(false);
    expect(body.errors[0].line).toBeGreaterThan(0);
    expect(body.errors[0].message).toMatch(/Bogus/);
    expect(await commandCount(t.db)).toBe(before);
  });

  it('requires qbxml:raw', async () => {
    const other = (await createToken(t.db, ['object:*:read'])).token;
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/qbxml/validate',
      headers: { ...bearer(other), 'content-type': 'application/xml' },
      payload: buildRequest('CustomerQueryRq', {}),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /qbxml execution', () => {
  it('?wait=false queues a raw command at priority 2 and audits it', async () => {
    const xml = buildRequest('CustomerQueryRq', { MaxReturned: 5 });
    expectXsdValid(xml);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/qbxml?wait=false',
      headers: xmlHeaders(),
      payload: xml,
    });
    expect(res.statusCode).toBe(202);
    const id = res.json().commandId as string;
    expect(res.headers['x-command-id']).toBe(id);
    const cmd = (await getCommand(t.db, id))!;
    expect(cmd).toMatchObject({
      kind: 'raw',
      priority: 2,
      rq_name: 'CustomerQueryRq',
      object_type: 'Customer',
      actor_type: 'token',
      request_xml: xml,
    });
    const queue = new Queue(RELAY_QUEUE, { connection: t.deps.redis, prefix: t.prefix });
    expect((await queue.getJob(id))?.opts.priority).toBe(2);
    await queue.close();
    const audit = await listAudit(t.db, { commandId: id });
    expect(audit[0]).toMatchObject({
      action: 'qbxml.raw',
      detail: { requests: ['CustomerQueryRq'], writes: false },
    });
  });

  it('returns QuickBooks’ response XML, or JSON with parsed responses', async () => {
    const fw = startFakeWorker(t);
    try {
      const xml = buildRequest('CustomerQueryRq', { MaxReturned: 1 });
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/qbxml',
        headers: xmlHeaders(),
        payload: xml,
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/xml/);
      expect(res.body).toContain('<CustomerQueryRs');
      expectXsdValid(res.body);

      const batch = buildBatch(
        [
          { rq: 'CustomerQueryRq', body: { MaxReturned: 1 } },
          { rq: 'CustomerAddRq', body: { Name: 'Raw Co' } },
        ],
        'continueOnError',
      );
      const j = await t.app.inject({
        method: 'POST',
        url: '/api/qbxml',
        headers: {
          ...bearer(token),
          'content-type': 'application/json',
          accept: 'application/json',
        },
        payload: { qbxml: batch },
      });
      expect(j.statusCode, j.body).toBe(200);
      const body = j.json();
      expect(body.responses.map((r: { name: string }) => r.name)).toEqual([
        'CustomerQueryRs',
        'CustomerAddRs',
      ]);
      expect(body.responses[1].rets[0].Name).toBeTruthy();
      const audit = await listAudit(t.db, { commandId: body.commandId });
      expect(audit[0]!.detail).toMatchObject({ writes: true });
      expect(fw.invalid).toEqual([]);
    } finally {
      await fw.close();
    }
  });
});

describe('requestNames', () => {
  it('lists requests in order, skipping message sets', () => {
    const xml = buildBatch([{ rq: 'HostQueryRq' }, { rq: 'CompanyQueryRq' }], 'stopOnError');
    expect(requestNames(xml)).toEqual(['HostQueryRq', 'CompanyQueryRq']);
  });
});

const noPi = (version: string | null) => {
  const xml = buildRequest('CustomerQueryRq', { MaxReturned: 1 });
  const stripped = xml.replace(/<\?qbxml version="[^"]*"\?>\n?/, '');
  return version === null
    ? stripped
    : stripped.replace('<QBXML>', `<?qbxml version="${version}"?>\n<QBXML>`);
};

describe('qbXML version instruction', () => {
  it('POST /qbxml/validate reports a missing or unsupported version', async () => {
    for (const [doc, re] of [
      [noPi(null), /Missing <\?qbxml version/],
      [noPi('99.0'), /Unsupported qbXML version "99.0"/],
    ] as const) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/qbxml/validate',
        headers: xmlHeaders(),
        payload: doc,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.valid).toBe(false);
      expect(body.errors.map((e: { message: string }) => e.message).join('\n')).toMatch(re);
    }
  });

  it('POST /qbxml rejects a missing or unsupported version with 400; nothing is queued', async () => {
    const before = await commandCount(t.db);
    for (const doc of [noPi(null), noPi('99.0'), noPi('16')]) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/qbxml?wait=false',
        headers: xmlHeaders(),
        payload: doc,
      });
      expect(res.statusCode, doc).toBe(400);
      expect(res.json().error.code).toBe('qbxml_invalid');
    }
    expect(await commandCount(t.db)).toBe(before);
    const ok = await t.app.inject({
      method: 'POST',
      url: '/api/qbxml?wait=false',
      headers: xmlHeaders(),
      payload: noPi('13.0'),
    });
    expect(ok.statusCode).toBe(202);
  });
});

describe('POST /qbxml permissions', () => {
  const post = (tok: string, xml: string) =>
    t.app.inject({
      method: 'POST',
      url: '/api/qbxml?wait=false',
      headers: { ...bearer(tok), 'content-type': 'application/xml' },
      payload: xml,
    });

  it('qbxml:raw alone cannot read or write entities', async () => {
    const before = await commandCount(t.db);
    const raw = (await createToken(t.db, ['qbxml:raw'])).token;
    const add = buildRequest('CustomerAddRq', { CustomerAdd: { Name: 'Raw Only' } });
    expectXsdValid(add);
    const res = await post(raw, add);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.details.permission).toBe('object:Customer:write');
    expect((await post(raw, buildRequest('CustomerQueryRq', {}))).statusCode).toBe(403);
    expect(await commandCount(t.db)).toBe(before);
  });

  it('checks every request in a batch, including Del/Void types', async () => {
    const tok = (await createToken(t.db, ['qbxml:raw', 'object:Customer:write'])).token;
    const batch = buildBatch(
      [
        { rq: 'CustomerQueryRq', body: { MaxReturned: 1 } },
        { rq: 'VendorAddRq', body: { VendorAdd: { Name: 'No Vendor Perm' } } },
      ],
      'stopOnError',
    );
    expectXsdValid(batch);
    const res = await post(tok, batch);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.details.permission).toBe('object:Vendor:write');

    const delCustomer = buildRequest('ListDelRq', { ListDelType: 'Customer', ListID: '80-1' });
    expectXsdValid(delCustomer);
    expect((await post(tok, delCustomer)).statusCode).toBe(202);
    const delVendor = buildRequest('ListDelRq', { ListDelType: 'Vendor', ListID: '80-1' });
    expect((await post(tok, delVendor)).statusCode).toBe(403);
    const voidInvoice = buildRequest('TxnVoidRq', { TxnVoidType: 'Invoice', TxnID: '1-1' });
    expectXsdValid(voidInvoice);
    expect((await post(tok, voidInvoice)).statusCode).toBe(403);
  });

  it('reports need report:*, and UI/command requests need admin', async () => {
    const tok = (await createToken(t.db, ['qbxml:raw', 'object:*:write'])).token;
    const report = buildRequest('GeneralSummaryReportQueryRq', {
      GeneralSummaryReportType: 'ProfitAndLossStandard',
    });
    expectXsdValid(report);
    expect((await post(tok, report)).statusCode).toBe(403);
    const display = buildRequest('ListDisplayModRq', {
      ListDisplayModType: 'Customer',
      ListID: '1',
    });
    expectXsdValid(display);
    expect((await post(tok, display)).statusCode).toBe(403);
    const admin = (await createToken(t.db, ['admin'])).token;
    expect((await post(admin, display)).statusCode).toBe(202);
  });

  it('maps requests to permissions', () => {
    expect(permissionsForRequest('ItemQueryRq', '')).toContain('object:ItemService:read');
    expect(permissionsForRequest('TransactionQueryRq', '')).toEqual(['object:*:read']);
    expect(permissionsForRequest('ListMergeRq', '<ListMergeType>Vendor</ListMergeType>')).toEqual([
      'object:Vendor:write',
    ]);
    expect(permissionsForRequest('ClearedStatusModRq', '')).toEqual(['object:*:write']);
    expect(permissionsForRequest('DataExtDelRq', '')).toEqual(['object:DataExt:write']);
    expect(permissionsForRequest('QBCommandExecRq', '')).toEqual(['admin']);
    expect(permissionsForRequest('SubscriptionDelRq', '')).toEqual(['admin']);
    expect(permissionsForRequest('NotARealRq', '')).toEqual(['admin']);
    const xml = buildBatch(
      [{ rq: 'HostQueryRq' }, { rq: 'TxnDelRq', body: { TxnDelType: 'Bill', TxnID: '1-1' } }],
      'stopOnError',
    );
    expect(rawRequestAccess(xml)).toEqual([
      { name: 'HostQueryRq', permissions: ['object:Host:read'] },
      { name: 'TxnDelRq', permissions: ['object:Bill:write'] },
    ]);
  });
});
