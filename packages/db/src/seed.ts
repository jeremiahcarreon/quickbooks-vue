import type { Db } from './client.js';
import { DEFAULT_ROLES, findUserByEmail, hashPassword } from './auth.js';

export interface SeedOptions {
  adminEmail?: string;
  adminPassword?: string;
  adminName?: string;
}

export interface SeedResult {
  rolesCreated: string[];
  adminCreated: boolean;
  adminUserId?: string;
}

/**
 * Idempotent: creates missing default roles and, when credentials are given,
 * the initial admin user with the Admin role. Never changes an existing
 * user's password or an existing role's permissions.
 */
export async function seed(db: Db, opts: SeedOptions = {}): Promise<SeedResult> {
  return db.transaction().execute(async (trx) => {
    const created = await trx
      .insertInto('role')
      .values(
        DEFAULT_ROLES.map((r) => ({
          name: r.name,
          description: r.description,
          permissions: r.permissions,
        })),
      )
      .onConflict((oc) => oc.column('name').doNothing())
      .returning('name')
      .execute();
    const result: SeedResult = { rolesCreated: created.map((r) => r.name), adminCreated: false };

    if (!opts.adminEmail || !opts.adminPassword) return result;
    const email = opts.adminEmail.trim().toLowerCase();
    let user = await findUserByEmail(trx as unknown as Db, email);
    if (!user) {
      user = await trx
        .insertInto('app_user')
        .values({
          email,
          display_name: opts.adminName ?? 'Administrator',
          password_hash: await hashPassword(opts.adminPassword),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      result.adminCreated = true;
    }
    const admin = await trx
      .selectFrom('role')
      .select('id')
      .where('name', '=', 'Admin')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('user_role')
      .values({ user_id: user.id, role_id: admin.id })
      .onConflict((oc) => oc.columns(['user_id', 'role_id']).doNothing())
      .execute();
    result.adminUserId = user.id;
    return result;
  });
}
