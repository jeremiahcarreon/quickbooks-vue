/* eslint-disable @typescript-eslint/no-explicit-any -- assertions dig into JSON command results */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getCommand, getObject, listAudit, updateCommand, upsertObjects, type Db } from '@qbv/db';
import { createTestDatabase, type TestDatabase } from '@qbv/db/testing';
import { getEntity, validate } from '@qbv/qbxml';
import { CommandProcessor, RetryLaterError } from '../src/processor.js';
import {
  CapturedEvents,
  customerRet,
  FakeRelay,
  invoiceRet,
  newCommand,
  nowQb,
  respond,
  validRequest,
} from './helpers.js';

let t: TestDatabase;
let db: Db;
let relay: FakeRelay;
let events: CapturedEvents;
let circuitCalls: string[];
let proc: CommandProcessor;

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  relay = await new FakeRelay().start();
});

afterAll(async () => {
  await relay?.stop();
  await t?.destroy();
});

beforeEach(() => {
  relay.requests.length = 0;
  relay.handlerErrors.length = 0;
  events = new CapturedEvents();
  circuitCalls = [];
  proc = new CommandProcessor({
    db,
    relay: relay.client({ timeoutMs: 1500 }),
    events,
    qbxmlVersion: '16.0',
    circuit: {
      recordSuccess: async () => void circuitCalls.push('success'),
      recordFailure: async (e) => void circuitCalls.push(`failure:${e}`),
    },
  });
});

afterEach(() => {
  // The top requirement: everything that reached the relay was XSD-valid.
  expect(relay.invalid).toEqual([]);
  expect(relay.handlerErrors).toEqual([]);
  for (const r of relay.requests) expect(validate(r.qbxml).valid).toBe(true);
});

const once = { attemptsMade: 0, maxAttempts: 5 };
const last = { attemptsMade: 4, maxAttempts: 5 };

describe('add', () => {
  it('sends, upserts the returned Ret, sets object_id, audits and publishes events', async () => {
    const body = { CustomerAdd: { Name: 'Acme Corp', CompanyName: 'Acme' } };
    const cmd = await newCommand(db, {
      kind: 'add',
      rqName: 'CustomerAddRq',
      objectType: 'Customer',
      payload: body,
      requestXml: validRequest('CustomerAddRq', body),
      priority: 1,
    });
    relay.handler = (_x, info) => {
      expect(info.rqs[0]?.name).toBe('CustomerAddRq');
      return respond({
        rs: 'CustomerAddRs',
        body: { CustomerRet: customerRet('80000010-1', 'Acme Corp') },
      });
    };

    const r = await proc.process(cmd.id, once);
    expect(r.status).toBe('succeeded');
    const row = await getCommand(db, cmd.id);
    expect(row).toMatchObject({
      status: 'succeeded',
      status_code: 0,
      status_message: 'Status OK',
      object_id: '80000010-1',
      attempts: 1,
    });
    expect(row?.response_xml).toContain('<CustomerAddRs');
    expect(row?.finished_at).toBeInstanceOf(Date);
    const result = row?.result as Record<string, any>;
    expect(result.object.ListID).toBe('80000010-1');
    expect(result.responses[0]).toMatchObject({
      name: 'CustomerAddRs',
      statusCode: 0,
      retNames: ['CustomerRet'],
    });
    expect(result.changed).toEqual([{ objectType: 'Customer', qbId: '80000010-1', op: 'add' }]);

    const obj = await getObject(db, 'Customer', '80000010-1');
    expect(obj).toMatchObject({ name: 'Acme Corp', edit_sequence: '1' });

    const audit = await listAudit(db, { commandId: cmd.id });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'qb.add',
      actor_type: 'user',
      actor_id: 'u-1',
      object_id: '80000010-1',
    });
    expect(audit[0]?.detail).toMatchObject({ status: 'succeeded', requests: ['CustomerAddRq'] });

    expect(events.of('command.updated').map((e) => e.status)).toEqual(['sending', 'succeeded']);
    expect(events.of('object.changed')).toEqual([
      { type: 'object.changed', objectType: 'Customer', qbId: '80000010-1', op: 'add' },
    ]);
    expect(circuitCalls).toEqual(['success']);
    expect(relay.requests).toHaveLength(1);
  });

  it('builds request_xml from rq_name + payload when the producer stored none', async () => {
    const cmd = await newCommand(db, {
      kind: 'add',
      rqName: 'CustomerAddRq',
      objectType: 'Customer',
      payload: { CustomerAdd: { Name: 'Built Here' } },
    });
    relay.handler = () =>
      respond({
        rs: 'CustomerAddRs',
        body: { CustomerRet: customerRet('80000011-1', 'Built Here') },
      });
    expect((await proc.process(cmd.id, once)).status).toBe('succeeded');
    const row = await getCommand(db, cmd.id);
    expect(row?.request_xml).toContain('<CustomerAddRq>');
    expect(validate(row!.request_xml!).valid).toBe(true);
  });
});

describe('XSD re-validation', () => {
  it('rejects an invalid document and never sends it', async () => {
    const good = validRequest('CustomerAddRq', { CustomerAdd: { Name: 'X' } });
    const bad = good.replace('<Name>X</Name>', '<Nmae>X</Nmae>');
    expect(validate(bad).valid).toBe(false);
    const cmd = await newCommand(db, {
      kind: 'add',
      rqName: 'CustomerAddRq',
      objectType: 'Customer',
      requestXml: bad,
    });

    const r = await proc.process(cmd.id, once);
    expect(r.status).toBe('rejected');
    expect(relay.requests).toHaveLength(0);
    const row = await getCommand(db, cmd.id);
    expect(row?.status).toBe('rejected');
    expect(row?.status_message).toMatch(/XSD validation.*Nmae/);
    expect((row?.result as any).validationErrors[0].line).toBeGreaterThan(0);
    expect(row?.attempts).toBe(0);
    expect((await listAudit(db, { commandId: cmd.id }))[0]?.action).toBe('qb.add');
  });

  it('rejects elements in the wrong order', async () => {
    const good = validRequest('CustomerAddRq', { CustomerAdd: { Name: 'X', CompanyName: 'Y' } });
    const swapped = good.replace(/(<Name>X<\/Name>)(\s*)(<CompanyName>Y<\/CompanyName>)/, '$3$2$1');
    expect(swapped).not.toBe(good);
    const cmd = await newCommand(db, { kind: 'add', objectType: 'Customer', requestXml: swapped });
    expect((await proc.process(cmd.id, once)).status).toBe('rejected');
    expect(relay.requests).toHaveLength(0);
  });

  it('rejects a payload that cannot be built', async () => {
    const cmd = await newCommand(db, {
      kind: 'add',
      rqName: 'CustomerAddRq',
      payload: { CustomerAdd: { Name: 'X', NotAField: '1' } },
    });
    expect((await proc.process(cmd.id, once)).status).toBe('rejected');
    expect((await getCommand(db, cmd.id))?.status_message).toMatch(/NotAField/);
    expect(relay.requests).toHaveLength(0);
  });
});

describe('mod and conflicts', () => {
  it('upserts the modified object', async () => {
    await upsertObjects(db, getEntity('Customer'), [customerRet('80000020-1', 'Old Name')]);
    const xml = validRequest('CustomerModRq', {
      CustomerMod: { ListID: '80000020-1', EditSequence: '1', Name: 'New Name' },
    });
    const cmd = await newCommand(db, {
      kind: 'mod',
      objectType: 'Customer',
      objectId: '80000020-1',
      requestXml: xml,
    });
    relay.handler = () =>
      respond({
        rs: 'CustomerModRs',
        body: {
          CustomerRet: customerRet('80000020-1', 'New Name', {
            editSequence: '2',
            modified: nowQb(),
          }),
        },
      });
    expect((await proc.process(cmd.id, once)).status).toBe('succeeded');
    expect(await getObject(db, 'Customer', '80000020-1')).toMatchObject({
      name: 'New Name',
      edit_sequence: '2',
    });
    expect(events.of('object.changed')[0]).toMatchObject({ op: 'mod', qbId: '80000020-1' });
    expect((await listAudit(db, { commandId: cmd.id }))[0]?.action).toBe('qb.mod');
  });

  it('3200 -> conflict with the current object fetched by a validated query', async () => {
    const xml = validRequest('CustomerModRq', {
      CustomerMod: { ListID: '80000021-1', EditSequence: '1', Name: 'Mine' },
    });
    const cmd = await newCommand(db, {
      kind: 'mod',
      objectType: 'Customer',
      objectId: '80000021-1',
      requestXml: xml,
    });
    const current = customerRet('80000021-1', 'Theirs', { editSequence: '7', modified: nowQb() });
    relay.handler = (_x, info) => {
      if (info.rqs[0]?.name === 'CustomerModRq') {
        return respond({
          rs: 'CustomerModRs',
          statusCode: 3200,
          statusSeverity: 'Error',
          statusMessage: 'The provided edit sequence "1" is out-of-date.',
        });
      }
      expect(info.rqs[0]?.name).toBe('CustomerQueryRq');
      expect(info.rqs[0]?.body.ListID).toBe('80000021-1');
      return respond({ rs: 'CustomerQueryRs', body: { CustomerRet: [current] } });
    };
    const r = await proc.process(cmd.id, once);
    expect(r.status).toBe('conflict');
    const row = await getCommand(db, cmd.id);
    expect(row).toMatchObject({ status: 'conflict', status_code: 3200 });
    expect(row?.status_message).toMatch(/out-of-date/);
    expect((row?.result as any).current).toMatchObject({
      ListID: '80000021-1',
      Name: 'Theirs',
      EditSequence: '7',
    });
    expect(await getObject(db, 'Customer', '80000021-1')).toMatchObject({
      name: 'Theirs',
      edit_sequence: '7',
    });
    expect(relay.sentRqs).toEqual([['CustomerModRq'], ['CustomerQueryRq']]);
    expect((await listAudit(db, { commandId: cmd.id }))[0]?.detail).toMatchObject({
      status: 'conflict',
    });
  });

  it('other QuickBooks errors -> failed, keeping the status code and message', async () => {
    const xml = validRequest('CustomerAddRq', { CustomerAdd: { Name: 'Dup' } });
    const cmd = await newCommand(db, { kind: 'add', objectType: 'Customer', requestXml: xml });
    relay.handler = () =>
      respond({
        rs: 'CustomerAddRs',
        statusCode: 3100,
        statusSeverity: 'Error',
        statusMessage: 'The name "Dup" of the list element is already in use.',
      });
    expect((await proc.process(cmd.id, once)).status).toBe('failed');
    expect(await getCommand(db, cmd.id)).toMatchObject({
      status: 'failed',
      status_code: 3100,
      status_message: 'The name "Dup" of the list element is already in use.',
    });
  });
});

describe('del and void', () => {
  it('ListDel marks the object deleted', async () => {
    await upsertObjects(db, getEntity('Customer'), [customerRet('80000030-1', 'Gone Soon')]);
    const xml = validRequest('ListDelRq', { ListDelType: 'Customer', ListID: '80000030-1' });
    const cmd = await newCommand(db, {
      kind: 'del',
      objectType: 'Customer',
      objectId: '80000030-1',
      requestXml: xml,
    });
    relay.handler = () =>
      respond({
        rs: 'ListDelRs',
        body: {
          ListDelType: 'Customer',
          ListID: '80000030-1',
          TimeDeleted: nowQb(),
          FullName: 'Gone Soon',
        },
      });
    expect((await proc.process(cmd.id, once)).status).toBe('succeeded');
    expect(await getObject(db, 'Customer', '80000030-1')).toBeUndefined();
    expect(
      (await getObject(db, 'Customer', '80000030-1', { includeDeleted: true }))?.deleted_at,
    ).toBeInstanceOf(Date);
    expect(events.of('object.changed')).toEqual([
      { type: 'object.changed', objectType: 'Customer', qbId: '80000030-1', op: 'del' },
    ]);
    expect((await getCommand(db, cmd.id))?.result).toMatchObject({
      responses: [{ name: 'ListDelRs', fields: { ListDelType: 'Customer', ListID: '80000030-1' } }],
    });
  });

  it('TxnDel marks the transaction deleted', async () => {
    await upsertObjects(db, getEntity('Invoice'), [invoiceRet('100-1', 'INV-1')]);
    const xml = validRequest('TxnDelRq', { TxnDelType: 'Invoice', TxnID: '100-1' });
    const cmd = await newCommand(db, {
      kind: 'del',
      objectType: 'Invoice',
      objectId: '100-1',
      requestXml: xml,
    });
    relay.handler = () =>
      respond({
        rs: 'TxnDelRs',
        body: { TxnDelType: 'Invoice', TxnID: '100-1', TimeDeleted: nowQb() },
      });
    expect((await proc.process(cmd.id, once)).status).toBe('succeeded');
    expect(await getObject(db, 'Invoice', '100-1')).toBeUndefined();
    expect((await listAudit(db, { commandId: cmd.id }))[0]?.action).toBe('qb.del');
  });

  it('TxnVoid re-reads the transaction (validated query with line items) and upserts it', async () => {
    await upsertObjects(db, getEntity('Invoice'), [
      invoiceRet('101-1', 'INV-2', { amount: '250.00' }),
    ]);
    const xml = validRequest('TxnVoidRq', { TxnVoidType: 'Invoice', TxnID: '101-1' });
    const cmd = await newCommand(db, {
      kind: 'void',
      objectType: 'Invoice',
      objectId: '101-1',
      requestXml: xml,
    });
    relay.handler = (_x, info) => {
      if (info.rqs[0]?.name === 'TxnVoidRq') {
        return respond({
          rs: 'TxnVoidRs',
          body: {
            TxnVoidType: 'Invoice',
            TxnID: '101-1',
            TimeCreated: nowQb(),
            TimeModified: nowQb(),
          },
        });
      }
      expect(info.rqs[0]?.body).toMatchObject({ TxnID: '101-1', IncludeLineItems: 'true' });
      return respond({
        rs: 'InvoiceQueryRs',
        body: {
          InvoiceRet: [
            invoiceRet('101-1', 'INV-2', { amount: '0.00', editSequence: '2', created: nowQb() }),
          ],
        },
      });
    };
    expect((await proc.process(cmd.id, once)).status).toBe('succeeded');
    expect(relay.sentRqs).toEqual([['TxnVoidRq'], ['InvoiceQueryRq']]);
    const obj = await getObject(db, 'Invoice', '101-1');
    expect(obj?.edit_sequence).toBe('2');
    expect(Number(obj?.amount)).toBe(0);
    expect(events.of('object.changed')).toEqual([
      { type: 'object.changed', objectType: 'Invoice', qbId: '101-1', op: 'void' },
    ]);
  });
});

describe('query, report and raw', () => {
  it('query: stores the parsed result, does not touch the read model and is not audited', async () => {
    const xml = validRequest(
      'CustomerQueryRq',
      { MaxReturned: 2 },
      { iterator: 'Start', requestID: 'q1' },
    );
    const cmd = await newCommand(db, {
      kind: 'query',
      rqName: 'CustomerQueryRq',
      objectType: 'Customer',
      requestXml: xml,
      actorType: 'system',
    });
    relay.handler = () =>
      respond({
        rs: 'CustomerQueryRs',
        requestID: 'q1',
        iteratorID: '{abc-123}',
        iteratorRemainingCount: 3,
        body: {
          CustomerRet: [customerRet('80000040-1', 'Q One'), customerRet('80000041-1', 'Q Two')],
        },
      });
    expect((await proc.process(cmd.id, once)).status).toBe('succeeded');
    const row = await getCommand(db, cmd.id);
    const res = row?.result as any;
    expect(res.responses[0]).toMatchObject({
      requestID: 'q1',
      name: 'CustomerQueryRs',
      iteratorID: '{abc-123}',
      iteratorRemainingCount: 3,
      retNames: ['CustomerRet', 'CustomerRet'],
    });
    expect(res.responses[0].rets.map((r: any) => r.Name)).toEqual(['Q One', 'Q Two']);
    expect(res.changed).toBeUndefined();
    expect(await getObject(db, 'Customer', '80000040-1')).toBeUndefined();
    expect(await listAudit(db, { commandId: cmd.id })).toEqual([]);
    expect(events.of('object.changed')).toEqual([]);
  });

  it('report: stores the ReportRet', async () => {
    const xml = validRequest('GeneralSummaryReportQueryRq', {
      GeneralSummaryReportType: 'ProfitAndLossStandard',
    });
    const cmd = await newCommand(db, {
      kind: 'report',
      rqName: 'GeneralSummaryReportQueryRq',
      requestXml: xml,
      actorType: 'system',
    });
    relay.handler = () =>
      respond({
        rs: 'GeneralSummaryReportQueryRs',
        body: {
          ReportRet: {
            ReportTitle: 'Profit & Loss',
            ReportSubtitle: 'November 2026',
            ReportBasis: 'Accrual',
            NumRows: '1',
            NumColumns: '2',
            NumColTitleRows: '1',
            ColDesc: [
              {
                '@colID': '1',
                '@dataType': 'STRTYPE',
                ColTitle: [{ '@titleRow': '1' }],
                ColType: 'Label',
              },
              {
                '@colID': '2',
                '@dataType': 'AMTTYPE',
                ColTitle: [{ '@titleRow': '1', '@value': 'TOTAL' }],
                ColType: 'Amount',
              },
            ],
            ReportData: {
              DataRow: [
                {
                  '@rowNumber': '1',
                  ColData: [
                    { '@colID': '1', '@value': 'Sales' },
                    { '@colID': '2', '@value': '100.00' },
                  ],
                },
              ],
            },
          },
        },
      });
    expect((await proc.process(cmd.id, once)).status).toBe('succeeded');
    const res = (await getCommand(db, cmd.id))?.result as any;
    expect(res.responses[0].retNames).toEqual(['ReportRet']);
    expect(res.responses[0].rets[0].ReportTitle).toBe('Profit & Loss');
    expect(await listAudit(db, { commandId: cmd.id })).toEqual([]);
  });

  it('raw batch (continueOnError): results mapped per requestID; writes go through; first error decides', async () => {
    const { buildBatch } = await import('@qbv/qbxml');
    const xml = buildBatch(
      [
        {
          rq: 'CustomerAddRq',
          body: { CustomerAdd: { Name: 'Batch A' } },
          opts: { requestID: 'a' },
        },
        {
          rq: 'CustomerAddRq',
          body: { CustomerAdd: { Name: 'Batch B' } },
          opts: { requestID: 'b' },
        },
        { rq: 'CustomerQueryRq', body: { FullName: ['Batch A'] }, opts: { requestID: 'c' } },
      ],
      'continueOnError',
    );
    expect(validate(xml).valid).toBe(true);
    const cmd = await newCommand(db, {
      kind: 'raw',
      requestXml: xml,
      actorType: 'token',
      actorId: 't-1',
    });
    relay.handler = () =>
      respond(
        // QuickBooks may answer in any order; requestID is the key.
        {
          rs: 'CustomerQueryRs',
          requestID: 'c',
          body: { CustomerRet: [customerRet('80000050-1', 'Batch A')] },
        },
        {
          rs: 'CustomerAddRs',
          requestID: 'a',
          body: { CustomerRet: customerRet('80000050-1', 'Batch A') },
        },
        {
          rs: 'CustomerAddRs',
          requestID: 'b',
          statusCode: 3100,
          statusSeverity: 'Error',
          statusMessage: 'The name "Batch B" of the list element is already in use.',
        },
      );
    expect((await proc.process(cmd.id, once)).status).toBe('failed');
    const row = await getCommand(db, cmd.id);
    expect(row?.status_code).toBe(3100);
    expect(row?.status_message).toMatch(/requestID b/);
    const res = row?.result as any;
    expect(res.responses.map((r: any) => [r.requestID, r.name, r.statusCode])).toEqual([
      ['a', 'CustomerAddRs', 0],
      ['b', 'CustomerAddRs', 3100],
      ['c', 'CustomerQueryRs', 0],
    ]);
    expect(await getObject(db, 'Customer', '80000050-1')).toMatchObject({ name: 'Batch A' });
    expect((await listAudit(db, { commandId: cmd.id }))[0]).toMatchObject({
      action: 'qb.raw',
      actor_type: 'token',
    });
  });

  it('raw batch (stopOnError): requests QuickBooks never reached are reported as not processed', async () => {
    const { buildBatch } = await import('@qbv/qbxml');
    const xml = buildBatch(
      [
        { rq: 'CustomerAddRq', body: { CustomerAdd: { Name: 'S1' } } },
        { rq: 'CustomerAddRq', body: { CustomerAdd: { Name: 'S2' } } },
        { rq: 'CustomerAddRq', body: { CustomerAdd: { Name: 'S3' } } },
      ],
      'stopOnError',
    );
    const cmd = await newCommand(db, { kind: 'raw', requestXml: xml });
    relay.handler = () =>
      respond(
        {
          rs: 'CustomerAddRs',
          requestID: '0',
          body: { CustomerRet: customerRet('80000060-1', 'S1') },
        },
        {
          rs: 'CustomerAddRs',
          requestID: '1',
          statusCode: 3000,
          statusSeverity: 'Error',
          statusMessage: 'bad',
        },
      );
    expect((await proc.process(cmd.id, once)).status).toBe('failed');
    const res = (await getCommand(db, cmd.id))?.result as any;
    expect(res.notProcessed).toEqual([{ requestID: '2', name: 'CustomerAddRq' }]);
    expect(res.responses[2]).toEqual({ requestID: '2', name: 'CustomerAddRs', notProcessed: true });
    expect(await getObject(db, 'Customer', '80000060-1')).toBeDefined();
  });

  it('raw query-only document is not audited', async () => {
    const xml = validRequest('HostQueryRq', {});
    const cmd = await newCommand(db, { kind: 'raw', requestXml: xml });
    relay.handler = () =>
      respond({
        rs: 'HostQueryRs',
        body: {
          HostRet: {
            ProductName: 'QuickBooks Enterprise',
            MajorVersion: '24',
            MinorVersion: '0',
            SupportedQBXMLVersion: ['16.0'],
            IsAutomaticLogin: 'false',
            QBFileMode: 'MultiUser',
          },
        },
      });
    expect((await proc.process(cmd.id, once)).status).toBe('succeeded');
    expect(await listAudit(db, { commandId: cmd.id })).toEqual([]);
  });
});

describe('relay failures', () => {
  it('503 with attempts left: back to queued, circuit notified, RetryLaterError', async () => {
    const xml = validRequest('CustomerQueryRq', { MaxReturned: 1 });
    const cmd = await newCommand(db, { kind: 'query', requestXml: xml });
    relay.handler = () => ({ status: 503, body: { error: 'QuickBooks is not connected' } });
    await expect(proc.process(cmd.id, once)).rejects.toBeInstanceOf(RetryLaterError);
    const row = await getCommand(db, cmd.id);
    expect(row?.status).toBe('queued');
    expect(row?.status_message).toMatch(/not connected.*attempt 1 of 5/);
    expect(circuitCalls).toEqual(['failure:QuickBooks is not connected']);
    expect(events.of('command.updated').map((e) => e.status)).toEqual(['sending', 'queued']);
  });

  it('503 on the last attempt: failed', async () => {
    const xml = validRequest('CustomerQueryRq', { MaxReturned: 1 });
    const cmd = await newCommand(db, { kind: 'query', requestXml: xml });
    relay.handler = () => ({ status: 503, body: { error: 'QuickBooks is not connected' } });
    expect((await proc.process(cmd.id, last)).status).toBe('failed');
    expect((await getCommand(db, cmd.id))?.status_message).toMatch(/after 5 attempts/);
  });

  it('network error (relay down) is retryable', async () => {
    const down = new CommandProcessor({
      db,
      relay: new (await import('@qbv/relay-client')).RelayClient({
        baseUrl: 'http://127.0.0.1:1',
        timeoutMs: 500,
      }),
    });
    const cmd = await newCommand(db, {
      kind: 'query',
      requestXml: validRequest('HostQueryRq', {}),
    });
    await expect(down.process(cmd.id, once)).rejects.toBeInstanceOf(RetryLaterError);
    expect((await getCommand(db, cmd.id))?.status).toBe('queued');
  });

  it('502 COM failure on a write: failed with a may-have-applied note', async () => {
    const xml = validRequest('CustomerAddRq', { CustomerAdd: { Name: 'Com Fail' } });
    const cmd = await newCommand(db, { kind: 'add', requestXml: xml });
    relay.handler = () => ({ status: 502, body: { error: 'COM error 0x8004' } });
    expect((await proc.process(cmd.id, once)).status).toBe('failed');
    expect((await getCommand(db, cmd.id))?.status_message).toMatch(/502.*may have applied/);
  });

  it('401 from the relay: failed, not retried', async () => {
    const bad = new CommandProcessor({
      db,
      relay: new (await import('@qbv/relay-client')).RelayClient({
        baseUrl: relay.url,
        apiKey: 'wrong',
      }),
    });
    const cmd = await newCommand(db, {
      kind: 'query',
      requestXml: validRequest('HostQueryRq', {}),
    });
    expect((await bad.process(cmd.id, once)).status).toBe('failed');
    expect((await getCommand(db, cmd.id))?.status_message).toMatch(/401/);
  });

  it('a garbage response is a failure, not a crash', async () => {
    const cmd = await newCommand(db, {
      kind: 'query',
      requestXml: validRequest('HostQueryRq', {}),
    });
    relay.handler = () => ({ xml: 'not xml at all' });
    expect((await proc.process(cmd.id, once)).status).toBe('failed');
    expect((await getCommand(db, cmd.id))?.status_message).toMatch(/Cannot parse/);
  });

  it('skips finished and unknown commands', async () => {
    const cmd = await newCommand(db, {
      kind: 'query',
      requestXml: validRequest('HostQueryRq', {}),
    });
    await updateCommand(db, cmd.id, { status: 'succeeded' });
    expect((await proc.process(cmd.id, once)).status).toBe('skipped');
    expect((await proc.process('00000000-0000-4000-8000-000000000000', once)).status).toBe(
      'skipped',
    );
    expect(relay.requests).toHaveLength(0);
  });
});

describe('interrupted writes are checked before any resend', () => {
  it('504 on an Add -> queued with a verification marker; next attempt finds it applied and does not resend', async () => {
    const xml = validRequest('CustomerAddRq', { CustomerAdd: { Name: 'Slow Co' } });
    const cmd = await newCommand(db, { kind: 'add', objectType: 'Customer', requestXml: xml });
    relay.handler = () => ({ status: 504, body: { error: 'QB request timed out' } });
    await expect(proc.process(cmd.id, once)).rejects.toBeInstanceOf(RetryLaterError);
    const queued = await getCommand(db, cmd.id);
    expect(queued?.status).toBe('queued');
    expect((queued?.result as any).pendingVerification.reason).toMatch(/RelayTimeoutError/);

    relay.requests.length = 0;
    relay.handler = (_x, info) => {
      expect(info.rqs[0]?.name).toBe('CustomerQueryRq');
      expect(info.rqs[0]?.body.FullName).toBe('Slow Co');
      return respond({
        rs: 'CustomerQueryRs',
        body: { CustomerRet: [customerRet('80000070-1', 'Slow Co', { created: nowQb() })] },
      });
    };
    expect((await proc.process(cmd.id, { attemptsMade: 1, maxAttempts: 5 })).status).toBe(
      'succeeded',
    );
    expect(relay.sentRqs).toEqual([['CustomerQueryRq']]);
    const row = await getCommand(db, cmd.id);
    expect(row?.object_id).toBe('80000070-1');
    expect(row?.status_message).toMatch(/Applied by an earlier attempt/);
    expect((row?.result as any).verification).toMatchObject({ resent: false, outcome: 'applied' });
    expect(await getObject(db, 'Customer', '80000070-1')).toBeDefined();
    expect(events.of('object.changed')).toEqual([
      { type: 'object.changed', objectType: 'Customer', qbId: '80000070-1', op: 'add' },
    ]);
  });

  it('stuck in sending (crash) Add, not found by name -> resent once', async () => {
    const xml = validRequest('CustomerAddRq', { CustomerAdd: { Name: 'Crash Co' } });
    const cmd = await newCommand(db, { kind: 'add', objectType: 'Customer', requestXml: xml });
    await updateCommand(db, cmd.id, { status: 'sending' });
    relay.handler = (_x, info) =>
      info.rqs[0]?.name === 'CustomerQueryRq'
        ? respond({
            rs: 'CustomerQueryRs',
            statusCode: 1,
            statusSeverity: 'Info',
            statusMessage: 'A query request did not find a matching object in QuickBooks',
          })
        : respond({
            rs: 'CustomerAddRs',
            body: { CustomerRet: customerRet('80000071-1', 'Crash Co', { created: nowQb() }) },
          });
    expect((await proc.process(cmd.id, once)).status).toBe('succeeded');
    expect(relay.sentRqs).toEqual([['CustomerQueryRq'], ['CustomerAddRq']]);
    expect((await getCommand(db, cmd.id))?.result).toMatchObject({
      verification: { resent: true },
    });
  });

  it('an old object with the same name does not count as applied', async () => {
    const xml = validRequest('CustomerAddRq', { CustomerAdd: { Name: 'Old Co' } });
    const cmd = await newCommand(db, { kind: 'add', requestXml: xml });
    await updateCommand(db, cmd.id, { status: 'sending' });
    relay.handler = (_x, info) =>
      info.rqs[0]?.name === 'CustomerQueryRq'
        ? respond({
            rs: 'CustomerQueryRs',
            body: {
              CustomerRet: [
                customerRet('80000072-1', 'Old Co', { created: '2020-01-01T00:00:00+00:00' }),
              ],
            },
          })
        : respond({
            rs: 'CustomerAddRs',
            statusCode: 3100,
            statusSeverity: 'Error',
            statusMessage: 'The name "Old Co" of the list element is already in use.',
          });
    expect((await proc.process(cmd.id, once)).status).toBe('failed');
    expect(relay.sentRqs).toEqual([['CustomerQueryRq'], ['CustomerAddRq']]);
  });

  it('interrupted txn Add with RefNumber: found -> applied', async () => {
    const xml = validRequest('InvoiceAddRq', {
      InvoiceAdd: {
        CustomerRef: { FullName: 'Acme' },
        RefNumber: 'INV-900',
        InvoiceLineAdd: [{ Desc: 'x', Amount: 100 }],
      },
    });
    const cmd = await newCommand(db, { kind: 'add', objectType: 'Invoice', requestXml: xml });
    await updateCommand(db, cmd.id, { status: 'sending' });
    relay.handler = (_x, info) => {
      expect(info.rqs[0]?.name).toBe('InvoiceQueryRq');
      expect(info.rqs[0]?.body.RefNumber).toBe('INV-900');
      return respond({
        rs: 'InvoiceQueryRs',
        body: { InvoiceRet: [invoiceRet('200-1', 'INV-900', { created: nowQb() })] },
      });
    };
    expect((await proc.process(cmd.id, once)).status).toBe('succeeded');
    expect(await getObject(db, 'Invoice', '200-1')).toBeDefined();
    expect(relay.sentRqs).toEqual([['InvoiceQueryRq']]);
  });

  it('interrupted txn Add without RefNumber -> failed with an explanation, nothing sent', async () => {
    const xml = validRequest('InvoiceAddRq', {
      InvoiceAdd: {
        CustomerRef: { FullName: 'Acme' },
        InvoiceLineAdd: [{ Desc: 'x', Amount: 100 }],
      },
    });
    const cmd = await newCommand(db, { kind: 'add', objectType: 'Invoice', requestXml: xml });
    await updateCommand(db, cmd.id, { status: 'sending' });
    expect((await proc.process(cmd.id, once)).status).toBe('failed');
    expect(relay.requests).toHaveLength(0);
    const row = await getCommand(db, cmd.id);
    expect(row?.status_message).toMatch(/not resent.*apply it twice/);
    expect((row?.result as any).verification.outcome).toBe('unknown');
  });

  it('interrupted Mod is resent (EditSequence protects it); 3200 then explains', async () => {
    const xml = validRequest('CustomerModRq', {
      CustomerMod: { ListID: '80000073-1', EditSequence: '1', Name: 'M' },
    });
    const cmd = await newCommand(db, { kind: 'mod', requestXml: xml });
    await updateCommand(db, cmd.id, { status: 'sending' });
    relay.handler = (_x, info) =>
      info.rqs[0]?.name === 'CustomerModRq'
        ? respond({
            rs: 'CustomerModRs',
            statusCode: 3200,
            statusSeverity: 'Error',
            statusMessage: 'The provided edit sequence "1" is out-of-date.',
          })
        : respond({
            rs: 'CustomerQueryRs',
            body: { CustomerRet: [customerRet('80000073-1', 'M', { editSequence: '2' })] },
          });
    expect((await proc.process(cmd.id, once)).status).toBe('conflict');
    expect(relay.sentRqs).toEqual([['CustomerModRq'], ['CustomerQueryRq']]);
    expect((await getCommand(db, cmd.id))?.status_message).toMatch(/may already be in QuickBooks/);
  });

  it('interrupted Del: object already gone -> succeeded without resending', async () => {
    await upsertObjects(db, getEntity('Customer'), [customerRet('80000074-1', 'Del Me')]);
    const xml = validRequest('ListDelRq', { ListDelType: 'Customer', ListID: '80000074-1' });
    const cmd = await newCommand(db, {
      kind: 'del',
      objectType: 'Customer',
      objectId: '80000074-1',
      requestXml: xml,
    });
    await updateCommand(db, cmd.id, { status: 'sending' });
    relay.handler = () =>
      respond({
        rs: 'CustomerQueryRs',
        statusCode: 500,
        statusSeverity: 'Warn',
        statusMessage:
          'The query request has not been fully completed. There was a required element ("80000074-1") that could not be found in QuickBooks.',
      });
    expect((await proc.process(cmd.id, once)).status).toBe('succeeded');
    expect(relay.sentRqs).toEqual([['CustomerQueryRq']]);
    expect(await getObject(db, 'Customer', '80000074-1')).toBeUndefined();
  });

  it('relay down during the check: retried later, marker kept', async () => {
    const xml = validRequest('CustomerAddRq', { CustomerAdd: { Name: 'Later Co' } });
    const cmd = await newCommand(db, { kind: 'add', requestXml: xml });
    await updateCommand(db, cmd.id, { status: 'sending' });
    relay.handler = () => ({ status: 503, body: { error: 'QuickBooks is not connected' } });
    await expect(proc.process(cmd.id, once)).rejects.toBeInstanceOf(RetryLaterError);
    const row = await getCommand(db, cmd.id);
    expect(row?.status).toBe('queued');
    expect((row?.result as any).pendingVerification).toBeDefined();
    expect(relay.sentRqs).toEqual([['CustomerQueryRq']]);
  });

  it('interrupted query is simply resent', async () => {
    const cmd = await newCommand(db, {
      kind: 'query',
      requestXml: validRequest('HostQueryRq', {}),
    });
    await updateCommand(db, cmd.id, { status: 'sending' });
    relay.handler = () =>
      respond({
        rs: 'HostQueryRs',
        body: {
          HostRet: {
            ProductName: 'QB',
            MajorVersion: '24',
            MinorVersion: '0',
            SupportedQBXMLVersion: ['16.0'],
            IsAutomaticLogin: 'false',
            QBFileMode: 'MultiUser',
          },
        },
      });
    expect((await proc.process(cmd.id, once)).status).toBe('succeeded');
    expect(relay.sentRqs).toEqual([['HostQueryRq']]);
  });
});
