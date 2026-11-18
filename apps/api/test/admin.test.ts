import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAudit } from '@qbv/db';
import {
  bearer,
  createTestApp,
  login,
  userSession,
  type Session,
  type TestApp,
} from './helpers.js';

let t: TestApp;
let admin: Session;
let sales: Session;
beforeAll(async () => {
  t = await createTestApp();
  admin = await userSession(t, { roles: ['Admin'] });
  sales = await userSession(t, { roles: ['Sales'] });
});
afterAll(async () => t?.close());

const call = (
  s: Session,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
) =>
  t.app.inject({
    method,
    url,
    headers: s.headers(method !== 'GET'),
    ...(payload ? { payload } : {}),
  });

describe('admin access', () => {
  it('is admin-only', async () => {
    for (const [m, u] of [
      ['GET', '/api/admin/users'],
      ['GET', '/api/admin/roles'],
      ['GET', '/api/admin/tokens'],
      ['GET', '/api/admin/sync'],
      ['GET', '/api/admin/audit'],
      ['POST', '/api/admin/sync/Customer'],
    ] as const) {
      const res = await call(sales, m, u);
      expect(res.statusCode, `${m} ${u}`).toBe(403);
    }
  });
});

describe('users', () => {
  let userId: string;
  it('creates, lists and reads users', async () => {
    const res = await call(admin, 'POST', '/api/admin/users', {
      email: 'New.User@Example.com',
      displayName: 'New User',
      password: 'a-long-enough-password',
      roles: ['ReadOnly'],
    });
    expect(res.statusCode, res.body).toBe(201);
    const u = res.json();
    userId = u.id;
    expect(u).toMatchObject({
      email: 'new.user@example.com',
      isActive: true,
      roles: [{ name: 'ReadOnly' }],
    });
    expect(JSON.stringify(u)).not.toContain('password');
    const list = (await call(admin, 'GET', '/api/admin/users')).json();
    expect(list.items.some((x: { id: string }) => x.id === userId)).toBe(true);
    expect((await call(admin, 'GET', `/api/admin/users/${userId}`)).json().displayName).toBe(
      'New User',
    );
    const dup = await call(admin, 'POST', '/api/admin/users', {
      email: 'new.user@example.com',
      password: 'a-long-enough-password',
    });
    expect(dup.statusCode).toBe(409);
    const weak = await call(admin, 'POST', '/api/admin/users', {
      email: 'w@example.com',
      password: 'short',
    });
    expect(weak.statusCode).toBe(400);
    const badRole = await call(admin, 'POST', '/api/admin/users', {
      email: 'r@example.com',
      password: 'a-long-enough-password',
      roles: ['Nope'],
    });
    expect(badRole.json().error.code).toBe('unknown_role');
  });

  it('updates roles and password; a password change ends the user’s sessions', async () => {
    const s = await login(t.app, 'new.user@example.com', 'a-long-enough-password');
    const res = await call(admin, 'PATCH', `/api/admin/users/${userId}`, {
      roles: ['Sales'],
      password: 'another-long-password',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().roles.map((r: { name: string }) => r.name)).toEqual(['Sales']);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: s.headers(false) }))
        .statusCode,
    ).toBe(401);
    await login(t.app, 'new.user@example.com', 'another-long-password');
    const audit = await listAudit(t.db, { action: 'admin.user.update', objectId: userId });
    expect(audit[0]!.detail).toMatchObject({ passwordChanged: true, roles: ['Sales'] });
    expect(JSON.stringify(audit[0]!.detail)).not.toContain('another-long-password');
  });

  it('protects against locking out the last admin', async () => {
    const self = await call(admin, 'PATCH', `/api/admin/users/${admin.userId}`, {
      isActive: false,
    });
    expect(self.json().error.code).toBe('cannot_deactivate_self');
    const demote = await call(admin, 'PATCH', `/api/admin/users/${admin.userId}`, {
      roles: ['ReadOnly'],
    });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().error.code).toBe('last_admin');
    // Rolled back: still admin.
    expect((await call(admin, 'GET', '/api/admin/users')).statusCode).toBe(200);
  });
});

describe('roles', () => {
  it('creates, updates and deletes roles with validated permissions', async () => {
    const bad = await call(admin, 'POST', '/api/admin/roles', {
      name: 'Bad',
      permissions: ['object:Nope:read', 'root'],
    });
    expect(bad.statusCode).toBe(400);
    expect(JSON.stringify(bad.json().error.details)).toContain('unknown entity Nope');

    const res = await call(admin, 'POST', '/api/admin/roles', {
      name: 'Collections',
      description: 'A/R follow-up',
      permissions: [
        'object:Customer:read',
        'object:Invoice:read',
        'report:ar_aging',
        'object:Customer:read',
      ],
    });
    expect(res.statusCode, res.body).toBe(201);
    const role = res.json();
    expect(role.permissions).toEqual([
      'object:Customer:read',
      'object:Invoice:read',
      'report:ar_aging',
    ]);
    expect(
      (await call(admin, 'POST', '/api/admin/roles', { name: 'Collections', permissions: [] }))
        .statusCode,
    ).toBe(409);

    const upd = await call(admin, 'PATCH', `/api/admin/roles/${role.id}`, {
      permissions: ['object:*:read'],
    });
    expect(upd.json().permissions).toEqual(['object:*:read']);
    const list = (await call(admin, 'GET', '/api/admin/roles')).json();
    expect(list.items.find((r: { name: string }) => r.name === 'Admin').userCount).toBeGreaterThan(
      0,
    );

    expect((await call(admin, 'DELETE', `/api/admin/roles/${role.id}`)).statusCode).toBe(204);
    expect((await call(admin, 'DELETE', `/api/admin/roles/${role.id}`)).statusCode).toBe(404);

    const adminRole = list.items.find((r: { name: string }) => r.name === 'Admin');
    const strip = await call(admin, 'PATCH', `/api/admin/roles/${adminRole.id}`, {
      permissions: ['object:*:read'],
    });
    expect(strip.json().error.code).toBe('last_admin');
  });
});

describe('tokens', () => {
  it('returns the token once, stores it hashed, and revocation takes effect immediately', async () => {
    const res = await call(admin, 'POST', '/api/admin/tokens', {
      name: 'ERP sync',
      permissions: ['object:Customer:read'],
    });
    expect(res.statusCode).toBe(201);
    const { token, id, tokenPrefix } = res.json();
    expect(token).toMatch(/^qbv_/);
    expect(token.startsWith(tokenPrefix)).toBe(true);
    const row = await t.db
      .selectFrom('api_token')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.token_hash).not.toContain(token);
    expect(row.created_by).toBe(admin.userId);

    const list = (await call(admin, 'GET', '/api/admin/tokens')).json();
    expect(JSON.stringify(list)).not.toContain(token);

    expect(
      (await t.app.inject({ method: 'GET', url: '/api/objects/Customer', headers: bearer(token) }))
        .statusCode,
    ).toBe(200);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/objects/Invoice', headers: bearer(token) }))
        .statusCode,
    ).toBe(403);

    const upd = await call(admin, 'PATCH', `/api/admin/tokens/${id}`, {
      permissions: ['object:*:read'],
    });
    expect(upd.json().permissions).toEqual(['object:*:read']);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/objects/Invoice', headers: bearer(token) }))
        .statusCode,
    ).toBe(200);

    expect((await call(admin, 'DELETE', `/api/admin/tokens/${id}`)).statusCode).toBe(204);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/objects/Customer', headers: bearer(token) }))
        .statusCode,
    ).toBe(401);
    const all = (await call(admin, 'GET', '/api/admin/tokens?includeRevoked=true')).json();
    expect(all.items.find((x: { id: string }) => x.id === id).revokedAt).not.toBeNull();
    const actions = (await listAudit(t.db, { objectId: id })).map((a) => a.action).sort();
    expect(actions).toEqual(['admin.token.create', 'admin.token.revoke', 'admin.token.update']);
  });
});

describe('sync', () => {
  it('queues a manual sync request for the sync service and audits it', async () => {
    const res = await call(admin, 'POST', '/api/admin/sync/Customer', { mode: 'full' });
    expect(res.statusCode, res.body).toBe(202);
    const raw = await t.deps.redis.lrange(`${t.prefix}:sync:requests`, 0, -1);
    expect(raw).toHaveLength(1);
    expect(JSON.parse(raw[0]!)).toMatchObject({
      type: 'Customer',
      mode: 'full',
      requestedBy: `user:${admin.userId}`,
    });
    const star = await call(admin, 'POST', '/api/admin/sync/*');
    expect(star.statusCode, star.body).toBe(202);
    expect((await call(admin, 'POST', '/api/admin/sync/Nope')).statusCode).toBe(404);
    expect(
      (await call(admin, 'POST', '/api/admin/sync/Customer', { mode: 'sometimes' })).statusCode,
    ).toBe(400);
    const status = (await call(admin, 'GET', '/api/admin/sync')).json();
    expect(status.pendingRequests).toHaveLength(2);
    expect(status.entities).toContain('Invoice');
    expect((await listAudit(t.db, { action: 'admin.sync.trigger' })).length).toBe(2);
  });

  it('reports sync_state rows', async () => {
    await t.db
      .insertInto('sync_state')
      .values({ type: 'Customer', status: 'ok', row_count: 12 })
      .execute();
    const status = (await call(admin, 'GET', '/api/admin/sync')).json();
    expect(status.states).toEqual([
      expect.objectContaining({ type: 'Customer', status: 'ok', rowCount: 12 }),
    ]);
  });
});

describe('audit', () => {
  it('lists the audit log with filters and paging', async () => {
    const page = (await call(admin, 'GET', '/api/admin/audit?limit=2')).json();
    expect(page.items).toHaveLength(2);
    expect(page.nextBefore).toBeTruthy();
    const logins = (await call(admin, 'GET', '/api/admin/audit?action=auth.login')).json();
    expect(logins.items.every((a: { action: string }) => a.action === 'auth.login')).toBe(true);
  });
});

describe('sync plan agreement', () => {
  it('lists exactly the entities the sync service plans to load', async () => {
    const { planSync } = await import('@qbv/sync');
    const { syncableEntities } = await import('../src/routes/admin-sync.js');
    const plan = planSync();
    const planned = plan.units.flatMap((u) => u.entities.map((e) => e.name)).sort();
    expect(syncableEntities()).toEqual(planned);
  });
});
