import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  countObjectsByType,
  createCommand,
  finishCommand,
  getCommand,
  getObject,
  getReportCache,
  getSyncState,
  getUserPermissions,
  hasPermission,
  listAudit,
  listCommands,
  listPendingCommands,
  markCommandSending,
  markDeleted,
  markMissingDeleted,
  migrateDown,
  migrateToLatest,
  migrationStatus,
  parseFilterParam,
  putReportCache,
  queryObjects,
  reportCacheKey,
  requeueCommand,
  seed,
  sql,
  upsertObjects,
  upsertSyncState,
  verifyPassword,
  writeAudit,
  findUserByEmail,
  QueryError,
  type Db,
} from '../src/index.js';
import { createTestDatabase, type TestDatabase } from '../src/testing.js';

let t: TestDatabase;
let db: Db;

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
});
afterAll(async () => {
  await t?.destroy();
});

const customer = { name: 'Customer', category: 'list', idField: 'ListID' } as const;
const invoice = { name: 'Invoice', category: 'txn', idField: 'TxnID' } as const;

function cust(id: string, fullName: string, extra: Record<string, unknown> = {}) {
  return {
    ListID: id,
    EditSequence: '1',
    Name: fullName.split(':').at(-1),
    FullName: fullName,
    IsActive: 'true',
    TimeModified: '2024-01-01T00:00:00-08:00',
    ...extra,
  };
}

describe('migrations', () => {
  it('creates every table and can roll back and forward', async () => {
    const tables = await sql<{ table_name: string }>`
      select table_name from information_schema.tables where table_schema = 'public' order by 1`.execute(
      db,
    );
    const names = tables.rows.map((r) => r.table_name);
    for (const tname of [
      'qb_object',
      'sync_state',
      'command',
      'app_user',
      'role',
      'user_role',
      'session',
      'api_token',
      'audit_log',
      'report_cache',
    ]) {
      expect(names).toContain(tname);
    }
    const idx = await sql<{
      indexname: string;
    }>`select indexname from pg_indexes where tablename = 'qb_object'`.execute(db);
    expect(idx.rows.map((r) => r.indexname)).toEqual(
      expect.arrayContaining([
        'qb_object_search_idx',
        'qb_object_data_idx',
        'qb_object_type_time_modified_idx',
        'qb_object_type_entity_ref_idx',
      ]),
    );
    const gen = await sql<{ is_generated: string }>`
      select is_generated from information_schema.columns where table_name = 'qb_object' and column_name = 'search'`.execute(
      db,
    );
    expect(gen.rows[0]?.is_generated).toBe('ALWAYS');

    await migrateDown(db);
    expect((await migrationStatus(db)).every((m) => !m.executedAt)).toBe(true);
    await migrateToLatest(db);
    expect((await migrationStatus(db)).every((m) => m.executedAt)).toBe(true);
  });
});

describe('qb_object repository', () => {
  beforeEach(async () => {
    await db.deleteFrom('qb_object').execute();
  });

  it('upserts, dedupes within a batch and returns typed rows', async () => {
    const n = await upsertObjects(db, customer, [
      cust('C1', 'Alpha'),
      cust('C2', 'Beta Corp', { Memo: 'loyal wholesale', TotalBalance: '10.5' }),
      cust('C2', 'Beta Corp', { Memo: 'loyal wholesale', TotalBalance: '11.5' }),
    ]);
    expect(n).toBe(2);
    const b = await getObject(db, 'Customer', 'C2');
    expect(b?.amount).toBe('11.50000');
    expect(b?.data.Memo).toBe('loyal wholesale');
    expect(b?.time_modified).toBeInstanceOf(Date);
    expect(await countObjectsByType(db)).toEqual({ Customer: 2 });
  });

  it('accepts an entity name string and infers the id field', async () => {
    await upsertObjects(db, 'Invoice', [{ TxnID: 'T1', TxnDate: '2024-05-06', RefNumber: '1' }]);
    const row = await getObject(db, 'Invoice', 'T1');
    expect(row?.txn_date).toBe('2024-05-06');
  });

  it('never overwrites a newer row with an older Ret', async () => {
    await upsertObjects(db, customer, [
      cust('C1', 'New name', { TimeModified: '2024-06-01T00:00:00Z', EditSequence: '9' }),
    ]);
    const n = await upsertObjects(db, customer, [
      cust('C1', 'Old name', { TimeModified: '2024-05-01T00:00:00Z', EditSequence: '8' }),
    ]);
    expect(n).toBe(0);
    expect((await getObject(db, 'Customer', 'C1'))?.name).toBe('New name');
    await upsertObjects(db, customer, [
      cust('C1', 'Newer', { TimeModified: '2024-07-01T00:00:00Z' }),
    ]);
    expect((await getObject(db, 'Customer', 'C1'))?.name).toBe('Newer');
  });

  it('soft-deletes, hides deleted rows and restores on re-upsert', async () => {
    await upsertObjects(db, customer, [cust('C1', 'A'), cust('C2', 'B'), cust('C3', 'C')]);
    expect(await markDeleted(db, 'Customer', ['C1'])).toBe(1);
    expect(await markDeleted(db, 'Customer', ['C1'])).toBe(0);
    expect(await getObject(db, 'Customer', 'C1')).toBeUndefined();
    expect(
      (await getObject(db, 'Customer', 'C1', { includeDeleted: true }))?.deleted_at,
    ).toBeInstanceOf(Date);
    expect(await markMissingDeleted(db, 'Customer', ['C2'])).toBe(1);
    expect((await queryObjects(db, { type: 'Customer' })).items.map((r) => r.qb_id)).toEqual([
      'C2',
    ]);
    await upsertObjects(db, customer, [cust('C1', 'A', { TimeModified: '2023-01-01T00:00:00Z' })]);
    expect((await getObject(db, 'Customer', 'C1'))?.deleted_at).toBeNull();
  });

  it('pages, sorts, filters and hides inactive rows', async () => {
    const rets = Array.from({ length: 25 }, (_, i) =>
      cust(`C${String(i).padStart(2, '0')}`, `Cust ${String(i).padStart(2, '0')}`, {
        IsActive: i % 5 === 0 ? 'false' : 'true',
        TotalBalance: String(i * 10),
      }),
    );
    await upsertObjects(db, customer, rets);
    const p1 = await queryObjects(db, { type: 'Customer', pageSize: 10, page: 1 });
    expect(p1.total).toBe(20);
    expect(p1.items).toHaveLength(10);
    expect(p1.items[0]!.name).toBe('Cust 01');
    const p3 = await queryObjects(db, { type: 'Customer', pageSize: 10, page: 3 });
    expect(p3.items).toHaveLength(0);
    const all = await queryObjects(db, { type: 'Customer', includeInactive: true, pageSize: 100 });
    expect(all.total).toBe(25);

    const sorted = await queryObjects(db, { type: 'Customer', sort: '-amount', pageSize: 3 });
    expect(sorted.items.map((r) => r.amount)).toEqual(['240.00000', '230.00000', '220.00000']);

    const filtered = await queryObjects(db, {
      type: 'Customer',
      filters: [parseFilterParam('amount', 'gte:100'), parseFilterParam('amount', 'lt:150')],
      sort: 'amount',
    });
    expect(filtered.items.map((r) => r.qb_id)).toEqual(['C11', 'C12', 'C13', 'C14']);

    const inList = await queryObjects(db, {
      type: 'Customer',
      filters: [parseFilterParam('ListID', 'in:C01,C02,C99')],
    });
    expect(inList.total).toBe(2);
    const inactive = await queryObjects(db, {
      type: 'Customer',
      includeInactive: true,
      filters: [parseFilterParam('IsActive', 'false')],
    });
    expect(inactive.total).toBe(5);
  });

  it('filters and sorts on JSON data paths', async () => {
    await upsertObjects(db, invoice, [
      {
        TxnID: 'I1',
        RefNumber: '1',
        TxnDate: '2024-01-01',
        CustomerRef: { ListID: 'C1', FullName: 'Alpha' },
        TermsRef: { FullName: 'Net 30' },
      },
      {
        TxnID: 'I2',
        RefNumber: '2',
        TxnDate: '2024-02-01',
        CustomerRef: { ListID: 'C2', FullName: 'Beta' },
        TermsRef: { FullName: 'Net 15' },
      },
      {
        TxnID: 'I3',
        RefNumber: '3',
        TxnDate: '2024-03-01',
        CustomerRef: { ListID: 'C1', FullName: 'Alpha' },
      },
    ]);
    const byCust = await queryObjects(db, {
      type: 'Invoice',
      filters: [parseFilterParam('CustomerRef.ListID', 'C1')],
      sort: '-TxnDate',
    });
    expect(byCust.items.map((r) => r.qb_id)).toEqual(['I3', 'I1']);
    const byEntity = await queryObjects(db, {
      type: 'Invoice',
      filters: [{ field: 'entity_ref_id', op: 'eq', value: 'C2' }],
    });
    expect(byEntity.items.map((r) => r.qb_id)).toEqual(['I2']);
    const like = await queryObjects(db, {
      type: 'Invoice',
      filters: [parseFilterParam('TermsRef.FullName', 'like:net')],
      sort: 'TermsRef.FullName',
    });
    expect(like.items.map((r) => r.qb_id)).toEqual(['I2', 'I1']);
    const noTerms = await queryObjects(db, {
      type: 'Invoice',
      filters: [parseFilterParam('TermsRef.FullName', 'isnull:')],
    });
    expect(noTerms.items.map((r) => r.qb_id)).toEqual(['I3']);
    const dates = await queryObjects(db, {
      type: 'Invoice',
      filters: [parseFilterParam('txn_date', 'gt:2024-01-15')],
      sort: 'txn_date',
    });
    expect(dates.items.map((r) => r.qb_id)).toEqual(['I2', 'I3']);
  });

  it('full-text searches name, ref number and memo with prefix matching', async () => {
    await upsertObjects(db, customer, [
      cust('C1', 'Smith Plumbing:Kitchen remodel'),
      cust('C2', 'Jones Electric', { Memo: 'Prefers email invoices' }),
      cust('C3', 'Smithers Ltd'),
    ]);
    await upsertObjects(db, invoice, [
      {
        TxnID: 'I1',
        RefNumber: 'INV-1001',
        CustomerRef: { ListID: 'C2', FullName: 'Jones Electric' },
      },
    ]);
    const smith = await queryObjects(db, { type: 'Customer', q: 'smith' });
    expect(smith.items.map((r) => r.qb_id).sort()).toEqual(['C1', 'C3']);
    expect(
      (await queryObjects(db, { type: 'Customer', q: 'kitch smith' })).items.map((r) => r.qb_id),
    ).toEqual(['C1']);
    expect(
      (await queryObjects(db, { type: 'Customer', q: 'invoices' })).items.map((r) => r.qb_id),
    ).toEqual(['C2']);
    expect(
      (await queryObjects(db, { type: 'Invoice', q: '1001' })).items.map((r) => r.qb_id),
    ).toEqual(['I1']);
    expect(
      (await queryObjects(db, { type: 'Customer', q: "'; drop table qb_object; --" })).total,
    ).toBe(0);
    expect((await queryObjects(db, { type: 'Customer', q: '!!!' })).total).toBe(3);
  });

  it('rejects unsafe field names and bad values', async () => {
    await expect(
      queryObjects(db, { type: 'Customer', sort: 'name; drop table x' }),
    ).rejects.toThrow(QueryError);
    await expect(
      queryObjects(db, { type: 'Customer', filters: [parseFilterParam('amount', 'gt:abc')] }),
    ).rejects.toThrow(QueryError);
    await expect(
      queryObjects(db, { type: 'Customer', filters: [parseFilterParam('txn_date', '2024/01/01')] }),
    ).rejects.toThrow(/YYYY-MM-DD/);
  });

  it('upserts large batches in chunks', async () => {
    const rets = Array.from({ length: 1234 }, (_, i) => cust(`B${i}`, `Bulk ${i}`));
    expect(await upsertObjects(db, customer, rets)).toBe(1234);
    expect((await queryObjects(db, { type: 'Customer', pageSize: 1 })).total).toBe(1234);
  });
});

describe('commands', () => {
  it('creates, claims, requeues and finishes a command', async () => {
    const c = await createCommand(db, {
      kind: 'add',
      rqName: 'CustomerAddRq',
      objectType: 'Customer',
      payload: { Name: 'X' },
      requestXml: '<QBXML/>',
      priority: 1,
      actorType: 'user',
      actorId: 'u1',
    });
    expect(c.status).toBe('queued');
    expect(c.attempts).toBe(0);
    expect(c.payload).toEqual({ Name: 'X' });

    const s1 = await markCommandSending(db, c.id);
    expect(s1?.status).toBe('sending');
    expect(s1?.attempts).toBe(1);
    const startedAt = s1!.started_at;
    expect(startedAt).toBeInstanceOf(Date);
    await requeueCommand(db, c.id, 'relay unavailable');
    const s2 = await markCommandSending(db, c.id);
    expect(s2?.attempts).toBe(2);
    expect(s2?.started_at?.getTime()).toBe(startedAt!.getTime());

    const done = await finishCommand(db, c.id, {
      status: 'succeeded',
      statusCode: 0,
      statusMessage: 'Status OK',
      responseXml: '<QBXML/>',
      result: [{ ListID: 'L1' }],
      objectId: 'L1',
    });
    expect(done?.finished_at).toBeInstanceOf(Date);
    expect(done?.result).toEqual([{ ListID: 'L1' }]);
    expect(await markCommandSending(db, c.id)).toBeUndefined();
    expect((await getCommand(db, c.id))?.object_id).toBe('L1');
    expect(await getCommand(db, 'not-a-uuid')).toBeUndefined();
  });

  it('lists newest first with keyset pagination and filters', async () => {
    await db.deleteFrom('command').execute();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const c = await createCommand(db, {
        kind: i % 2 ? 'mod' : 'add',
        objectType: 'Invoice',
        actorType: 'system',
      });
      ids.push(c.id);
    }
    const first = await listCommands(db, { limit: 2 });
    expect(first.map((c) => c.id)).toEqual([ids[4], ids[3]]);
    const next = await listCommands(db, { limit: 2, before: first[1]!.id });
    expect(next.map((c) => c.id)).toEqual([ids[2], ids[1]]);
    expect((await listCommands(db, { kind: 'mod' })).length).toBe(2);
    expect((await listPendingCommands(db)).length).toBe(5);
  });

  it('rejects invalid kinds and statuses at the database', async () => {
    await expect(
      sql`insert into command (kind, actor_type) values ('bogus', 'user')`.execute(db),
    ).rejects.toThrow(/check constraint/);
  });
});

describe('sync_state, audit, report cache', () => {
  it('upserts sync state partially', async () => {
    await upsertSyncState(db, 'Customer', {
      status: 'running',
      lastRunAt: new Date('2024-01-01T00:00:00Z'),
    });
    await upsertSyncState(db, 'Customer', {
      status: 'ok',
      rowCount: 42,
      lastModifiedCursor: '2024-01-02T00:00:00Z',
    });
    const s = await getSyncState(db, 'Customer');
    expect(s).toMatchObject({ status: 'ok', row_count: 42, error: null });
    expect(s?.last_run_at?.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(s?.last_modified_cursor?.toISOString()).toBe('2024-01-02T00:00:00.000Z');
  });

  it('writes and lists audit rows', async () => {
    const c = await createCommand(db, { kind: 'del', actorType: 'user', actorId: 'u9' });
    const id = await writeAudit(db, {
      actorType: 'user',
      actorId: 'u9',
      action: 'object.del',
      objectType: 'Customer',
      objectId: 'C1',
      commandId: c.id,
      ip: '10.0.0.1',
      detail: { reason: 'dup' },
    });
    expect(id).toMatch(/^\d+$/);
    const rows = await listAudit(db, { actorId: 'u9' });
    expect(rows[0]).toMatchObject({
      action: 'object.del',
      command_id: c.id,
      detail: { reason: 'dup' },
    });
  });

  it('caches reports with a TTL and stable keys', async () => {
    const key = reportCacheKey('ProfitAndLossStandard', { to: '2024-12-31', from: '2024-01-01' });
    expect(key).toBe(
      reportCacheKey('ProfitAndLossStandard', { from: '2024-01-01', to: '2024-12-31' }),
    );
    await putReportCache(db, {
      key,
      report: 'ProfitAndLossStandard',
      result: { rows: [1, 2] },
      ttlMs: 60_000,
    });
    expect((await getReportCache(db, key))?.result).toEqual({ rows: [1, 2] });
    expect(await getReportCache(db, key, { now: new Date(Date.now() + 120_000) })).toBeUndefined();
  });
});

describe('seed and permissions', () => {
  it('creates roles and an admin idempotently', async () => {
    const r1 = await seed(db, {
      adminEmail: 'Admin@Example.com',
      adminPassword: 'a-long-password-123',
    });
    expect(r1.rolesCreated.sort()).toEqual([
      'Accountant',
      'Admin',
      'Purchasing',
      'ReadOnly',
      'Sales',
    ]);
    expect(r1.adminCreated).toBe(true);
    const r2 = await seed(db, {
      adminEmail: 'admin@example.com',
      adminPassword: 'different-password!!',
    });
    expect(r2).toMatchObject({
      rolesCreated: [],
      adminCreated: false,
      adminUserId: r1.adminUserId,
    });
    const user = await findUserByEmail(db, 'ADMIN@example.com');
    expect(await verifyPassword(user!.password_hash!, 'a-long-password-123')).toBe(true);
    expect(user!.password_hash).toMatch(/^\$argon2id\$/);
    expect(await getUserPermissions(db, user!.id)).toEqual(['admin']);
  });

  it('matches permissions', () => {
    expect(hasPermission(['admin'], 'object:Invoice:write')).toBe(true);
    expect(hasPermission(['object:*:read'], 'object:Invoice:read')).toBe(true);
    expect(hasPermission(['object:*:read'], 'object:Invoice:write')).toBe(false);
    expect(hasPermission(['object:Invoice:write'], 'object:Invoice:read')).toBe(true);
    expect(hasPermission(['object:Invoice:write'], 'object:Bill:read')).toBe(false);
    expect(hasPermission(['report:*'], 'report:ar-aging')).toBe(true);
    expect(hasPermission(['report:*'], 'qbxml:raw')).toBe(false);
  });
});
