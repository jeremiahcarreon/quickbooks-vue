import { describe, expect, it } from 'vitest';
import { qbxmlIssues } from '@/api/endpoints';
import {
  toCommand,
  toCurrentUser,
  toEntityMeta,
  toEvent,
  toHealth,
  toPage,
  toQbObject,
} from '@/api/normalize';
import { formatMoney, timeAgo } from '@/lib/format';
import { entityTitle, humanize } from '@/lib/labels';
import {
  hasPermission,
  isValidPermission,
  normalizePermissions,
  objectAccess,
  setObjectAccess,
} from '@/lib/permissions';
import { checkWellFormed, highlightXml, prettyXml, tokenizeXml } from '@/lib/xml';

describe('permissions', () => {
  it('matches the API grammar', () => {
    expect(hasPermission(['admin'], 'object:Invoice:write')).toBe(true);
    expect(hasPermission(['object:*:read'], 'object:Invoice:read')).toBe(true);
    expect(hasPermission(['object:*:read'], 'object:Invoice:write')).toBe(false);
    expect(hasPermission(['object:Invoice:write'], 'object:Invoice:read')).toBe(true);
    expect(hasPermission(['object:*:write'], 'object:Bill:read')).toBe(true);
    expect(hasPermission(['report:*'], 'report:ar-aging')).toBe(true);
    expect(hasPermission(['report:*'], 'qbxml:raw')).toBe(false);
  });
  it('edits per-type access and normalises lists', () => {
    let p = setObjectAccess(['object:*:read'], 'Invoice', 'write');
    expect(p).toEqual(['object:*:read', 'object:Invoice:write']);
    expect(objectAccess(p, 'Invoice')).toBe('write');
    expect(objectAccess(p, 'Bill')).toBe('read');
    p = setObjectAccess(p, 'Invoice', 'none');
    expect(p).toEqual(['object:*:read']);
    expect(normalizePermissions([' admin', 'admin', 'bogus', 'report:x'])).toEqual([
      'admin',
      'report:x',
    ]);
    expect(isValidPermission('object:Invoice:delete')).toBe(false);
  });
});

describe('labels and formatting', () => {
  it('humanizes element names', () => {
    expect(humanize('ARAccountRef')).toBe('A/R Account');
    expect(humanize('ItemNonInventory')).toBe('Item Non Inventory');
    expect(humanize('Addr1')).toBe('Address 1');
    expect(humanize('TxnDate')).toBe('Transaction Date');
    expect(entityTitle('Customer')).toBe('Customers');
    expect(entityTitle('Class')).toBe('Classes');
    expect(entityTitle('Company')).toBe('Companies');
  });
  it('formats exact decimal strings', () => {
    expect(formatMoney('1234567.5')).toBe('1,234,567.50');
    expect(formatMoney('-0.1')).toBe('-0.10');
    expect(formatMoney('12.34567', 0)).toBe('12.34567');
    expect(formatMoney('')).toBe('');
    expect(timeAgo(new Date(Date.now() - 120_000).toISOString())).toBe('2 min ago');
  });
});

describe('xml helpers', () => {
  const xml =
    '<?qbxml version="16.0"?><QBXML><QBXMLMsgsRq onError="stopOnError"><!-- c --><CustomerQueryRq requestID="1"><FullName>A &amp; B</FullName></CustomerQueryRq></QBXMLMsgsRq></QBXML>';
  it('tokenizes and escapes for highlighting', () => {
    const kinds = tokenizeXml(xml).map((t) => t.kind);
    expect(kinds).toContain('pi');
    expect(kinds).toContain('comment');
    expect(kinds).toContain('attr');
    expect(kinds).toContain('entity');
    expect(
      tokenizeXml(xml)
        .map((t) => t.text)
        .join(''),
    ).toBe(xml);
    expect(highlightXml('<a x="<">')).toContain('&lt;');
    expect(highlightXml('<a x="<">')).not.toContain('<a');
  });
  it('pretty prints and checks well-formedness', () => {
    const pretty = prettyXml(xml);
    expect(pretty.split('\n')).toContain('      <FullName>A &amp; B</FullName>');
    expect(checkWellFormed(xml)).toEqual({ ok: true });
    expect(checkWellFormed('<QBXML><a></QBXML>').ok).toBe(false);
    expect(checkWellFormed('<Other/>')).toMatchObject({
      ok: false,
      message: expect.stringContaining('QBXML'),
    });
  });
});

describe('normalize', () => {
  it('reads the user from POST /auth/login ({user}) and GET /auth/me ({principal})', () => {
    const user = {
      type: 'user',
      id: 'u1',
      email: 'a@b.c',
      displayName: 'A',
      permissions: ['admin'],
    };
    expect(toCurrentUser({ user, csrfToken: 'x' })).toMatchObject({
      id: 'u1',
      permissions: ['admin'],
    });
    expect(toCurrentUser({ principal: { ...user, csrfToken: 'x' }, csrfToken: 'x' })).toMatchObject(
      {
        id: 'u1',
        email: 'a@b.c',
        displayName: 'A',
        permissions: ['admin'],
      },
    );
    expect(toCurrentUser({ principal: { type: 'token', id: 't1', permissions: [] } })).toBeNull();
  });
  it('maps read-model rows in snake or camel case', () => {
    const a = toQbObject({
      type: 'Invoice',
      qb_id: 'T1',
      ref_number: 'INV-1',
      txn_date: '2026-01-01',
      amount: '10.00',
      is_active: null,
      data: { TxnID: 'T1' },
    });
    const b = toQbObject({
      type: 'Invoice',
      qbId: 'T1',
      refNumber: 'INV-1',
      txnDate: '2026-01-01',
      amount: '10.00',
      data: { TxnID: 'T1' },
    });
    expect(a).toEqual(b);
    expect(
      toQbObject({ ListID: 'L1', FullName: 'X', EditSequence: '9' }, 'Customer'),
    ).toMatchObject({ id: 'L1', name: 'X', editSequence: '9', type: 'Customer' });
  });
  it('reads pages, commands, users, entity metadata and health in several shapes', () => {
    expect(toPage({ items: [{}], total: 7, page: 2, pageSize: 1 }, (x) => x)).toMatchObject({
      total: 7,
      page: 2,
    });
    expect(toPage({ data: [{}, {}], meta: { total: 9 } }, (x) => x)).toMatchObject({
      total: 9,
      items: [{}, {}],
    });
    expect(toCommand({ command: { id: 'c', status: 'weird', status_code: '3200' } })).toMatchObject(
      { id: 'c', status: 'queued', statusCode: 3200 },
    );
    expect(
      toCurrentUser({ user: { id: 'u', email: 'e', display_name: 'D' }, permissions: ['admin'] }),
    ).toMatchObject({ displayName: 'D', permissions: ['admin'] });
    const meta = toEntityMeta({
      name: 'Customer',
      ops: {},
      retElement: 'CustomerRet',
      add: { name: 'CustomerAdd', fields: [] },
    });
    expect(meta?.objects.CustomerAdd).toBeDefined();
    expect(toHealth({ status: 'degraded', checks: { relay: 'down' } })).toMatchObject({
      ok: false,
      relayConnected: false,
    });
    expect(toHealth({ relay: true }).relayConnected).toBe(true);
  });
  it('parses SSE payloads, taking the type from the event name when missing', () => {
    expect(
      toEvent('{"objectType":"Customer","qbId":"1","op":"mod"}', 'object.changed'),
    ).toMatchObject({ type: 'object.changed' });
    expect(toEvent('{"type":"relay.health","connected":"yes"}')).toBeNull();
    expect(toEvent('not json')).toBeNull();
  });
  it('reads libxml2 issues from error details', () => {
    expect(qbxmlIssues({ errors: [{ line: 3, message: 'bad' }, 'x'] })).toEqual([
      { line: 3, column: null, message: 'bad' },
      { line: null, column: null, message: 'x' },
    ]);
  });
});
