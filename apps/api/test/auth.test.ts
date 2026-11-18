import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAudit } from '@qbv/db';
import {
  bearer,
  cookieHeader,
  createTestApp,
  createToken,
  createUser,
  login,
  PASSWORD,
  type TestApp,
} from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
  await createUser(t.db, { email: 'admin@example.com', roles: ['Admin'] });
  await createUser(t.db, { email: 'off@example.com', roles: ['Admin'], isActive: false });
});
afterAll(async () => t?.close());

describe('session login', () => {
  it('sets an HttpOnly signed session cookie and a readable CSRF cookie', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'Admin@Example.com', password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.email).toBe('admin@example.com');
    expect(body.user.permissions).toEqual(['admin']);
    expect(typeof body.csrfToken).toBe('string');
    const session = res.cookies.find((c) => c.name === 'qbv_session')!;
    const csrf = res.cookies.find((c) => c.name === 'qbv_csrf')!;
    expect(session.httpOnly).toBe(true);
    expect(session.sameSite).toBe('Lax');
    expect(session.path).toBe('/');
    expect(session.value).toContain('.'); // signed
    expect(csrf.httpOnly).toBeFalsy();
    expect(csrf.value).toBe(body.csrfToken);

    // The session id is stored hashed, never in clear.
    const rows = await t.db.selectFrom('session').select('id').execute();
    const raw = decodeURIComponent(session.value).split('.')[0]!;
    expect(rows.some((r) => r.id === raw)).toBe(false);

    const me = await t.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: cookieHeader(res) },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().principal).toMatchObject({ type: 'user', email: 'admin@example.com' });
    expect(me.json().csrfToken).toBe(body.csrfToken);
  });

  it('rejects a bad password, unknown email and inactive user with the same 401, and audits them', async () => {
    for (const payload of [
      { email: 'admin@example.com', password: 'wrong password!!' },
      { email: 'nobody@example.com', password: PASSWORD },
      { email: 'off@example.com', password: PASSWORD },
    ]) {
      const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({
        error: { code: 'invalid_credentials', message: 'Invalid email or password' },
      });
    }
    const failed = await listAudit(t.db, { action: 'auth.login_failed' });
    expect(failed.map((a) => (a.detail as { reason: string }).reason).sort()).toEqual([
      'bad_password',
      'inactive',
      'unknown_email',
    ]);
    expect((await listAudit(t.db, { action: 'auth.login' })).length).toBeGreaterThan(0);
  });

  it('validates the login body', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('rejects requests without credentials and with a tampered cookie', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
    const s = await login(t.app, 'admin@example.com');
    const tampered = s.cookie.replace(
      /qbv_session=([^;]+)/,
      (_m, v: string) => `qbv_session=x${v}`,
    );
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: tampered },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });

  it('requires the CSRF header on state-changing cookie requests', async () => {
    const s = await login(t.app, 'admin@example.com');
    const no = await t.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: s.headers(false),
    });
    expect(no.statusCode).toBe(403);
    expect(no.json().error.code).toBe('csrf_failed');
    const wrong = await t.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: s.cookie, 'x-csrf-token': 'nope' },
    });
    expect(wrong.statusCode).toBe(403);
    // GET needs no CSRF token.
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: s.headers(false) }))
        .statusCode,
    ).toBe(200);

    const ok = await t.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: s.headers(),
    });
    expect(ok.statusCode).toBe(204);
    // Session is gone server-side.
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: s.headers(false) }))
        .statusCode,
    ).toBe(401);
    expect((await listAudit(t.db, { action: 'auth.logout' })).length).toBe(1);
  });

  it('expires sessions', async () => {
    const s = await login(t.app, 'admin@example.com');
    await t.db
      .updateTable('session')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('user_id', '=', s.userId)
      .execute();
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: s.headers(false) }))
        .statusCode,
    ).toBe(401);
  });

  it('drops a session when the user is deactivated', async () => {
    const id = await createUser(t.db, { email: 'temp@example.com', roles: ['ReadOnly'] });
    const s = await login(t.app, 'temp@example.com');
    await t.db.updateTable('app_user').set({ is_active: false }).where('id', '=', id).execute();
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: s.headers(false) }))
        .statusCode,
    ).toBe(401);
  });
});

describe('API tokens', () => {
  it('authenticates with a bearer token, without CSRF, and records last use', async () => {
    const { token, id } = await createToken(t.db, ['object:Customer:read']);
    const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer(token) });
    expect(me.statusCode).toBe(200);
    expect(me.json().principal).toMatchObject({
      type: 'token',
      id,
      permissions: ['object:Customer:read'],
    });
    const row = await t.db
      .selectFrom('api_token')
      .select('last_used_at')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.last_used_at).not.toBeNull();
  });

  it('rejects unknown, revoked, expired and malformed tokens', async () => {
    const revoked = await createToken(t.db, ['admin'], { revoked: true });
    const expired = await createToken(t.db, ['admin'], {
      expiresAt: new Date(Date.now() - 60_000),
    });
    for (const headers of [
      bearer('qbv_not-a-real-token'),
      bearer(revoked.token),
      bearer(expired.token),
      { authorization: 'Basic abc' },
    ]) {
      const res = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('invalid_token');
    }
  });

  it('a bad token is not rescued by a valid cookie', async () => {
    const s = await login(t.app, 'admin@example.com');
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { ...s.headers(false), ...bearer('qbv_bogus') },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('login rate limit', () => {
  it('returns 429 after too many attempts from one address', async () => {
    const t2 = await createTestApp();
    try {
      const codes: number[] = [];
      for (let i = 0; i < 12; i++) {
        const res = await t2.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email: 'nobody@example.com', password: 'whatever-123' },
        });
        codes.push(res.statusCode);
        if (res.statusCode === 429) {
          expect(res.json().error.code).toBe('rate_limited');
          expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
        }
      }
      expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
      expect(codes.slice(10)).toEqual([429, 429]);
    } finally {
      await t2.close();
    }
  });
});
