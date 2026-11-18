import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { permissionError } from '../src/lib/permissions.js';
import { bearer, createTestApp, createToken, userSession, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t?.close());

describe('/health', () => {
  it('is public and reports db, redis and relay', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.db.ok).toBe(true);
    expect(body.redis.ok).toBe(true);
    expect(body.relay).toMatchObject({ source: 'events', connected: null });
  });

  it('reflects relay.health events when no relay client is configured', async () => {
    await t.deps.events.publish({ type: 'relay.health', connected: true });
    await new Promise((r) => setTimeout(r, 100));
    const body = (await t.app.inject({ method: 'GET', url: '/api/health' })).json();
    expect(body.relay.connected).toBe(true);
  });

  it('pings the relay directly when RELAY_URL is set', async () => {
    const t2 = await createTestApp({ env: { RELAY_URL: 'http://127.0.0.1:9' } });
    try {
      const body = (await t2.app.inject({ method: 'GET', url: '/api/health' })).json();
      expect(body.relay).toMatchObject({ source: 'relay', ok: false, connected: false });
    } finally {
      await t2.close();
    }
  });
});

describe('OpenAPI', () => {
  it('requires authentication for the spec and UI', async () => {
    for (const url of ['/api/docs/json', '/api/docs', '/api/docs/static/index.html']) {
      const res = await t.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
      expect(res.json().error.code, url).toBe('unauthorized');
    }
    const bad = await t.app.inject({
      method: 'GET',
      url: '/api/docs/json',
      headers: bearer('qbv_not_a_real_token'),
    });
    expect(bad.statusCode).toBe(401);
  });

  it('serves the spec and UI under /api/docs to any signed-in user or token', async () => {
    const s = await userSession(t, { roles: ['ReadOnly'] });
    const viaSession = await t.app.inject({
      method: 'GET',
      url: '/api/docs/json',
      headers: s.headers(false),
    });
    expect(viaSession.statusCode).toBe(200);
    const tok = (await createToken(t.db, ['object:Customer:read'])).token;
    const spec = await t.app.inject({ method: 'GET', url: '/api/docs/json', headers: bearer(tok) });
    expect(spec.statusCode).toBe(200);
    const doc = spec.json();
    expect(doc.openapi).toMatch(/^3\./);
    for (const p of [
      '/api/auth/login',
      '/api/objects/{type}',
      '/api/objects/{type}/{id}',
      '/api/objects/{type}/{id}/void',
      '/api/commands/{id}',
      '/api/qbxml',
      '/api/events',
      '/api/admin/users',
      '/api/admin/sync/{type}',
      '/api/meta/entities/{type}',
      '/api/health',
    ]) {
      expect(doc.paths[p], p).toBeTruthy();
    }
    const login = doc.paths['/api/auth/login'].post;
    expect(login.requestBody.content['application/json'].schema.properties.email).toBeTruthy();
    const list = doc.paths['/api/objects/{type}'].get;
    expect(list.parameters.map((p: { name: string }) => p.name)).toEqual(
      expect.arrayContaining(['type', 'q', 'page', 'pageSize']),
    );
    const ui = await t.app.inject({ method: 'GET', url: '/api/docs', headers: bearer(tok) });
    expect([200, 302]).toContain(ui.statusCode);
  });
});

describe('reports', () => {
  it('answers 501 behind authentication when the reports package is not mounted', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/reports' })).statusCode).toBe(401);
    const s = await userSession(t, { roles: ['ReadOnly'] });
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/reports',
      headers: s.headers(false),
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error.code).toBe('not_implemented');
    const tok = (await createToken(t.db, ['object:*:read'])).token;
    const denied = await t.app.inject({
      method: 'GET',
      url: '/api/reports/profit_and_loss',
      headers: bearer(tok),
    });
    expect(denied.statusCode).toBe(403);
  });
});

describe('routing and guards', () => {
  it('404s unknown routes in the error format', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'not_found', message: 'Route GET /api/nope not found' },
    });
  });

  it('refuses to register an API route without an access rule', async () => {
    const app = await buildApp(t.deps, { reports: 'disabled' });
    try {
      expect(() => app.get('/api/unguarded', async () => 'x')).toThrow(/declares no access rule/);
      expect(() =>
        app.get('/api/guarded', { config: { permission: 'admin' } }, async () => 'x'),
      ).not.toThrow();
      expect(() => app.get('/outside', async () => 'x')).not.toThrow();
    } finally {
      await app.close();
    }
  });

  it('enforces RBAC per entity type', async () => {
    const s = await userSession(t, { permissions: ['object:Customer:read'] });
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: '/api/objects/Customer',
          headers: s.headers(false),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/objects/Vendor', headers: s.headers(false) }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/objects/Customer',
          headers: s.headers(),
          payload: { Name: 'x' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/admin/users', headers: s.headers(false) }))
        .statusCode,
    ).toBe(403);
  });
});

describe('permissionError', () => {
  it('validates the permission grammar', () => {
    for (const ok of [
      'admin',
      'command:read',
      'qbxml:raw',
      'object:*:read',
      'object:Invoice:write',
      'report:*',
      'report:ar_aging',
    ])
      expect(permissionError(ok), ok).toBeNull();
    for (const bad of [
      'root',
      'object:Invoice',
      'object:Invoice:delete',
      'object:Nope:read',
      'report:',
      'report:a:b',
    ])
      expect(permissionError(bad), bad).not.toBeNull();
  });
});
