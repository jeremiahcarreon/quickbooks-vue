import type { Migration } from 'kysely';
import * as m0001 from './0001_initial.js';

/**
 * Ordered migrations. Add new files as NNNN_name.ts and register them here;
 * a static map keeps migrations working from dist/ and inside bundles.
 */
export const migrations: Record<string, Migration> = {
  '0001_initial': m0001,
};
