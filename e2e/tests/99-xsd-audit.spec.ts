import { expect, test } from '@playwright/test';
import { validate } from '@qbv/qbxml';
import { Api, relayMock, runStartedAt } from './helpers.js';

interface CommandSummary {
  id: string;
  kind: string;
  rqName: string | null;
  status: string;
  createdAt: string;
}

/**
 * The project's first rule: every qbXML document that leaves the system is
 * valid against the Intuit XSD. This spec runs last and checks the whole run:
 * every command created since the run started (from the tests, sync and
 * reports) carries a request that libxml2 accepts, and the relay mock, which
 * validates everything it receives, logged no rejection.
 */
test.describe('XSD audit of this run', () => {
  test('every qbXML request sent during the run validates against the XSD', async () => {
    const api = await Api.create();
    const since = runStartedAt();

    const commands: CommandSummary[] = [];
    let before: string | undefined;
    for (;;) {
      const res = await api.ctx.get('/api/commands', {
        params: { limit: '500', ...(before ? { before } : {}) },
      });
      expect(res.status()).toBe(200);
      const page = (await res.json()) as { items: CommandSummary[]; nextBefore: string | null };
      const fresh = page.items.filter((c) => new Date(c.createdAt) >= since);
      commands.push(...fresh);
      if (!page.nextBefore || fresh.length < page.items.length) break;
      before = page.nextBefore;
    }
    // The run exercised writes, raw qbXML, reports and sync queries.
    const kinds = new Set(commands.map((c) => c.kind));
    for (const k of ['add', 'mod', 'del', 'void', 'raw', 'report']) expect(kinds).toContain(k);

    const invalid: string[] = [];
    for (const c of commands) {
      const res = await api.ctx.get(`/api/commands/${c.id}`);
      const detail = (await res.json()) as { requestXml: string | null; status: string };
      if (!detail.requestXml) {
        invalid.push(`${c.id} ${c.rqName ?? c.kind}: no request_xml (${detail.status})`);
        continue;
      }
      const v = validate(detail.requestXml);
      if (!v.valid)
        invalid.push(
          `${c.id} ${c.rqName ?? c.kind}: ${v.errors.map((e) => `line ${e.line}: ${e.message}`).join('; ')}`,
        );
    }
    expect(invalid, `${commands.length} commands checked`).toEqual([]);
    expect(commands.filter((c) => c.status === 'rejected')).toEqual([]);
    await api.dispose();
  });

  test('the relay mock logged no schema or well-formedness rejection', async () => {
    const mock = await relayMock();
    const log = await (await mock.get('/qb/errors')).text();
    const since = runStartedAt();
    const rejects = log
      .split('\n')
      .map((line) => /^\[([^\]]+)\] \[([A-Z_]+)\]/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .filter((m) => new Date(m[1]!) >= since)
      .filter((m) => m[2] === 'QB_PARSE_REJECT' || m[2] === 'XML_VALIDATION');
    expect(rejects.map((m) => m[0])).toEqual([]);
    await mock.dispose();
  });
});
