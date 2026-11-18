import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import type { Db } from './client.js';

/** argon2id with OWASP-recommended parameters (19 MiB, t=2, p=1). */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** sha256 hex; API tokens and session ids are stored hashed. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** New random API token, e.g. `qbv_3k...`. Show it once; store hashToken(token). */
export function generateToken(prefix = 'qbv'): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Permission strings are colon-separated, `*` matches one segment:
 *   admin                       everything
 *   object:<Type|*>:read|write  read model / commands for an entity type (write implies read)
 *   report:<name|*>             run a report
 *   command:read                see other users' commands
 *   qbxml:raw                   POST /qbxml
 */
export function hasPermission(granted: readonly string[], required: string): boolean {
  const req = required.split(':');
  for (const g of granted) {
    if (g === 'admin') return true;
    const seg = g.split(':');
    if (seg.length !== req.length) continue;
    let ok = true;
    for (let i = 0; i < seg.length; i++) {
      const s = seg[i]!;
      const r = req[i]!;
      if (s === '*' || s === r) continue;
      // object:X:write implies object:X:read
      if (i === seg.length - 1 && req[0] === 'object' && s === 'write' && r === 'read') continue;
      ok = false;
      break;
    }
    if (ok) return true;
  }
  return false;
}

const SALES_TYPES = [
  'Customer',
  'Estimate',
  'SalesOrder',
  'Invoice',
  'SalesReceipt',
  'CreditMemo',
  'ReceivePayment',
  'Charge',
];
const PURCHASING_TYPES = [
  'Vendor',
  'PurchaseOrder',
  'ItemReceipt',
  'Bill',
  'VendorCredit',
  'BillPaymentCheck',
  'BillPaymentCreditCard',
];

/** Roles created by the seed. Existing roles are never overwritten. */
export const DEFAULT_ROLES: { name: string; description: string; permissions: string[] }[] = [
  {
    name: 'Admin',
    description: 'Full access, including administration and raw qbXML',
    permissions: ['admin'],
  },
  {
    name: 'Accountant',
    description: 'Read and write every entity, run every report',
    permissions: ['object:*:read', 'object:*:write', 'report:*', 'command:read'],
  },
  {
    name: 'Sales',
    description: 'Customers and sales transactions',
    permissions: ['object:*:read', ...SALES_TYPES.map((t) => `object:${t}:write`), 'report:*'],
  },
  {
    name: 'Purchasing',
    description: 'Vendors and purchasing transactions',
    permissions: ['object:*:read', ...PURCHASING_TYPES.map((t) => `object:${t}:write`), 'report:*'],
  },
  {
    name: 'ReadOnly',
    description: 'Read everything, change nothing',
    permissions: ['object:*:read', 'report:*'],
  },
];

/** Union of permissions from every role of an active user. */
export async function getUserPermissions(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('user_role')
    .innerJoin('role', 'role.id', 'user_role.role_id')
    .innerJoin('app_user', 'app_user.id', 'user_role.user_id')
    .select('role.permissions')
    .where('user_role.user_id', '=', userId)
    .where('app_user.is_active', '=', true)
    .execute();
  return [...new Set(rows.flatMap((r) => r.permissions))].sort();
}

export async function findUserByEmail(db: Db, email: string) {
  return db
    .selectFrom('app_user')
    .selectAll()
    .where((eb) => eb(eb.fn('lower', ['email']), '=', email.trim().toLowerCase()))
    .executeTakeFirst();
}
