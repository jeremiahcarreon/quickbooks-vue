import { randomBytes } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { Worker } from 'bullmq';
import { loadConfig, type ApiConfig } from '@qbv/config';
import { testEnv } from '@qbv/config/testing';
import {
  finishCommand,
  generateToken,
  getCommand,
  hashPassword,
  hashToken,
  seed,
  upsertObjects,
  type CommandRow,
  type Db,
} from '@qbv/db';
import { createTestDatabase, type TestDatabase } from '@qbv/db/testing';
import { buildResponse, catalog, validate } from '@qbv/qbxml';
import { createRedis, RELAY_QUEUE, type RelayJobData } from '@qbv/queue';
import { expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { closeDeps, createDeps } from '../src/deps.js';
import { requestNames } from '../src/routes/qbxml.js';
import type { AppDeps, AppOptions } from '../src/types.js';

export const PASSWORD = 'correct horse battery staple';

export interface TestApp {
  app: FastifyInstance;
  deps: AppDeps;
  db: Db;
  config: ApiConfig;
  tdb: TestDatabase;
  prefix: string;
  close(): Promise<void>;
}

export async function createTestApp(
  opts: { env?: Record<string, string | undefined>; app?: AppOptions } = {},
): Promise<TestApp> {
  const tdb = await createTestDatabase({ prefix: 'qbv_api' });
  await seed(tdb.db);
  const prefix = `qbvt${randomBytes(4).toString('hex')}`;
  const config = loadConfig(
    'api',
    testEnv({
      DATABASE_URL: tdb.url,
      QUEUE_PREFIX: prefix,
      RELAY_URL: '',
      ...opts.env,
    }),
  );
  const deps = createDeps(config, undefined, { eventsChannel: `${prefix}:events` });
  const app = await buildApp(deps, { reports: 'disabled', ...opts.app });
  await app.ready();
  return {
    app,
    deps,
    db: deps.db,
    config,
    tdb,
    prefix,
    async close() {
      await app.close();
      const keys = await deps.redis.keys(`${prefix}:*`);
      if (keys.length) await deps.redis.del(...keys);
      await closeDeps(deps);
      await tdb.destroy();
    },
  };
}

export async function createUser(
  db: Db,
  opts: { email: string; roles?: string[]; permissions?: string[]; isActive?: boolean },
): Promise<string> {
  const user = await db
    .insertInto('app_user')
    .values({
      email: opts.email,
      display_name: opts.email.split('@')[0]!,
      password_hash: await hashPassword(PASSWORD),
      is_active: opts.isActive ?? true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const roleNames = [...(opts.roles ?? [])];
  if (opts.permissions) {
    const name = `custom-${randomBytes(4).toString('hex')}`;
    await db.insertInto('role').values({ name, permissions: opts.permissions }).execute();
    roleNames.push(name);
  }
  if (roleNames.length) {
    const roles = await db.selectFrom('role').select('id').where('name', 'in', roleNames).execute();
    await db
      .insertInto('user_role')
      .values(roles.map((r) => ({ user_id: user.id, role_id: r.id })))
      .execute();
  }
  return user.id;
}

export async function createToken(
  db: Db,
  permissions: string[],
  extra: { expiresAt?: Date; revoked?: boolean } = {},
): Promise<{ token: string; id: string }> {
  const token = generateToken('qbv');
  const row = await db
    .insertInto('api_token')
    .values({
      name: `t-${randomBytes(3).toString('hex')}`,
      token_hash: hashToken(token),
      token_prefix: token.slice(0, 12),
      permissions,
      expires_at: extra.expiresAt ?? null,
      revoked_at: extra.revoked ? new Date() : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { token, id: row.id };
}

/** A logged-in browser: cookie header plus the CSRF token. */
export interface Session {
  cookie: string;
  csrf: string;
  userId: string;
  headers(write?: boolean): Record<string, string>;
}

export function cookieHeader(res: LightMyRequestResponse): string {
  return res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

export async function login(
  app: FastifyInstance,
  email: string,
  password = PASSWORD,
): Promise<Session> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json() as { csrfToken: string; user: { id: string } };
  const cookie = cookieHeader(res);
  return {
    cookie,
    csrf: body.csrfToken,
    userId: body.user.id,
    headers(write = true): Record<string, string> {
      return write ? { cookie, 'x-csrf-token': body.csrfToken } : { cookie };
    },
  };
}

export async function userSession(
  t: TestApp,
  opts: { roles?: string[]; permissions?: string[] },
): Promise<Session> {
  const email = `u${randomBytes(4).toString('hex')}@example.com`;
  await createUser(t.db, { email, ...opts });
  return login(t.app, email);
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Assert an XML document validates against the Intuit XSD. */
export function expectXsdValid(xml: string | null | undefined): void {
  expect(xml, 'qbXML present').toBeTruthy();
  const r = validate(xml!);
  expect(r.errors, 'XSD errors').toEqual([]);
  expect(r.valid).toBe(true);
}

let seq = 1000;
export function sampleRet(
  entity: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  const e = catalog.entities[entity]!;
  const now = '2024-02-01T10:00:00-08:00';
  const base: Record<string, unknown> =
    e.idField === 'TxnID'
      ? {
          TxnID: `${++seq}-1700000000`,
          TimeCreated: now,
          TimeModified: now,
          EditSequence: '1700000000',
          TxnNumber: String(seq),
          TxnDate: '2024-02-01',
          RefNumber: `R-${seq}`,
        }
      : {
          ListID: `80000${++seq}-1700000000`,
          TimeCreated: now,
          TimeModified: now,
          EditSequence: '1700000000',
          Name: `Name ${seq}`,
          FullName: `Name ${seq}`,
          IsActive: 'true',
        };
  return { ...base, ...fields };
}

export type FakeOutcome =
  | { kind: 'succeed'; ret?: Record<string, unknown> }
  | { kind: 'fail'; statusCode: number; message: string }
  | { kind: 'conflict' };

/**
 * Stand-in for apps/worker: asserts every queued request validates against
 * the XSD, answers with a schema-valid response built by buildResponse, writes
 * through to the read model and publishes command.updated.
 */
export function startFakeWorker(
  t: TestApp,
  decide: (c: CommandRow) => FakeOutcome = () => ({ kind: 'succeed' }),
): { worker: Worker; seen: CommandRow[]; invalid: string[]; close(): Promise<void> } {
  const seen: CommandRow[] = [];
  const invalid: string[] = [];
  const connection = createRedis(t.config.REDIS_URL);
  const worker = new Worker<RelayJobData>(
    RELAY_QUEUE,
    async (job) => {
      const c = (await getCommand(t.db, job.data.commandId))!;
      seen.push(c);
      const v = validate(c.request_xml ?? '');
      if (!v.valid) {
        invalid.push(c.id);
        await finishCommand(t.db, c.id, { status: 'rejected', statusMessage: 'invalid' });
        return;
      }
      const outcome = decide(c);
      const names = requestNames(c.request_xml!);
      let objectId: string | null = c.object_id;
      let responseXml: string;
      if (outcome.kind === 'succeed') {
        responseXml = buildResponse(
          names.map((rq, i) => {
            const def = catalog.requests[rq]!;
            const rs = def.response;
            let body: Record<string, unknown> = {};
            const retEl = def.retElement;
            if (retEl && (def.op === 'Add' || def.op === 'Mod' || def.op === 'Query')) {
              const ent = def.entity ?? retEl.replace(/Ret$/, '');
              const ret =
                outcome.ret ??
                sampleRet(
                  ent,
                  c.object_id && catalog.entities[ent]?.idField
                    ? { [catalog.entities[ent]!.idField!]: c.object_id }
                    : {},
                );
              body = { [retEl]: def.op === 'Query' ? [ret] : ret };
            } else if (def.op === 'Del' || def.op === 'Void') {
              const m = /<(List|Txn)(Del|Void)Type>([^<]+)</.exec(c.request_xml!);
              const idm = /<(ListID|TxnID)>([^<]+)</.exec(c.request_xml!);
              body =
                def.op === 'Void'
                  ? { TxnVoidType: m![3], TxnID: idm![2] }
                  : m![1] === 'List'
                    ? {
                        ListDelType: m![3],
                        ListID: idm![2],
                        TimeDeleted: '2024-02-01T10:00:00-08:00',
                        FullName: 'Deleted',
                      }
                    : {
                        TxnDelType: m![3],
                        TxnID: idm![2],
                        TimeDeleted: '2024-02-01T10:00:00-08:00',
                      };
            }
            return { rs, body, requestID: String(i) };
          }),
        );
        if (c.object_type && (names[0]?.endsWith('AddRq') || names[0]?.endsWith('ModRq'))) {
          const e = catalog.entities[c.object_type]!;
          const ret =
            outcome.ret ??
            sampleRet(c.object_type, c.object_id && e.idField ? { [e.idField]: c.object_id } : {});
          await upsertObjects(t.db, e, [ret]);
          objectId = String(ret[e.idField!]);
        }
        await finishCommand(t.db, c.id, {
          status: 'succeeded',
          statusCode: 0,
          statusMessage: 'Status OK',
          responseXml,
          objectId,
        });
      } else if (outcome.kind === 'conflict') {
        responseXml = buildResponse([
          {
            rs: catalog.requests[names[0]!]!.response,
            statusCode: 3200,
            statusSeverity: 'Error',
            statusMessage: 'The provided edit sequence is out-of-date.',
          },
        ]);
        await finishCommand(t.db, c.id, {
          status: 'conflict',
          statusCode: 3200,
          statusMessage: 'The provided edit sequence is out-of-date.',
          responseXml,
        });
      } else {
        responseXml = buildResponse([
          {
            rs: catalog.requests[names[0]!]!.response,
            statusCode: outcome.statusCode,
            statusSeverity: 'Error',
            statusMessage: outcome.message,
          },
        ]);
        await finishCommand(t.db, c.id, {
          status: 'failed',
          statusCode: outcome.statusCode,
          statusMessage: outcome.message,
          responseXml,
        });
      }
      const after = (await getCommand(t.db, c.id))!;
      await t.deps.events.publish({
        type: 'command.updated',
        id: c.id,
        status: after.status,
        actorType: after.actor_type,
        actorId: after.actor_id,
      });
    },
    { connection, prefix: t.prefix, concurrency: 1 },
  );
  return {
    worker,
    seen,
    invalid,
    async close() {
      await worker.close();
      await connection.quit().catch(() => connection.disconnect());
    },
  };
}

export async function commandCount(db: Db): Promise<number> {
  const r = await db
    .selectFrom('command')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .executeTakeFirstOrThrow();
  return Number(r.n);
}
