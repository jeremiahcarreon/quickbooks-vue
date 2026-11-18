import type { RouteLocationRaw } from 'vue-router';

/** Route to the generic screens of an entity. */
export function entityListRoute(type: string): RouteLocationRaw {
  return { name: 'entity-list', params: { type } };
}
export function entityDetailRoute(type: string, id: string): RouteLocationRaw {
  return { name: 'entity-detail', params: { type, id } };
}
export function entityNewRoute(type: string): RouteLocationRaw {
  return { name: 'entity-new', params: { type } };
}
export function entityEditRoute(type: string, id: string): RouteLocationRaw {
  return { name: 'entity-edit', params: { type, id } };
}
/** A ref whose type is one of several (ItemRef, EntityRef): resolved by the ref view. */
export function refRoute(targets: string[], id: string): RouteLocationRaw {
  if (targets.length === 1) return entityDetailRoute(targets[0]!, id);
  return { name: 'ref-resolve', params: { id }, query: { types: targets.join(',') } };
}
