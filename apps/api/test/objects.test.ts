import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getCommand, listAudit, upsertObjects } from '@qbv/db';
import { catalog } from '@qbv/qbxml';
import { RELAY_QUEUE } from '@qbv/queue';
import { Queue } from 'bullmq';
import {
  commandCount,
  createTestApp,
  expectXsdValid,
  sampleRet,
  startFakeWorker,
  userSession,
  type Session,
  type TestApp,
} from './helpers.js';

let t: TestApp;
let acct: Session;
let readOnly: Session;

beforeAll(async () => {
  t = await createTestApp();
  acct = await userSession(t, { roles: ['Accountant'] });
  readOnly = await userSession(t, { roles: ['ReadOnly'] });
  const customers = [
    sampleRet('Customer', {
      ListID: '80000001-1',
      Name: 'Acme Corp',
      FullName: 'Acme Corp',
      CompanyName: 'Acme',
    }),
    sampleRet('Customer', { ListID: '80000002-1', Name: 'Beta LLC', FullName: 'Beta LLC' }),
    sampleRet('Customer', {
      ListID: '80000003-1',
      Name: 'Gamma Inc',
      FullName: 'Gamma Inc',
      IsActive: 'false',
    }),
  ];
  await upsertObjects(t.db, catalog.entities.Customer!, customers);
  const invoices = Array.from({ length: 7 }, (_, i) =>
    sampleRet('Invoice', {
      TxnID: `${100 + i}-1`,
      RefNumber: `INV-${1000 + i}`,
      TxnDate: `2024-03-0${i + 1}`,
      CustomerRef: {
        ListID: i % 2 ? '80000001-1' : '80000002-1',
        FullName: i % 2 ? 'Acme Corp' : 'Beta LLC',
      },
      Subtotal: `${(i + 1) * 100}.00`,
      BalanceRemaining: `${(i + 1) * 100}.00`,
    }),
  );
  await upsertObjects(t.db, catalog.entities.Invoice!, invoices);
});
afterAll(async () => t?.close());

const get = (s: Session, url: string) =>
  t.app.inject({ method: 'GET', url, headers: s.headers(false) });

describe('GET /objects/:type', () => {
  it('lists active objects sorted by name by default', async () => {
    const res = await get(readOnly, '/api/objects/Customer');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.items.map((i: { name: string }) => i.name)).toEqual(['Acme Corp', 'Beta LLC']);
    expect(body.items[0]).toMatchObject({
      type: 'Customer',
      id: '80000001-1',
      editSequence: '1700000000',
      isActive: true,
    });
    expect(body.items[0].data.CompanyName).toBe('Acme');
  });

  it('includes inactive objects on request', async () => {
    const res = await get(readOnly, '/api/objects/Customer?includeInactive=true');
    expect(res.json().total).toBe(3);
  });

  it('pages, sorts and filters', async () => {
    const p1 = (await get(readOnly, '/api/objects/Invoice?sort=-TxnDate&page=1&pageSize=3')).json();
    expect(p1.total).toBe(7);
    expect(p1.items.map((i: { refNumber: string }) => i.refNumber)).toEqual([
      'INV-1006',
      'INV-1005',
      'INV-1004',
    ]);
    const p3 = (await get(readOnly, '/api/objects/Invoice?sort=-TxnDate&page=3&pageSize=3')).json();
    expect(p3.items).toHaveLength(1);

    const acme = (
      await get(readOnly, '/api/objects/Invoice?filter[CustomerRef.ListID]=80000001-1')
    ).json();
    expect(acme.total).toBe(3);
    const range = (
      await get(
        readOnly,
        `/api/objects/Invoice?filter[TxnDate]=${encodeURIComponent('gte:2024-03-05')}&sort=TxnDate`,
      )
    ).json();
    expect(range.items.map((i: { txnDate: string }) => i.txnDate)).toEqual([
      '2024-03-05',
      '2024-03-06',
      '2024-03-07',
    ]);
  });

  it('full-text searches', async () => {
    const res = (await get(readOnly, '/api/objects/Invoice?q=1003')).json();
    expect(res.items.map((i: { refNumber: string }) => i.refNumber)).toEqual(['INV-1003']);
    const cust = (await get(readOnly, '/api/objects/Customer?q=acm')).json();
    expect(cust.items.map((i: { name: string }) => i.name)).toEqual(['Acme Corp']);
  });

  it('rejects bad filters and query parameters with 400', async () => {
    const bad = await get(readOnly, '/api/objects/Invoice?filter[TxnDate]=gte:yesterday');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('invalid_query');
    const field = await get(
      readOnly,
      `/api/objects/Invoice?filter[${encodeURIComponent("x'; drop")}]=1`,
    );
    expect(field.statusCode).toBe(400);
    const size = await get(readOnly, '/api/objects/Invoice?pageSize=10000');
    expect(size.statusCode).toBe(400);
    expect(size.json().error.code).toBe('validation_error');
  });

  it('404s unknown types with a hint', async () => {
    const res = await get(readOnly, '/api/objects/Custmer');
    // ReadOnly holds object:*:read, so the type check is what fails.
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('unknown_type');
    expect(res.json().error.message).toContain('Customer');
  });
});

describe('GET /objects/:type/:id', () => {
  it('returns one object', async () => {
    const res = await get(readOnly, '/api/objects/Customer/80000001-1');
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Acme Corp');
  });
  it('404s missing objects', async () => {
    expect((await get(readOnly, '/api/objects/Customer/nope')).statusCode).toBe(404);
  });
});

describe('writes are XSD-validated commands', () => {
  it('Add: builds a valid CustomerAddRq, stores the command, queues the job at priority 1 and audits', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/objects/Customer',
      headers: acct.headers(),
      // Keys deliberately out of schema order; the builder reorders them.
      payload: { Email: 'ap@delta.example', CompanyName: 'Delta & Sons', Name: 'Delta' },
    });
    expect(res.statusCode, res.body).toBe(202);
    const { commandId, status } = res.json();
    expect(status).toBe('queued');
    const cmd = (await getCommand(t.db, commandId))!;
    expect(cmd).toMatchObject({
      kind: 'add',
      rq_name: 'CustomerAddRq',
      object_type: 'Customer',
      priority: 1,
      actor_type: 'user',
      actor_id: acct.userId,
    });
    expectXsdValid(cmd.request_xml);
    expect(cmd.request_xml).toMatch(
      /<Name>Delta<\/Name>[\s\S]*<CompanyName>Delta &amp; Sons<\/CompanyName>[\s\S]*<Email>/,
    );
    expect(cmd.request_xml).toContain('<?qbxml version="16.0"?>');

    const queue = new Queue(RELAY_QUEUE, { connection: t.deps.redis, prefix: t.prefix });
    const job = await queue.getJob(commandId);
    expect(job?.data).toEqual({ commandId });
    expect(job?.opts.priority).toBe(1);
    await queue.close();

    const audit = await listAudit(t.db, { commandId });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'object.add',
      object_type: 'Customer',
      actor_id: acct.userId,
    });
  });

  it('Add accepts the wrapped form too', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/objects/Invoice',
      headers: acct.headers(),
      payload: {
        InvoiceAdd: {
          CustomerRef: { FullName: 'Acme Corp' },
          TxnDate: '2024-04-01',
          InvoiceLineAdd: [
            { ItemRef: { FullName: 'Consulting' }, Quantity: 10, Rate: 150 },
            { ItemRef: { FullName: 'Travel' }, Amount: 99.5 },
          ],
        },
      },
    });
    expect(res.statusCode, res.body).toBe(202);
    const cmd = (await getCommand(t.db, res.json().commandId))!;
    expectXsdValid(cmd.request_xml);
    expect(cmd.request_xml).toContain('<Amount>99.50</Amount>');
  });

  it('invalid bodies return 400 with the errors and are never stored or queued', async () => {
    const before = await commandCount(t.db);
    const cases = [
      { Name: 'x'.repeat(42) }, // too long (maxLength 41)
      { Name: 'Ok', Nmae: 'typo' }, // unknown field
      { CompanyName: 'No name' }, // missing required Name
      { Name: 'Ok', IsActive: 'maybe' }, // bad boolean
    ];
    for (const payload of cases) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/objects/Customer',
        headers: acct.headers(),
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      const err = res.json().error;
      expect(err.code).toBe('qbxml_invalid');
      expect(Array.isArray(err.details.errors)).toBe(true);
      expect(err.details.errors.length).toBeGreaterThan(0);
    }
    const hint = await t.app.inject({
      method: 'POST',
      url: '/api/objects/Customer',
      headers: acct.headers(),
      payload: { Name: 'Ok', Nmae: 'typo' },
    });
    expect(hint.json().error.message).toMatch(/Nmae/);
    expect(await commandCount(t.db)).toBe(before);
  });

  it('Mod requires EditSequence, takes the id from the URL and validates', async () => {
    const missing = await t.app.inject({
      method: 'PATCH',
      url: '/api/objects/Customer/80000001-1',
      headers: acct.headers(),
      payload: { Phone: '555' },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('edit_sequence_required');

    const mismatch = await t.app.inject({
      method: 'PATCH',
      url: '/api/objects/Customer/80000001-1',
      headers: acct.headers(),
      payload: { ListID: 'other', EditSequence: '1' },
    });
    expect(mismatch.json().error.code).toBe('id_mismatch');

    const res = await t.app.inject({
      method: 'PATCH',
      url: '/api/objects/Customer/80000001-1',
      headers: acct.headers(),
      payload: { Phone: '555-0100', EditSequence: '1700000000' },
    });
    expect(res.statusCode, res.body).toBe(202);
    const cmd = (await getCommand(t.db, res.json().commandId))!;
    expect(cmd).toMatchObject({ kind: 'mod', rq_name: 'CustomerModRq', object_id: '80000001-1' });
    expectXsdValid(cmd.request_xml);
    expect(cmd.request_xml).toMatch(
      /<CustomerMod>\s*<ListID>80000001-1<\/ListID>\s*<EditSequence>1700000000<\/EditSequence>/,
    );
  });

  it('Delete builds ListDelRq / TxnDelRq', async () => {
    const c = await t.app.inject({
      method: 'DELETE',
      url: '/api/objects/Customer/80000002-1',
      headers: acct.headers(),
    });
    expect(c.statusCode).toBe(202);
    const cc = (await getCommand(t.db, c.json().commandId))!;
    expectXsdValid(cc.request_xml);
    expect(cc.request_xml).toMatch(
      /<ListDelType>Customer<\/ListDelType>\s*<ListID>80000002-1<\/ListID>/,
    );

    const i = await t.app.inject({
      method: 'DELETE',
      url: '/api/objects/Invoice/100-1',
      headers: acct.headers(),
    });
    const ic = (await getCommand(t.db, i.json().commandId))!;
    expectXsdValid(ic.request_xml);
    expect(ic).toMatchObject({ kind: 'del', rq_name: 'TxnDelRq' });

    // Clients that send `Content-Type: application/json` with no body are accepted.
    const j = await t.app.inject({
      method: 'DELETE',
      url: '/api/objects/Invoice/102-1',
      headers: { ...acct.headers(), 'content-type': 'application/json' },
    });
    expect(j.statusCode).toBe(202);
    expectXsdValid((await getCommand(t.db, j.json().commandId))!.request_xml);
  });

  it('Void builds TxnVoidRq and is refused for lists', async () => {
    const v = await t.app.inject({
      method: 'POST',
      url: '/api/objects/Invoice/101-1/void',
      headers: acct.headers(),
    });
    expect(v.statusCode).toBe(202);
    const vc = (await getCommand(t.db, v.json().commandId))!;
    expectXsdValid(vc.request_xml);
    expect(vc.request_xml).toMatch(/<TxnVoidType>Invoice<\/TxnVoidType>\s*<TxnID>101-1<\/TxnID>/);

    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/objects/Customer/80000001-1/void',
      headers: acct.headers(),
    });
    expect(bad.statusCode).toBe(405);
    expect(bad.json().error.code).toBe('operation_not_supported');
  });

  it('read-only users cannot write', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/objects/Customer',
      headers: readOnly.headers(),
      payload: { Name: 'Nope' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({
      code: 'forbidden',
      details: { permission: 'object:Customer:write' },
    });
  });
});

describe('?wait=true', () => {
  it('returns the finished command and the written-through object', async () => {
    const fw = startFakeWorker(t, () => ({
      kind: 'succeed',
      ret: sampleRet('Customer', { ListID: '80000099-1', Name: 'Waited', FullName: 'Waited' }),
    }));
    try {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/objects/Customer?wait=true',
        headers: acct.headers(),
        payload: { Name: 'Waited' },
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body.status).toBe('succeeded');
      expect(body.object).toMatchObject({ id: '80000099-1', name: 'Waited' });
      expect(fw.invalid).toEqual([]);
      expect(fw.seen.length).toBeGreaterThan(0);
      for (const c of fw.seen) expectXsdValid(c.request_xml);
    } finally {
      await fw.close();
    }
  });

  it('maps a 3200 conflict to 409 and a QuickBooks error to 422', async () => {
    const fw = startFakeWorker(t, (c) =>
      c.kind === 'mod'
        ? { kind: 'conflict' }
        : {
            kind: 'fail',
            statusCode: 3100,
            message: 'The name "Dup" of the list element is already in use.',
          },
    );
    try {
      const mod = await t.app.inject({
        method: 'PATCH',
        url: '/api/objects/Customer/80000001-1?wait=true',
        headers: acct.headers(),
        payload: { EditSequence: 'old', Phone: '1' },
      });
      expect(mod.statusCode, mod.body).toBe(409);
      expect(mod.json().error).toMatchObject({ code: 'conflict', details: { statusCode: 3200 } });

      const add = await t.app.inject({
        method: 'POST',
        url: '/api/objects/Customer?wait=true',
        headers: acct.headers(),
        payload: { Name: 'Dup' },
      });
      expect(add.statusCode).toBe(422);
      expect(add.json().error).toMatchObject({ code: 'qb_error', details: { statusCode: 3100 } });
    } finally {
      await fw.close();
    }
  });
});

describe('write rate limit', () => {
  it('limits writes per user', async () => {
    const t2 = await createTestApp({ env: { RATE_LIMIT_WRITES_PER_MIN: '2' } });
    try {
      const s = await userSession(t2, { roles: ['Accountant'] });
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await t2.app.inject({
          method: 'POST',
          url: '/api/objects/Customer',
          headers: s.headers(),
          payload: { Name: `N${i}` },
        });
        codes.push(r.statusCode);
      }
      expect(codes).toEqual([202, 202, 429]);
      // Another user has their own bucket.
      const other = await userSession(t2, { roles: ['Accountant'] });
      const r = await t2.app.inject({
        method: 'POST',
        url: '/api/objects/Customer',
        headers: other.headers(),
        payload: { Name: 'Other' },
      });
      expect(r.statusCode).toBe(202);
    } finally {
      await t2.close();
    }
  });
});
