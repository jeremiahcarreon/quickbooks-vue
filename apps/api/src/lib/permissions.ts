import { catalog } from '@qbv/qbxml';

const FIXED = new Set(['admin', 'command:read', 'qbxml:raw']);

/**
 * Check one permission string against the grammar used by @qbv/db
 * hasPermission. Returns an error message, or null when valid.
 */
export function permissionError(p: string): string | null {
  if (FIXED.has(p)) return null;
  const seg = p.split(':');
  if (seg[0] === 'object') {
    if (seg.length !== 3) return `"${p}": expected object:<Type|*>:read|write`;
    const [, type, access] = seg as [string, string, string];
    if (access !== 'read' && access !== 'write' && access !== '*')
      return `"${p}": access must be read or write`;
    if (type !== '*' && !catalog.entities[type]) return `"${p}": unknown entity ${type}`;
    return null;
  }
  if (seg[0] === 'report') {
    if (seg.length !== 2 || !/^[A-Za-z0-9_.*-]+$/.test(seg[1]!))
      return `"${p}": expected report:<name|*>`;
    return null;
  }
  return `"${p}": unknown permission (admin, command:read, qbxml:raw, object:<Type|*>:read|write, report:<name|*>)`;
}

export function permissionErrors(list: readonly string[]): string[] {
  return list.map(permissionError).filter((e): e is string => e !== null);
}
