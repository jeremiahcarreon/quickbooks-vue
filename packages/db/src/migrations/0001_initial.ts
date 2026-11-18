import { sql, type Kysely } from 'kysely';

// Migrations use Kysely<any>: they must not depend on the current Database type.
/* eslint-disable @typescript-eslint/no-explicit-any */

export async function up(db: Kysely<any>): Promise<void> {
  // ---- read model -------------------------------------------------------
  await db.schema
    .createTable('qb_object')
    .addColumn('type', 'text', (c) => c.notNull())
    .addColumn('qb_id', 'text', (c) => c.notNull())
    .addColumn('edit_sequence', 'text')
    .addColumn('name', 'text')
    .addColumn('ref_number', 'text')
    .addColumn('txn_date', 'date')
    .addColumn('entity_ref_id', 'text')
    .addColumn('amount', sql`numeric(18,5)`)
    .addColumn('is_active', 'boolean')
    .addColumn('time_created', 'timestamptz')
    .addColumn('time_modified', 'timestamptz')
    .addColumn('data', 'jsonb', (c) => c.notNull())
    .addColumn('synced_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('deleted_at', 'timestamptz')
    .addColumn('search', sql`tsvector`, (c) =>
      c
        .generatedAlwaysAs(
          sql`
        setweight(to_tsvector('simple'::regconfig,
          regexp_replace(coalesce(name, '') || ' ' || coalesce(ref_number, ''), '[^[:alnum:]]+', ' ', 'g')), 'A') ||
        setweight(to_tsvector('simple'::regconfig, coalesce(data->>'Memo', '')), 'B') ||
        setweight(to_tsvector('simple'::regconfig, coalesce(data->>'CompanyName', '') || ' ' ||
          coalesce(data->>'Email', '') || ' ' || coalesce(data->>'Phone', '')), 'C')
      `,
        )
        .stored(),
    )
    .addPrimaryKeyConstraint('qb_object_pk', ['type', 'qb_id'])
    .execute();

  await db.schema
    .createIndex('qb_object_type_time_modified_idx')
    .on('qb_object')
    .columns(['type', 'time_modified'])
    .execute();
  await db.schema
    .createIndex('qb_object_type_name_idx')
    .on('qb_object')
    .columns(['type', 'name'])
    .execute();
  await db.schema
    .createIndex('qb_object_type_txn_date_idx')
    .on('qb_object')
    .columns(['type', 'txn_date'])
    .execute();
  await db.schema
    .createIndex('qb_object_type_entity_ref_idx')
    .on('qb_object')
    .columns(['type', 'entity_ref_id'])
    .execute();
  await db.schema
    .createIndex('qb_object_type_ref_number_idx')
    .on('qb_object')
    .columns(['type', 'ref_number'])
    .execute();
  await db.schema
    .createIndex('qb_object_search_idx')
    .on('qb_object')
    .using('gin')
    .column('search')
    .execute();
  await sql`create index qb_object_data_idx on qb_object using gin (data jsonb_path_ops)`.execute(
    db,
  );

  await db.schema
    .createTable('sync_state')
    .addColumn('type', 'text', (c) => c.primaryKey())
    .addColumn('last_modified_cursor', 'timestamptz')
    .addColumn('last_full_sync_at', 'timestamptz')
    .addColumn('last_reconcile_at', 'timestamptz')
    .addColumn('last_run_at', 'timestamptz')
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('idle'))
    .addColumn('error', 'text')
    .addColumn('row_count', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  // ---- commands ---------------------------------------------------------
  await db.schema
    .createTable('command')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('kind', 'text', (c) =>
      c.notNull().check(sql`kind in ('add','mod','del','void','raw','query','report')`),
    )
    .addColumn('rq_name', 'text')
    .addColumn('object_type', 'text')
    .addColumn('object_id', 'text')
    .addColumn('payload', 'jsonb')
    .addColumn('request_xml', 'text')
    .addColumn('response_xml', 'text')
    .addColumn('status', 'text', (c) =>
      c
        .notNull()
        .defaultTo('queued')
        .check(sql`status in ('queued','sending','succeeded','failed','conflict','rejected')`),
    )
    .addColumn('priority', 'integer', (c) => c.notNull().defaultTo(5))
    .addColumn('status_code', 'integer')
    .addColumn('status_message', 'text')
    .addColumn('result', 'jsonb')
    .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('actor_type', 'text', (c) =>
      c.notNull().check(sql`actor_type in ('user','token','system')`),
    )
    .addColumn('actor_id', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('started_at', 'timestamptz')
    .addColumn('finished_at', 'timestamptz')
    .execute();
  await db.schema
    .createIndex('command_created_idx')
    .on('command')
    .columns(['created_at desc', 'id desc'])
    .execute();
  await db.schema
    .createIndex('command_status_idx')
    .on('command')
    .columns(['status', 'priority', 'created_at'])
    .execute();
  await db.schema
    .createIndex('command_object_idx')
    .on('command')
    .columns(['object_type', 'object_id'])
    .execute();
  await db.schema
    .createIndex('command_actor_idx')
    .on('command')
    .columns(['actor_type', 'actor_id', 'created_at'])
    .execute();

  // ---- users, roles, sessions, tokens ----------------------------------
  await db.schema
    .createTable('app_user')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('email', 'text', (c) => c.notNull())
    .addColumn('display_name', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('password_hash', 'text')
    .addColumn('is_active', 'boolean', (c) => c.notNull().defaultTo(true))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('last_login_at', 'timestamptz')
    .execute();
  await sql`create unique index app_user_email_key on app_user (lower(email))`.execute(db);

  await db.schema
    .createTable('role')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'text', (c) => c.notNull().unique())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('permissions', sql`text[]`, (c) => c.notNull().defaultTo(sql`'{}'::text[]`))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable('user_role')
    .addColumn('user_id', 'uuid', (c) => c.notNull().references('app_user.id').onDelete('cascade'))
    .addColumn('role_id', 'uuid', (c) => c.notNull().references('role.id').onDelete('cascade'))
    .addPrimaryKeyConstraint('user_role_pk', ['user_id', 'role_id'])
    .execute();
  await db.schema.createIndex('user_role_role_idx').on('user_role').column('role_id').execute();

  await db.schema
    .createTable('session')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('user_id', 'uuid', (c) => c.notNull().references('app_user.id').onDelete('cascade'))
    .addColumn('csrf_token', 'text')
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('ip', 'text')
    .addColumn('user_agent', 'text')
    .addColumn('data', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('session_user_idx').on('session').column('user_id').execute();
  await db.schema.createIndex('session_expires_idx').on('session').column('expires_at').execute();

  await db.schema
    .createTable('api_token')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('token_hash', 'text', (c) => c.notNull().unique())
    .addColumn('token_prefix', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('permissions', sql`text[]`, (c) => c.notNull().defaultTo(sql`'{}'::text[]`))
    .addColumn('created_by', 'uuid', (c) => c.references('app_user.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('last_used_at', 'timestamptz')
    .addColumn('expires_at', 'timestamptz')
    .addColumn('revoked_at', 'timestamptz')
    .execute();

  // ---- audit + report cache --------------------------------------------
  await db.schema
    .createTable('audit_log')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())
    .addColumn('at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('actor_type', 'text', (c) =>
      c.notNull().check(sql`actor_type in ('user','token','system')`),
    )
    .addColumn('actor_id', 'text')
    .addColumn('action', 'text', (c) => c.notNull())
    .addColumn('object_type', 'text')
    .addColumn('object_id', 'text')
    .addColumn('command_id', 'uuid', (c) => c.references('command.id').onDelete('set null'))
    .addColumn('ip', 'text')
    .addColumn('detail', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .execute();
  await db.schema.createIndex('audit_log_at_idx').on('audit_log').column('at desc').execute();
  await db.schema
    .createIndex('audit_log_object_idx')
    .on('audit_log')
    .columns(['object_type', 'object_id'])
    .execute();
  await db.schema
    .createIndex('audit_log_actor_idx')
    .on('audit_log')
    .columns(['actor_type', 'actor_id'])
    .execute();
  await db.schema
    .createIndex('audit_log_command_idx')
    .on('audit_log')
    .column('command_id')
    .execute();

  await db.schema
    .createTable('report_cache')
    .addColumn('key', 'text', (c) => c.primaryKey())
    .addColumn('report', 'text', (c) => c.notNull())
    .addColumn('params', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('result', 'jsonb', (c) => c.notNull())
    .addColumn('fetched_at', 'timestamptz', (c) => c.notNull())
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex('report_cache_expires_idx')
    .on('report_cache')
    .column('expires_at')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const t of [
    'report_cache',
    'audit_log',
    'api_token',
    'session',
    'user_role',
    'role',
    'app_user',
    'command',
    'sync_state',
    'qb_object',
  ]) {
    await db.schema.dropTable(t).ifExists().execute();
  }
}
