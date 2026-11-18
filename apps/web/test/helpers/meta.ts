/** /api/meta responses built from the real catalog. */
import { requiredObjects } from '@/forms/model';
import type { ObjectDef } from '@/api/types';
import { catalog, entities, objects } from './catalog';

export function entityList() {
  return Object.values(entities);
}

export function entityMeta(type: string) {
  const e = entities[type]!;
  const roots = [e.retElement];
  const reqs: Record<string, unknown> = {};
  for (const rq of Object.values(e.ops)) {
    const r = catalog.requests[rq!];
    if (!r) continue;
    reqs[rq!] = r;
    if (r.bodyElement) roots.push(r.bodyElement);
  }
  const names = new Set<string>();
  for (const r of roots) requiredObjects(r, objects, names);
  const objs: Record<string, ObjectDef> = {};
  for (const n of names) if (objects[n]) objs[n] = objects[n]!;
  return { entity: e, objects: objs, requests: reqs };
}
