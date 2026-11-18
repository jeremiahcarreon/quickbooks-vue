import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { FormValue } from '@/forms/model';

export interface Draft {
  /** Form value to open the edit form with. */
  value: FormValue;
  /** Ret data the draft was built on (its EditSequence is current). */
  base: Record<string, unknown>;
  /** Why the draft exists, shown above the form. */
  note: string;
  /** Command the draft replaces. */
  fromCommand?: string;
}

/** Edit drafts handed from the conflict view ("reload and reapply") to the edit form. */
export const useDraftsStore = defineStore('drafts', () => {
  const drafts = ref<Record<string, Draft>>({});
  const key = (entity: string, id: string) => `${entity}:${id}`;
  function put(entity: string, id: string, d: Draft) {
    drafts.value = { ...drafts.value, [key(entity, id)]: d };
  }
  /** Take (and remove) a draft. */
  function take(entity: string, id: string): Draft | undefined {
    const d = drafts.value[key(entity, id)];
    if (d) {
      const rest = { ...drafts.value };
      delete rest[key(entity, id)];
      drafts.value = rest;
    }
    return d;
  }
  function peek(entity: string, id: string): Draft | undefined {
    return drafts.value[key(entity, id)];
  }
  return { drafts, put, take, peek };
});
