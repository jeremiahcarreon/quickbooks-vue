import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getCommand, listAudit, upsertObjects } from '@qbv/db';
import { catalog, minimalObject } from '@qbv/qbxml';
import { actionRequests } from '../src/routes/actions.js';
import {
  bearer,
  commandCount,
  createTestApp,
  createToken,
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
  await upsertObjects(t.db, catalog.entities.Customer!, [
    sampleRet('Customer', { ListID: '80000101-1', Name: 'Merge From', EditSequence: '111' }),
    sampleRet('Customer', { ListID: '80000102-1', Name: 'Merge To', EditSequence: '222' }),
  ]);
});
afterAll(async () => t?.close());

const json = (s: Session) => ({ ...s.headers(), 'content-type': 'application/json' });

describe('GET /actions', () => {
  it('lists every SDK request that has no object route, with permissions', async () => {
    const names = actionRequests().map((r) => r.name);
    for (const n of [
      'ListMergeRq',
      'ClearedStatusModRq',
      'SpecialAccountAddRq',
      'SpecialItemAddRq',
      'TxnDisplayAddRq',
      'TxnDisplayModRq',
      'ListDisplayAddRq',
      'ListDisplayModRq',
      'DataExtDelRq',
      'DataExtDefDelRq',
      'AlertDelRq',
      'SubscriptionDelRq',
      'DataEventRecoveryInfoDelRq',
      'QBCommandExecRq',
      'TransactionQueryRq',
    ]) {
      expect(names, n).toContain(n);
    }
    expect(names).not.toContain('CustomerAddRq');
    expect(names.some((n) => n.endsWith('ReportQueryRq'))).toBe(false);

    const res = await t.app.inject({
      method: 'GET',
      url: '/api/actions',
      headers: readOnly.headers(false),
    });
    expect(res.statusCode).toBe(200);
    const byName = new Map(
      (res.json().actions as { name: string; allowed: boolean; permissions: string[] }[]).map(
        (a) => [a.name, a],
      ),
    );
    expect(byName.get('TransactionQueryRq')).toMatchObject({ allowed: true });
    expect(byName.get('SpecialAccountAddRq')).toMatchObject({
      permissions: ['object:Account:write'],
      allowed: false,
    });
    expect(byName.get('QBCommandExecRq')).toMatchObject({ permissions: ['admin'] });
  });
});

describe('POST /actions/:request', () => {
  it('validates the body against the XSD before queueing', async () => {
    const before = await commandCount(t.db);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/actions/SpecialAccountAddRq',
      headers: json(acct),
      payload: { SpecialAccountAdd: { SpecialAccountType: 'NotAType' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('qbxml_invalid');
    expect(await commandCount(t.db)).toBe(before);
  });

  it('refuses requests the object routes cover, and unknown names', async () => {
    for (const n of ['CustomerAddRq', 'GeneralSummaryReportQueryRq', 'NopeRq']) {
      const res = await t.app.inject({
        method: 'POST',
        url: `/api/actions/${n}`,
        headers: json(acct),
        payload: {},
      });
      expect(res.statusCode, n).toBe(404);
      expect(res.json().error.code).toBe('unknown_action');
    }
  });

  it('applies the per-request permissions', async () => {
    const before = await commandCount(t.db);
    const ro = await t.app.inject({
      method: 'POST',
      url: '/api/actions/SpecialAccountAddRq',
      headers: json(readOnly),
      payload: { SpecialAccountAdd: { SpecialAccountType: 'UndepositedFunds' } },
    });
    expect(ro.statusCode).toBe(403);
    const exec = await t.app.inject({
      method: 'POST',
      url: '/api/actions/QBCommandExecRq',
      headers: json(acct),
      payload: { QBCommand: 'Backup' },
    });
    expect(exec.statusCode).toBe(403);
    expect(exec.json().error.details.permission).toBe('admin');
    expect(await commandCount(t.db)).toBe(before);
  });

  it('queues a valid action and returns the parsed QuickBooks response', async () => {
    const fw = startFakeWorker(t, (c) =>
      c.rq_name === 'SpecialAccountAddRq'
        ? {
            kind: 'succeed',
            ret: sampleRet('Account', {
              Name: 'Undeposited Funds',
              FullName: 'Undeposited Funds',
              AccountType: 'OtherCurrentAsset',
              SpecialAccountType: 'UndepositedFunds',
            }),
          }
        : { kind: 'succeed' },
    );
    try {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/actions/SpecialAccountAddRq?wait=true',
        headers: json(acct),
        payload: { SpecialAccountAdd: { SpecialAccountType: 'UndepositedFunds' } },
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body.responses[0].name).toBe('SpecialAccountAddRs');
      const cmd = (await getCommand(t.db, body.commandId))!;
      expect(cmd).toMatchObject({ kind: 'raw', rq_name: 'SpecialAccountAddRq', priority: 1 });
      expectXsdValid(cmd.request_xml);
      const audit = await listAudit(t.db, { commandId: cmd.id });
      expect(audit[0]!.action).toBe('qbxml.action');

      const q = await t.app.inject({
        method: 'POST',
        url: '/api/actions/TransactionQueryRq',
        headers: json(readOnly),
        payload: { MaxReturned: 5 },
      });
      expect(q.statusCode).toBe(202);
      const qc = (await getCommand(t.db, q.json().commandId))!;
      expect(qc).toMatchObject({ kind: 'query', priority: 2 });
      expectXsdValid(qc.request_xml);
      expect(fw.invalid).toEqual([]);
    } finally {
      await fw.close();
    }
  });
});

describe('POST /objects/:type/live', () => {
  it('requires the filters QuickBooks requires (XSD), and object read permission', async () => {
    const before = await commandCount(t.db);
    const missing = await t.app.inject({
      method: 'POST',
      url: '/api/objects/BillToPay/live',
      headers: json(readOnly),
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('qbxml_invalid');
    const tok = (await createToken(t.db, ['object:Customer:read'])).token;
    const denied = await t.app.inject({
      method: 'POST',
      url: '/api/objects/BillToPay/live',
      headers: { ...bearer(tok), 'content-type': 'application/json' },
      payload: { PayeeEntityRef: { ListID: '80000101-1' } },
    });
    expect(denied.statusCode).toBe(403);
    expect(await commandCount(t.db)).toBe(before);
  });

  it('runs the query in QuickBooks and returns the rets', async () => {
    const ret = minimalObject('BillToPayRet');
    const fw = startFakeWorker(t, () => ({ kind: 'succeed', ret }));
    try {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/objects/BillToPay/live',
        headers: json(readOnly),
        payload: { PayeeEntityRef: { ListID: '80000101-1' } },
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body.type).toBe('BillToPay');
      expect(body.items).toEqual([ret]);
      const cmd = (await getCommand(t.db, body.commandId))!;
      expect(cmd).toMatchObject({ kind: 'query', priority: 2, rq_name: 'BillToPayQueryRq' });
      expectXsdValid(cmd.request_xml);
      expect(fw.invalid).toEqual([]);
    } finally {
      await fw.close();
    }
  });

  it('meta marks unsyncable entities and their required filters', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/meta/entities',
      headers: readOnly.headers(false),
    });
    const list = res.json().entities as {
      name: string;
      syncable: boolean;
      requiredFilters: string[];
    }[];
    const by = new Map(list.map((e) => [e.name, e]));
    expect(by.get('BillToPay')).toMatchObject({
      syncable: false,
      requiredFilters: ['PayeeEntityRef'],
    });
    expect(by.get('Customer')).toMatchObject({ syncable: true, requiredFilters: [] });
  });
});

describe('merge and cleared status', () => {
  it('merges two customers with EditSequences from the read model', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/objects/Customer/80000101-1/merge',
      headers: json(acct),
      payload: { into: '80000102-1' },
    });
    expect(res.statusCode, res.body).toBe(202);
    const cmd = (await getCommand(t.db, res.json().commandId))!;
    expectXsdValid(cmd.request_xml);
    expect(cmd.request_xml).toContain('<ListMergeType>Customer</ListMergeType>');
    expect(cmd.request_xml).toMatch(
      /<MergeFrom>\s*<ListID>80000101-1<\/ListID>\s*<EditSequence>111</,
    );
    expect(cmd.request_xml).toMatch(
      /<MergeTo>\s*<ListID>80000102-1<\/ListID>\s*<EditSequence>222</,
    );

    const self = await t.app.inject({
      method: 'POST',
      url: '/api/objects/Customer/80000101-1/merge',
      headers: json(acct),
      payload: { into: '80000101-1' },
    });
    expect(self.statusCode).toBe(400);
    const nope = await t.app.inject({
      method: 'POST',
      url: '/api/objects/Invoice/1-1/merge',
      headers: json(acct),
      payload: { into: '2-2' },
    });
    expect(nope.statusCode).toBe(405);
    const ro = await t.app.inject({
      method: 'POST',
      url: '/api/objects/Customer/80000101-1/merge',
      headers: json(readOnly),
      payload: { into: '80000102-1' },
    });
    expect(ro.statusCode).toBe(403);
  });

  it('marks a transaction cleared', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/objects/Check/123-1/cleared-status',
      headers: json(acct),
      payload: { status: 'Cleared' },
    });
    expect(res.statusCode, res.body).toBe(202);
    const cmd = (await getCommand(t.db, res.json().commandId))!;
    expectXsdValid(cmd.request_xml);
    expect(cmd.request_xml).toContain('<ClearedStatus>Cleared</ClearedStatus>');
    const list = await t.app.inject({
      method: 'POST',
      url: '/api/objects/Customer/80000101-1/cleared-status',
      headers: json(acct),
      payload: { status: 'Cleared' },
    });
    expect(list.statusCode).toBe(405);
  });
});
