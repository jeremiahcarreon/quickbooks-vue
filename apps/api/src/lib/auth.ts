import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getUserPermissions, hashToken, hasPermission, safeEqual, sql } from '@qbv/db';
import type { AppDeps, Principal } from '../types.js';
import { forbidden, unauthorized } from './errors.js';

export const SESSION_COOKIE = 'qbv_session';
export const CSRF_COOKIE = 'qbv_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** last_used_at is written at most this often per token. */
const TOKEN_TOUCH_MS = 60_000;

export function randomId(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function bearerToken(req: FastifyRequest): string | null | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1]! : null;
}

async function principalFromToken(deps: AppDeps, token: string): Promise<Principal | null> {
  const row = await deps.db
    .selectFrom('api_token')
    .selectAll()
    .where('token_hash', '=', hashToken(token))
    .where('revoked_at', 'is', null)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`now()`)]))
    .executeTakeFirst();
  if (!row) return null;
  if (!row.last_used_at || Date.now() - row.last_used_at.getTime() > TOKEN_TOUCH_MS) {
    await deps.db
      .updateTable('api_token')
      .set({ last_used_at: sql`now()` })
      .where('id', '=', row.id)
      .execute();
  }
  return {
    type: 'token',
    id: row.id,
    name: row.name,
    permissions: [...row.permissions].sort(),
    createdBy: row.created_by,
  };
}

/** Read the signed session cookie; returns the raw session id or null. */
export function sessionIdFromCookie(req: FastifyRequest): string | null {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const u = req.unsignCookie(raw);
  return u.valid && u.value ? u.value : null;
}

async function principalFromSession(deps: AppDeps, sessionId: string): Promise<Principal | null> {
  const row = await deps.db
    .selectFrom('session')
    .innerJoin('app_user', 'app_user.id', 'session.user_id')
    .select([
      'session.id as sid',
      'session.csrf_token',
      'session.expires_at',
      'app_user.id as user_id',
      'app_user.email',
      'app_user.display_name',
      'app_user.is_active',
    ])
    .where('session.id', '=', hashToken(sessionId))
    .where('session.expires_at', '>', sql<Date>`now()`)
    .executeTakeFirst();
  if (!row || !row.is_active) return null;
  const permissions = await getUserPermissions(deps.db, row.user_id);
  return {
    type: 'user',
    id: row.user_id,
    email: row.email,
    displayName: row.display_name,
    permissions,
    sessionId: row.sid,
    csrfToken: row.csrf_token,
    expiresAt: row.expires_at,
  };
}

/**
 * Resolve the caller. A bearer token, when present, must be valid (no
 * fallback to the cookie). Returns null for anonymous requests.
 */
export async function authenticate(deps: AppDeps, req: FastifyRequest): Promise<Principal | null> {
  const bearer = bearerToken(req);
  if (bearer === null) throw unauthorized('Malformed Authorization header', 'invalid_token');
  if (bearer !== undefined) {
    const p = await principalFromToken(deps, bearer);
    if (!p) throw unauthorized('Invalid, expired or revoked API token', 'invalid_token');
    return p;
  }
  const sid = sessionIdFromCookie(req);
  if (!sid) return null;
  return principalFromSession(deps, sid);
}

/**
 * Double-submit CSRF check for cookie-authenticated, state-changing requests:
 * the X-CSRF-Token header must equal the session's token (also sent to the
 * browser in the readable qbv_csrf cookie and in /auth/login, /auth/me).
 */
export function checkCsrf(req: FastifyRequest, principal: Principal): void {
  if (principal.type !== 'user' || SAFE_METHODS.has(req.method)) return;
  const header = req.headers[CSRF_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !principal.csrfToken || !safeEqual(value, principal.csrfToken)) {
    throw forbidden('Missing or invalid CSRF token', 'csrf_failed');
  }
}

export function requirePrincipal(req: FastifyRequest): Principal {
  if (!req.principal) throw unauthorized();
  return req.principal;
}

export function can(req: FastifyRequest, permission: string): boolean {
  return !!req.principal && hasPermission(req.principal.permissions, permission);
}

/** Throw 401/403 unless the caller holds `permission`. */
export function authorize(req: FastifyRequest, permission: string): Principal {
  const p = requirePrincipal(req);
  if (!hasPermission(p.permissions, permission)) {
    throw forbidden(`Missing permission ${permission}`, 'forbidden', { permission });
  }
  return p;
}

export interface CookieSettings {
  secure: boolean;
  ttlMs: number;
}

export function setSessionCookies(
  reply: FastifyReply,
  sessionId: string,
  csrfToken: string,
  s: CookieSettings,
): void {
  const base = {
    path: '/',
    sameSite: 'lax' as const,
    secure: s.secure,
    maxAge: Math.floor(s.ttlMs / 1000),
  };
  reply.setCookie(SESSION_COOKIE, sessionId, { ...base, httpOnly: true, signed: true });
  reply.setCookie(CSRF_COOKIE, csrfToken, { ...base, httpOnly: false });
}

export function clearSessionCookies(reply: FastifyReply, secure: boolean): void {
  const base = { path: '/', sameSite: 'lax' as const, secure };
  reply.clearCookie(SESSION_COOKIE, { ...base, httpOnly: true });
  reply.clearCookie(CSRF_COOKIE, base);
}

export function actorOf(p: Principal): { actorType: 'user' | 'token'; actorId: string } {
  return { actorType: p.type, actorId: p.id };
}

export function clientIp(req: FastifyRequest): string | null {
  return req.ip || null;
}
