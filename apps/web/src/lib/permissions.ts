/**
 * Permission grammar shared with the API (@qbv/db auth):
 *   admin                       everything
 *   object:<Type|*>:read|write  read model / commands for an entity type (write implies read)
 *   report:<name|*>             run a report
 *   command:read                command history
 *   qbxml:raw                   raw qbXML console / endpoint
 * `*` matches exactly one segment.
 */
export function hasPermission(granted: readonly string[], required: string): boolean {
  const req = required.split(':');
  for (const g of granted) {
    if (g === 'admin') return true;
    const parts = g.split(':');
    if (matches(parts, req)) return true;
    // write implies read
    if (
      req[0] === 'object' &&
      req[2] === 'read' &&
      parts[0] === 'object' &&
      parts[2] === 'write' &&
      matches(parts.slice(0, 2), req.slice(0, 2))
    ) {
      return true;
    }
  }
  return false;
}

function matches(granted: string[], required: string[]): boolean {
  if (granted.length !== required.length) return false;
  return granted.every((g, i) => g === '*' || g === required[i]);
}

export const readPerm = (type: string) => `object:${type}:read`;
export const writePerm = (type: string) => `object:${type}:write`;

/** Permissions not tied to one entity type, offered by the permission editor. */
export const GLOBAL_PERMISSIONS: { value: string; label: string; description: string }[] = [
  {
    value: 'admin',
    label: 'Administrator',
    description: 'Everything, including users and raw qbXML',
  },
  { value: 'object:*:read', label: 'Read all objects', description: 'Every list and transaction' },
  {
    value: 'object:*:write',
    label: 'Write all objects',
    description: 'Add, edit, delete, void any type',
  },
  { value: 'report:*', label: 'All reports', description: 'Run every report' },
  { value: 'command:read', label: 'Command history', description: 'See every queued write' },
  { value: 'qbxml:raw', label: 'Raw qbXML', description: 'Send raw qbXML requests' },
];

export type ObjectAccess = 'none' | 'read' | 'write';

/** Effective access to one entity type from a permission list. */
export function objectAccess(perms: readonly string[], type: string): ObjectAccess {
  if (hasPermission(perms, writePerm(type))) return 'write';
  if (hasPermission(perms, readPerm(type))) return 'read';
  return 'none';
}

/** Set the explicit per-type permission, removing any other explicit one for that type. */
export function setObjectAccess(
  perms: readonly string[],
  type: string,
  access: ObjectAccess,
): string[] {
  const out = perms.filter((p) => p !== readPerm(type) && p !== writePerm(type));
  if (access === 'read') out.push(readPerm(type));
  if (access === 'write') out.push(writePerm(type));
  return normalizePermissions(out);
}

export function togglePermission(perms: readonly string[], perm: string, on: boolean): string[] {
  const out = perms.filter((p) => p !== perm);
  if (on) out.push(perm);
  return normalizePermissions(out);
}

/** Trim, dedupe and sort; drop malformed entries. */
export function normalizePermissions(perms: readonly string[]): string[] {
  return [...new Set(perms.map((p) => p.trim()).filter((p) => isValidPermission(p)))].sort();
}

export function isValidPermission(p: string): boolean {
  return (
    p === 'admin' ||
    p === 'command:read' ||
    p === 'qbxml:raw' ||
    /^object:(\*|[A-Za-z][A-Za-z0-9]*):(read|write)$/.test(p) ||
    /^report:(\*|[A-Za-z0-9_.-]+)$/.test(p)
  );
}
