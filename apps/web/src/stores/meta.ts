import { defineStore } from 'pinia';
import { computed, shallowRef } from 'vue';
import { metaApi } from '@/api/endpoints';
import type { EntityDef, EntityMeta, ObjectDef, RequestDef } from '@/api/types';
import { requiredObjects, type FormContext } from '@/forms/model';

/**
 * Catalog metadata from /api/meta: the entity list, and per entity the
 * ObjectDefs its screens need. All ObjectDefs are merged into one map that
 * serves as the form context.
 */
export const useMetaStore = defineStore('meta', () => {
  const entities = shallowRef<EntityDef[]>([]);
  const objects = shallowRef<Record<string, ObjectDef>>({});
  const requests = shallowRef<Record<string, RequestDef>>({});
  const loadedEntities = new Map<string, Promise<EntityMeta>>();
  let listPromise: Promise<EntityDef[]> | null = null;

  const entityNames = computed(() => entities.value.map((e) => e.name));
  const byName = computed(() => new Map(entities.value.map((e) => [e.name, e])));

  function loadEntities(force = false): Promise<EntityDef[]> {
    if (listPromise && !force) return listPromise;
    listPromise = metaApi.entities().then(
      (list) => {
        entities.value = list;
        return list;
      },
      (err) => {
        listPromise = null;
        throw err;
      },
    );
    return listPromise;
  }

  function mergeObjects(add: Record<string, ObjectDef>) {
    const fresh = Object.keys(add).filter((k) => !objects.value[k]);
    if (fresh.length) objects.value = { ...objects.value, ...add };
  }

  /** Load one entity's metadata, plus any nested ObjectDef it did not include. */
  function loadEntity(type: string): Promise<EntityMeta> {
    const hit = loadedEntities.get(type);
    if (hit) return hit;
    const p = (async () => {
      const meta = await metaApi.entity(type);
      mergeObjects(meta.objects);
      requests.value = { ...requests.value, ...meta.requests };
      if (!byName.value.has(meta.entity.name)) entities.value = [...entities.value, meta.entity];
      const roots = [
        addObjectName(meta.entity),
        modObjectName(meta.entity),
        meta.entity.retElement,
      ].filter((n): n is string => !!n);
      await ensureObjects(roots);
      return meta;
    })();
    loadedEntities.set(type, p);
    p.catch(() => loadedEntities.delete(type));
    return p;
  }

  /** Fetch ObjectDefs missing from the map (and their children), a level at a time. */
  async function ensureObjects(roots: string[]) {
    for (let round = 0; round < 8; round++) {
      const missing = new Set<string>();
      for (const r of roots) {
        for (const n of requiredObjects(r, objects.value)) if (!objects.value[n]) missing.add(n);
      }
      if (!missing.size) return;
      const got: Record<string, ObjectDef> = {};
      await Promise.all(
        [...missing].map(async (n) => {
          // The API answers with the object plus everything it uses.
          for (const [k, d] of Object.entries(await metaApi.objectClosure(n))) {
            got[k] = { ...d, name: d.name || k };
          }
        }),
      );
      if (!Object.keys(got).length) return;
      mergeObjects(got);
    }
  }

  function entity(type: string): EntityDef | undefined {
    return byName.value.get(type);
  }

  function bodyElement(rq: string | undefined, fallback: string): string | undefined {
    if (!rq) return undefined;
    return (
      requests.value[rq]?.bodyElement ??
      (objects.value[fallback] ? fallback : undefined) ??
      fallback
    );
  }

  /** ObjectDef name of the Add body (follows the Add request definition). */
  function addObjectName(e: EntityDef | string | undefined): string | undefined {
    const ent = typeof e === 'string' ? entity(e) : e;
    return ent ? bodyElement(ent.ops.add, `${ent.name}Add`) : undefined;
  }
  function modObjectName(e: EntityDef | string | undefined): string | undefined {
    const ent = typeof e === 'string' ? entity(e) : e;
    return ent ? bodyElement(ent.ops.mod, `${ent.name}Mod`) : undefined;
  }

  function ctx(owner?: string): FormContext {
    return { objects: objects.value, entityNames: entityNames.value, ...(owner ? { owner } : {}) };
  }

  /** For tests and purpose-built screens that already hold metadata. */
  function seed(data: {
    entities?: EntityDef[];
    objects?: Record<string, ObjectDef>;
    requests?: Record<string, RequestDef>;
  }) {
    if (data.entities) {
      entities.value = data.entities;
      listPromise = Promise.resolve(data.entities);
    }
    if (data.objects) objects.value = { ...objects.value, ...data.objects };
    if (data.requests) requests.value = { ...requests.value, ...data.requests };
    for (const e of data.entities ?? []) {
      if (!loadedEntities.has(e.name) && data.objects) {
        loadedEntities.set(
          e.name,
          Promise.resolve({ entity: e, objects: objects.value, requests: requests.value }),
        );
      }
    }
  }

  return {
    entities,
    objects,
    requests,
    entityNames,
    loadEntities,
    loadEntity,
    ensureObjects,
    entity,
    addObjectName,
    modObjectName,
    ctx,
    seed,
  };
});
