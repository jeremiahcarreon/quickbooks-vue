import { sql, type RawBuilder } from 'kysely';

/**
 * Bind any JSON value as jsonb. Use for top-level arrays (and anywhere you
 * want to be explicit): pg would otherwise send a JS array as a Postgres array.
 */
export function jsonb<T>(value: T): RawBuilder<T> {
  return sql<T>`cast(${JSON.stringify(value)} as jsonb)`;
}
