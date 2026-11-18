import { describe, expect, it } from 'vitest';
import { buildBatch, validate } from '@qbv/qbxml';
import { entityOfRq, targetIdOfRq } from '../src/entities.js';
import { pairResponses } from '../src/processor.js';
import { describeRequest, RequestParseError } from '../src/request-info.js';
import { validRequest } from './helpers.js';
import { parseResponse, buildResponse } from '@qbv/qbxml';

describe('describeRequest', () => {
  it('lists every request with requestID, op and body', () => {
    const xml = buildBatch(
      [
        {
          rq: 'CustomerModRq',
          body: { CustomerMod: { ListID: '8-1', EditSequence: '3', Name: 'A & B' } },
          opts: { requestID: 'm' },
        },
        {
          rq: 'CustomerQueryRq',
          body: { ListID: ['8-1'], IncludeRetElement: ['ListID'] },
          opts: { requestID: 'q' },
        },
        { rq: 'TxnDelRq', body: { TxnDelType: 'Invoice', TxnID: '9-9' }, opts: { requestID: 'd' } },
      ],
      'continueOnError',
    );
    expect(validate(xml).valid).toBe(true);
    const info = describeRequest(xml);
    expect(info.msgSet).toBe('QBXMLMsgsRq');
    expect(info.onError).toBe('continueOnError');
    expect(info.readOnly).toBe(false);
    expect(info.rqs.map((r) => [r.name, r.requestID, r.op, r.readOnly, r.partial])).toEqual([
      ['CustomerModRq', 'm', 'Mod', false, false],
      ['CustomerQueryRq', 'q', 'Query', true, true],
      ['TxnDelRq', 'd', 'Del', false, false],
    ]);
    expect(info.rqs[0]?.body).toEqual({
      CustomerMod: { ListID: '8-1', EditSequence: '3', Name: 'A & B' },
    });
    expect(entityOfRq(info.rqs[0]!)?.name).toBe('Customer');
    expect(targetIdOfRq(info.rqs[0]!, entityOfRq(info.rqs[0]!))).toBe('8-1');
    expect(entityOfRq(info.rqs[2]!)?.name).toBe('Invoice');
    expect(targetIdOfRq(info.rqs[2]!, entityOfRq(info.rqs[2]!))).toBe('9-9');
  });

  it('marks query-only documents read-only', () => {
    expect(describeRequest(validRequest('HostQueryRq', {})).readOnly).toBe(true);
    expect(
      describeRequest(
        validRequest('GeneralSummaryReportQueryRq', {
          GeneralSummaryReportType: 'BalanceSheetStandard',
        }),
      ).readOnly,
    ).toBe(true);
    expect(describeRequest(validRequest('CustomerAddRq', { Name: 'x' })).readOnly).toBe(false);
  });

  it('resolves Void and ListDel entities from their type element', () => {
    const v = describeRequest(validRequest('TxnVoidRq', { TxnVoidType: 'Check', TxnID: '1-1' }))
      .rqs[0]!;
    expect(entityOfRq(v)?.name).toBe('Check');
    const l = describeRequest(
      validRequest('ListDelRq', { ListDelType: 'ItemService', ListID: '2-2' }),
    ).rqs[0]!;
    expect(entityOfRq(l)?.name).toBe('ItemService');
    expect(targetIdOfRq(l, entityOfRq(l))).toBe('2-2');
  });

  it('throws on something that is not a qbXML request', () => {
    expect(() => describeRequest('<foo/>')).toThrow(RequestParseError);
  });
});

describe('pairResponses', () => {
  it('pairs by requestID, falling back to position', () => {
    const xml = buildBatch(
      [
        { rq: 'HostQueryRq', opts: { requestID: 'h' } },
        { rq: 'CompanyQueryRq', opts: { requestID: 'c' } },
      ],
      'stopOnError',
    );
    const info = describeRequest(xml);
    const rss = parseResponse(
      buildResponse([
        {
          rs: 'CompanyQueryRs',
          requestID: 'c',
          statusCode: 3000,
          statusSeverity: 'Error',
          statusMessage: 'x',
        },
      ]),
    );
    const pairs = pairResponses(info, rss);
    expect(pairs.map((p) => p.rs?.name)).toEqual([undefined, 'CompanyQueryRs']);
  });
});
