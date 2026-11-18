import {
  hashPassword,
  hashToken,
  sql,
  verifyPassword,
  writeAudit,
  findUserByEmail,
  getUserPermissions,
} from '@qbv/db';
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../context.js';
import { typed } from '../context.js';
import {
  clearSessionCookies,
  clientIp,
  randomId,
  requirePrincipal,
  setSessionCookies,
} from '../lib/auth.js';
import { HttpError } from '../lib/errors.js';
import { z } from '../lib/zod.js';
import type { Principal } from '../types.js';

// Verified against when the email is unknown, so timing does not reveal accounts.
let dummyHash: Promise<string> | undefined;

export function principalView(p: Principal) {
  return p.type === 'user'
    ? {
        type: 'user' as const,
        id: p.id,
        email: p.email,
        displayName: p.displayName,
        permissions: p.permissions,
        csrfToken: p.csrfToken,
        expiresAt: p.expiresAt.toISOString(),
      }
    : {
        type: 'token' as const,
        id: p.id,
        name: p.name,
        permissions: p.permissions,
      };
}

const LoginBody = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(1).max(1024),
});

export async function authRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const r = typed(app);
  const { deps } = ctx;
  const ttl = deps.config.SESSION_TTL;
  const secure = deps.config.COOKIE_SECURE;

  r.post(
    '/auth/login',
    {
      config: { public: true, rateLimit: 'login' },
      schema: {
        tags: ['auth'],
        summary: 'Log in with email and password; sets the session and CSRF cookies',
        body: LoginBody,
      },
    },
    async (req, reply) => {
      const { email, password } = req.body;
      const user = await findUserByEmail(deps.db, email);
      let ok = false;
      if (user?.password_hash) {
        ok = await verifyPassword(user.password_hash, password);
      } else {
        dummyHash ??= hashPassword(randomId());
        await verifyPassword(await dummyHash, password);
      }
      if (!user || !ok || !user.is_active) {
        await writeAudit(deps.db, {
          actorType: 'user',
          actorId: user?.id ?? null,
          action: 'auth.login_failed',
          ip: clientIp(req),
          detail: { email, reason: !user ? 'unknown_email' : !ok ? 'bad_password' : 'inactive' },
        });
        throw new HttpError(401, 'invalid_credentials', 'Invalid email or password');
      }

      const sessionId = randomId();
      const csrfToken = randomId(24);
      const expiresAt = new Date(Date.now() + ttl);
      await deps.db
        .deleteFrom('session')
        .where('expires_at', '<', sql<Date>`now()`)
        .execute();
      await deps.db
        .insertInto('session')
        .values({
          id: hashToken(sessionId),
          user_id: user.id,
          csrf_token: csrfToken,
          expires_at: expiresAt,
          ip: clientIp(req),
          user_agent: req.headers['user-agent']?.slice(0, 500) ?? null,
        })
        .execute();
      await deps.db
        .updateTable('app_user')
        .set({ last_login_at: sql`now()` })
        .where('id', '=', user.id)
        .execute();
      await writeAudit(deps.db, {
        actorType: 'user',
        actorId: user.id,
        action: 'auth.login',
        ip: clientIp(req),
      });
      setSessionCookies(reply, sessionId, csrfToken, { secure, ttlMs: ttl });
      const permissions = await getUserPermissions(deps.db, user.id);
      return {
        user: {
          type: 'user' as const,
          id: user.id,
          email: user.email,
          displayName: user.display_name,
          permissions,
        },
        csrfToken,
        expiresAt: expiresAt.toISOString(),
      };
    },
  );

  r.post(
    '/auth/logout',
    {
      config: { authenticated: true },
      schema: { tags: ['auth'], summary: 'End the current session' },
    },
    async (req, reply) => {
      const p = requirePrincipal(req);
      if (p.type === 'user') {
        await deps.db.deleteFrom('session').where('id', '=', p.sessionId).execute();
        await writeAudit(deps.db, {
          actorType: 'user',
          actorId: p.id,
          action: 'auth.logout',
          ip: clientIp(req),
        });
      }
      clearSessionCookies(reply, secure);
      return reply.code(204).send();
    },
  );

  r.get(
    '/auth/me',
    {
      config: { authenticated: true },
      schema: { tags: ['auth'], summary: 'The current user or token, with permissions' },
    },
    async (req) => {
      const p = requirePrincipal(req);
      return { principal: principalView(p), csrfToken: p.type === 'user' ? p.csrfToken : null };
    },
  );
}
