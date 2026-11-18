import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, userSession, type Session, type TestApp } from './helpers.js';

let t: TestApp;
let a: Session;
let b: Session;
let auditor: Session;
const ids: Record<string, string> = {};

beforeAll(async () => {
  t = await createTestApp();
  a = await userSession(t, { roles: ['Sales'] });
  b = await userSession(t, { roles: ['Sales'] });
  auditor = await userSession(t, { roles: ['Accountant'] }); // has command:read
  for (const [who, s] of [
    ['a', a],
    ['b', b],
  ] as const) {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/objects/Customer',
      headers: s.headers(),
      payload: { Name: `From ${who}` },
    });
    expect(res.statusCode).toBe(202);
    ids[who] = res.json().commandId;
  }
});
afterAll(async () => t?.close());

describe('/commands', () => {
  it('shows callers only their own commands', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/commands',
      headers: a.headers(false),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((c: { id: string }) => c.id)).toEqual([ids.a]);
  });

  it('shows everyone’s with command:read, newest first, filterable', async () => {
    const all = (
      await t.app.inject({ method: 'GET', url: '/api/commands', headers: auditor.headers(false) })
    ).json();
    expect(all.items.map((c: { id: string }) => c.id)).toEqual([ids.b, ids.a]);
    const mine = (
      await t.app.inject({
        method: 'GET',
        url: '/api/commands?mine=true',
        headers: auditor.headers(false),
      })
    ).json();
    expect(mine.items).toEqual([]);
    const page = (
      await t.app.inject({
        method: 'GET',
        url: '/api/commands?limit=1',
        headers: auditor.headers(false),
      })
    ).json();
    expect(page.items).toHaveLength(1);
    expect(page.nextBefore).toBe(ids.b);
    const next = (
      await t.app.inject({
        method: 'GET',
        url: `/api/commands?limit=1&before=${page.nextBefore}`,
        headers: auditor.headers(false),
      })
    ).json();
    expect(next.items[0].id).toBe(ids.a);
    const filtered = (
      await t.app.inject({
        method: 'GET',
        url: '/api/commands?status=queued,sending&kind=add',
        headers: auditor.headers(false),
      })
    ).json();
    expect(filtered.items).toHaveLength(2);
    const bad = await t.app.inject({
      method: 'GET',
      url: '/api/commands?status=bogus',
      headers: auditor.headers(false),
    });
    expect(bad.statusCode).toBe(400);
  });

  it('returns details (with qbXML) to the owner, 404 to others', async () => {
    const own = await t.app.inject({
      method: 'GET',
      url: `/api/commands/${ids.a}`,
      headers: a.headers(false),
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().requestXml).toContain('<CustomerAddRq');
    expect(own.json().payload).toEqual({ Name: 'From a' });
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: `/api/commands/${ids.a}`,
          headers: b.headers(false),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: `/api/commands/${ids.a}`,
          headers: auditor.headers(false),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: '/api/commands/not-a-uuid',
          headers: auditor.headers(false),
        })
      ).statusCode,
    ).toBe(404);
  });
});
