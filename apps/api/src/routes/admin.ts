import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  generateToken,
  hashPassword,
  hashToken,
  listAudit,
  sql,
  writeAudit,
  ACTOR_TYPES,
  type Db,
  type JsonValue,
  type RoleRow,
} from '@qbv/db';
import { typed, type RouteContext } from '../context.js';
import { actorOf, clientIp, requirePrincipal } from '../lib/auth.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { permissionErrors } from '../lib/permissions.js';
import { auditView, roleView, tokenView, userView } from '../lib/views.js';
import { z } from '../lib/zod.js';

const ADMIN = { permission: 'admin' } as const;
const ADMIN_WRITE = { permission: 'admin', rateLimit: 'write' } as const;
const IdParams = z.object({ id: z.string().uuid() });

const Permissions = z
  .array(z.string().min(1).max(200))
  .max(500)
  .superRefine((list, ctx) => {
    for (const msg of permissionErrors(list)) ctx.addIssue({ code: 'custom', message: msg });
  })
  .transform((l) => [...new Set(l)].sort());

const Password = z.string().min(12, 'must be at least 12 characters').max(1024);

const UserCreate = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  displayName: z.string().trim().min(1).max(200).optional(),
  password: Password,
  isActive: z.boolean().optional(),
  /** Role names or ids. */
  roles: z.array(z.string().min(1).max(200)).max(50).optional(),
});
const UserPatch = z
  .object({
    displayName: z.string().trim().min(1).max(200),
    password: Password,
    isActive: z.boolean(),
    roles: z.array(z.string().min(1).max(200)).max(50),
  })
  .partial();

const RoleCreate = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).optional(),
  permissions: Permissions,
});
const RolePatch = RoleCreate.partial();

const TokenCreate = z.object({
  name: z.string().trim().min(1).max(200),
  permissions: Permissions,
  expiresAt: z.iso.datetime({ offset: true }).optional(),
});
const TokenPatch = z
  .object({
    name: z.string().trim().min(1).max(200),
    permissions: Permissions,
    revoked: z.literal(true),
  })
  .partial();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveRoles(db: Db, refs: readonly string[]): Promise<RoleRow[]> {
  if (refs.length === 0) return [];
  const ids = refs.filter((r) => UUID.test(r));
  const rows = await db
    .selectFrom('role')
    .selectAll()
    .where((eb) =>
      eb.or([eb('name', 'in', [...refs]), ...(ids.length ? [eb('id', 'in', ids)] : [])]),
    )
    .execute();
  const missing = refs.filter((r) => !rows.some((x) => x.name === r || x.id === r));
  if (missing.length) throw badRequest('unknown_role', `Unknown role(s): ${missing.join(', ')}`);
  return rows;
}

async function rolesByUser(db: Db, userIds: string[]) {
  const map = new Map<string, { id: string; name: string }[]>();
  if (!userIds.length) return map;
  const rows = await db
    .selectFrom('user_role')
    .innerJoin('role', 'role.id', 'user_role.role_id')
    .select(['user_role.user_id', 'role.id', 'role.name'])
    .where('user_role.user_id', 'in', userIds)
    .orderBy('role.name')
    .execute();
  for (const r of rows) {
    const list = map.get(r.user_id) ?? [];
    list.push({ id: r.id, name: r.name });
    map.set(r.user_id, list);
  }
  return map;
}

/** Refuse a change that would leave no active user holding `admin`. */
async function assertAdminRemains(db: Db): Promise<void> {
  const row = await db
    .selectFrom('app_user')
    .innerJoin('user_role', 'user_role.user_id', 'app_user.id')
    .innerJoin('role', 'role.id', 'user_role.role_id')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('app_user.is_active', '=', true)
    .where(sql<boolean>`'admin' = any(role.permissions)`)
    .executeTakeFirstOrThrow();
  if (Number(row.n) === 0) {
    throw conflict('This change would leave no active administrator', 'last_admin');
  }
}

function audit(db: Db, req: FastifyRequest, action: string, objectId: string, detail?: JsonValue) {
  const p = requirePrincipal(req);
  return writeAudit(db, {
    ...actorOf(p),
    action,
    objectType: action.split('.')[1] ?? null,
    objectId,
    ip: clientIp(req),
    detail: detail ?? {},
  });
}

const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === '23505';

export async function adminRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const r = typed(app);
  const { db } = ctx.deps;

  // ---------------------------------------------------------------- users
  r.get(
    '/admin/users',
    { config: ADMIN, schema: { tags: ['admin'], summary: 'List users with their roles' } },
    async () => {
      const users = await db.selectFrom('app_user').selectAll().orderBy('email').execute();
      const roles = await rolesByUser(
        db,
        users.map((u) => u.id),
      );
      return { items: users.map((u) => userView(u, roles.get(u.id))) };
    },
  );

  r.get(
    '/admin/users/:id',
    { config: ADMIN, schema: { tags: ['admin'], summary: 'One user', params: IdParams } },
    async (req) => {
      const u = await db
        .selectFrom('app_user')
        .selectAll()
        .where('id', '=', req.params.id)
        .executeTakeFirst();
      if (!u) throw notFound('User not found');
      const roles = await rolesByUser(db, [u.id]);
      return userView(u, roles.get(u.id));
    },
  );

  r.post(
    '/admin/users',
    {
      config: ADMIN_WRITE,
      schema: { tags: ['admin'], summary: 'Create a user', body: UserCreate },
    },
    async (req, reply) => {
      const b = req.body;
      const roles = await resolveRoles(db, b.roles ?? []);
      const hash = await hashPassword(b.password);
      let user;
      try {
        user = await db.transaction().execute(async (trx) => {
          const u = await trx
            .insertInto('app_user')
            .values({
              email: b.email,
              display_name: b.displayName ?? b.email,
              password_hash: hash,
              is_active: b.isActive ?? true,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          if (roles.length) {
            await trx
              .insertInto('user_role')
              .values(roles.map((r) => ({ user_id: u.id, role_id: r.id })))
              .execute();
          }
          return u;
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('A user with that email exists', 'email_taken');
        throw err;
      }
      await audit(db, req, 'admin.user.create', user.id, {
        email: user.email,
        roles: roles.map((r) => r.name),
      });
      return reply.code(201).send(userView(user, roles));
    },
  );

  r.patch(
    '/admin/users/:id',
    {
      config: ADMIN_WRITE,
      schema: {
        tags: ['admin'],
        summary:
          'Update a user (name, password, active, roles). Password changes and deactivation end the user’s sessions',
        params: IdParams,
        body: UserPatch,
      },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const b = req.body;
      const id = req.params.id;
      if (b.isActive === false && p.type === 'user' && p.id === id) {
        throw badRequest('cannot_deactivate_self', 'You cannot deactivate your own account');
      }
      const roles = b.roles ? await resolveRoles(db, b.roles) : undefined;
      const hash = b.password ? await hashPassword(b.password) : undefined;
      const user = await db.transaction().execute(async (trx) => {
        const set: Record<string, unknown> = {};
        if (b.displayName !== undefined) set.display_name = b.displayName;
        if (b.isActive !== undefined) set.is_active = b.isActive;
        if (hash) set.password_hash = hash;
        const u = Object.keys(set).length
          ? await trx
              .updateTable('app_user')
              .set(set)
              .where('id', '=', id)
              .returningAll()
              .executeTakeFirst()
          : await trx.selectFrom('app_user').selectAll().where('id', '=', id).executeTakeFirst();
        if (!u) throw notFound('User not found');
        if (roles) {
          await trx.deleteFrom('user_role').where('user_id', '=', id).execute();
          if (roles.length) {
            await trx
              .insertInto('user_role')
              .values(roles.map((r) => ({ user_id: id, role_id: r.id })))
              .execute();
          }
        }
        if (b.isActive === false || roles) await assertAdminRemains(trx as unknown as Db);
        if (b.isActive === false || hash) {
          let del = trx.deleteFrom('session').where('user_id', '=', id);
          if (p.type === 'user' && p.id === id) del = del.where('id', '<>', p.sessionId);
          await del.execute();
        }
        return u;
      });
      await audit(db, req, 'admin.user.update', id, {
        fields: Object.keys(b).filter((k) => k !== 'password'),
        passwordChanged: !!hash,
        ...(roles ? { roles: roles.map((r) => r.name) } : {}),
      });
      const current = await rolesByUser(db, [id]);
      return userView(user, current.get(id));
    },
  );

  // ---------------------------------------------------------------- roles
  r.get(
    '/admin/roles',
    { config: ADMIN, schema: { tags: ['admin'], summary: 'List roles' } },
    async () => {
      const rows = await db
        .selectFrom('role')
        .leftJoin('user_role', 'user_role.role_id', 'role.id')
        .selectAll('role')
        .select((eb) => eb.fn.count<string>('user_role.user_id').as('user_count'))
        .groupBy('role.id')
        .orderBy('role.name')
        .execute();
      return { items: rows.map((r) => roleView(r, Number(r.user_count))) };
    },
  );

  r.post(
    '/admin/roles',
    {
      config: ADMIN_WRITE,
      schema: { tags: ['admin'], summary: 'Create a role', body: RoleCreate },
    },
    async (req, reply) => {
      const b = req.body;
      try {
        const role = await db
          .insertInto('role')
          .values({ name: b.name, description: b.description ?? '', permissions: b.permissions })
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(db, req, 'admin.role.create', role.id, {
          name: role.name,
          permissions: role.permissions,
        });
        return reply.code(201).send(roleView(role));
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('A role with that name exists', 'role_exists');
        throw err;
      }
    },
  );

  r.patch(
    '/admin/roles/:id',
    {
      config: ADMIN_WRITE,
      schema: { tags: ['admin'], summary: 'Update a role', params: IdParams, body: RolePatch },
    },
    async (req) => {
      const b = req.body;
      const id = req.params.id;
      let role;
      try {
        role = await db.transaction().execute(async (trx) => {
          const set: Record<string, unknown> = {};
          if (b.name !== undefined) set.name = b.name;
          if (b.description !== undefined) set.description = b.description;
          if (b.permissions !== undefined) set.permissions = b.permissions;
          const row = Object.keys(set).length
            ? await trx
                .updateTable('role')
                .set(set)
                .where('id', '=', id)
                .returningAll()
                .executeTakeFirst()
            : await trx.selectFrom('role').selectAll().where('id', '=', id).executeTakeFirst();
          if (!row) throw notFound('Role not found');
          if (b.permissions) await assertAdminRemains(trx as unknown as Db);
          return row;
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('A role with that name exists', 'role_exists');
        throw err;
      }
      await audit(db, req, 'admin.role.update', id, b as JsonValue);
      return roleView(role);
    },
  );

  r.delete(
    '/admin/roles/:id',
    {
      config: ADMIN_WRITE,
      schema: { tags: ['admin'], summary: 'Delete a role', params: IdParams },
    },
    async (req, reply) => {
      const id = req.params.id;
      const role = await db.transaction().execute(async (trx) => {
        const row = await trx
          .deleteFrom('role')
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirst();
        if (!row) throw notFound('Role not found');
        await assertAdminRemains(trx as unknown as Db);
        return row;
      });
      await audit(db, req, 'admin.role.delete', id, { name: role.name });
      return reply.code(204).send();
    },
  );

  // ---------------------------------------------------------------- tokens
  r.get(
    '/admin/tokens',
    {
      config: ADMIN,
      schema: {
        tags: ['admin'],
        summary: 'List API tokens (never the token itself)',
        querystring: z.object({ includeRevoked: z.enum(['true', 'false']).optional() }),
      },
    },
    async (req) => {
      let q = db.selectFrom('api_token').selectAll().orderBy('created_at', 'desc');
      if (req.query.includeRevoked !== 'true') q = q.where('revoked_at', 'is', null);
      return { items: (await q.execute()).map(tokenView) };
    },
  );

  r.post(
    '/admin/tokens',
    {
      config: ADMIN_WRITE,
      schema: {
        tags: ['admin'],
        summary: 'Create an API token. The token is returned once and stored hashed',
        body: TokenCreate,
      },
    },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const b = req.body;
      const token = generateToken('qbv');
      const row = await db
        .insertInto('api_token')
        .values({
          name: b.name,
          token_hash: hashToken(token),
          token_prefix: token.slice(0, 12),
          permissions: b.permissions,
          created_by: p.type === 'user' ? p.id : null,
          expires_at: b.expiresAt ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(db, req, 'admin.token.create', row.id, {
        name: row.name,
        permissions: row.permissions,
      });
      return reply.code(201).send({ ...tokenView(row), token });
    },
  );

  r.patch(
    '/admin/tokens/:id',
    {
      config: ADMIN_WRITE,
      schema: {
        tags: ['admin'],
        summary: 'Rename, change permissions or revoke a token',
        params: IdParams,
        body: TokenPatch,
      },
    },
    async (req) => {
      const b = req.body;
      const set: Record<string, unknown> = {};
      if (b.name !== undefined) set.name = b.name;
      if (b.permissions !== undefined) set.permissions = b.permissions;
      if (b.revoked) set.revoked_at = sql`coalesce(revoked_at, now())`;
      const row = Object.keys(set).length
        ? await db
            .updateTable('api_token')
            .set(set)
            .where('id', '=', req.params.id)
            .returningAll()
            .executeTakeFirst()
        : await db
            .selectFrom('api_token')
            .selectAll()
            .where('id', '=', req.params.id)
            .executeTakeFirst();
      if (!row) throw notFound('Token not found');
      await audit(db, req, b.revoked ? 'admin.token.revoke' : 'admin.token.update', row.id, {
        fields: Object.keys(b),
      });
      return tokenView(row);
    },
  );

  r.delete(
    '/admin/tokens/:id',
    {
      config: ADMIN_WRITE,
      schema: { tags: ['admin'], summary: 'Revoke a token', params: IdParams },
    },
    async (req, reply) => {
      const row = await db
        .updateTable('api_token')
        .set({ revoked_at: sql`coalesce(revoked_at, now())` })
        .where('id', '=', req.params.id)
        .returningAll()
        .executeTakeFirst();
      if (!row) throw notFound('Token not found');
      await audit(db, req, 'admin.token.revoke', row.id, { name: row.name });
      return reply.code(204).send();
    },
  );

  // ---------------------------------------------------------------- audit
  r.get(
    '/admin/audit',
    {
      config: ADMIN,
      schema: {
        tags: ['admin'],
        summary: 'Audit log, newest first (keyset paging with `before`)',
        querystring: z.object({
          actorType: z.enum(ACTOR_TYPES).optional(),
          actorId: z.string().max(100).optional(),
          action: z.string().max(100).optional(),
          objectType: z.string().max(100).optional(),
          objectId: z.string().max(100).optional(),
          commandId: z.string().uuid().optional(),
          before: z.string().regex(/^\d+$/).optional(),
          limit: z.coerce.number().int().min(1).max(1000).optional(),
        }),
      },
    },
    async (req) => {
      const limit = req.query.limit ?? 100;
      const rows = await listAudit(db, { ...req.query, limit });
      const last = rows[rows.length - 1];
      return {
        items: rows.map(auditView),
        nextBefore: rows.length === limit && last ? String(last.id) : null,
      };
    },
  );
}
