/**
 * Add/edit workflow for one entity, shared by the generic form and by
 * purpose-built screens:
 *   load metadata (+ the object for edits, or a reapply draft) -> edit `value`
 *   -> submit(): client-side validation, body (toBody / diffForMod), POST/PATCH
 *   through the commands store -> pending until QuickBooks answers.
 * Server-side validation errors land on fields (`errors`) or `general`.
 */
import { computed, ref, shallowRef, type Ref } from 'vue';
import { ApiError } from '@/api/client';
import { objectsApi } from '@/api/endpoints';
import type { QbObject } from '@/api/types';
import { humanize } from '@/lib/labels';
import { useCommandsStore, type TrackedCommand } from '@/stores/commands';
import { useDraftsStore } from '@/stores/drafts';
import { useMetaStore } from '@/stores/meta';
import {
  describeObject,
  diffForMod,
  fromRet,
  initialValue,
  mapServerErrors,
  toBody,
  validateValue,
  type ErrorMap,
  type FormValue,
} from './model';

export interface ObjectEditorOptions {
  entity: string;
  /** Present for edits. */
  id?: string;
  /** Prefill for new objects (merged over the empty value). */
  initial?: FormValue;
  /** Tray label. */
  label?: (value: FormValue) => string;
}

export type EditorPhase =
  'loading' | 'editing' | 'submitting' | 'pending' | 'done' | 'failed' | 'conflict';

export function useObjectEditor(opts: ObjectEditorOptions | Ref<ObjectEditorOptions>) {
  const meta = useMetaStore();
  const commands = useCommandsStore();
  const drafts = useDraftsStore();
  const o = () => ('value' in opts ? opts.value : opts);

  const phase = ref<EditorPhase>('loading');
  const objectName = ref<string | null>(null);
  const value = ref<FormValue>({});
  /** Form value of the object as loaded (edits): the Mod diff baseline. */
  const base = shallowRef<FormValue>({});
  /** Ret data as loaded (edits). */
  const original = shallowRef<QbObject | null>(null);
  const errors = ref<ErrorMap>({});
  const general = ref<string[]>([]);
  const note = ref<string | null>(null);
  const command = ref<TrackedCommand | null>(null);
  const loadError = ref<string | null>(null);

  const isEdit = computed(() => !!o().id);
  const form = computed(() =>
    objectName.value ? describeObject(objectName.value, meta.ctx(o().entity)) : null,
  );

  async function load() {
    phase.value = 'loading';
    loadError.value = null;
    errors.value = {};
    general.value = [];
    note.value = null;
    command.value = null;
    const { entity, id } = o();
    try {
      const em = await meta.loadEntity(entity);
      const name = id ? meta.modObjectName(em.entity) : meta.addObjectName(em.entity);
      if (!name)
        throw new Error(
          `${humanize(entity)} cannot be ${id ? 'edited' : 'added'} through the SDK.`,
        );
      objectName.value = name;
      const ctx = meta.ctx(entity);
      if (id) {
        // A reapply draft carries the current Ret (with its fresh EditSequence).
        const draft = drafts.take(entity, id);
        const current = draft
          ? await objectsApi.get(entity, id).catch(() => null)
          : await objectsApi.get(entity, id);
        const ret = draft?.base ?? current!.data;
        original.value = current ? { ...current, data: ret } : null;
        base.value = fromRet(name, ret, ctx);
        value.value = draft ? structuredClone(draft.value) : structuredClone(base.value);
        if (draft) note.value = draft.note;
      } else {
        base.value = {};
        value.value = { ...initialValue(name, ctx), ...(o().initial ?? {}) };
      }
      phase.value = 'editing';
    } catch (err) {
      loadError.value =
        err instanceof ApiError && err.status === 404
          ? 'Not found in the read model.'
          : (err as Error).message;
      phase.value = 'failed';
    }
  }

  /** Client-side check; returns true when valid. */
  function check(): boolean {
    if (!objectName.value) return false;
    errors.value = validateValue(objectName.value, value.value, meta.ctx(o().entity));
    return Object.keys(errors.value).length === 0;
  }

  function body(): Record<string, unknown> {
    const ctx = meta.ctx(o().entity);
    return isEdit.value
      ? diffForMod(objectName.value!, base.value, value.value, ctx)
      : (toBody(objectName.value!, value.value, ctx) ?? {});
  }

  /** Validate and submit. Resolves with the tracked command, or null when nothing was sent. */
  async function submit(): Promise<TrackedCommand | null> {
    general.value = [];
    if (!objectName.value || phase.value === 'submitting') return null;
    if (!check()) {
      general.value = ['Fix the highlighted fields.'];
      return null;
    }
    const b = body();
    const { entity, id } = o();
    if (!isEdit.value && Object.keys(b).length === 0) {
      general.value = ['Fill in at least one field.'];
      return null;
    }
    if (isEdit.value) {
      const required = new Set(form.value?.fields.filter((f) => f.required).map((f) => f.name));
      if (Object.keys(b).every((k) => required.has(k))) {
        general.value = ['Nothing changed.'];
        return null;
      }
    }
    phase.value = 'submitting';
    try {
      const label =
        o().label?.(value.value) ??
        `${isEdit.value ? 'Edit' : 'Add'} ${humanize(entity)} ${String(
          value.value.RefNumber ??
            value.value.Name ??
            original.value?.name ??
            original.value?.refNumber ??
            '',
        )}`.trim();
      const c = await commands.submit({
        op: isEdit.value ? 'mod' : 'add',
        entity,
        ...(id ? { id } : {}),
        body: b,
        base: original.value?.data ?? null,
        formObject: objectName.value,
        label,
      });
      command.value = c;
      phase.value = 'pending';
      void commands.waitFor(c.id).then(
        (done) => settle(done),
        () => undefined,
      );
      return c;
    } catch (err) {
      phase.value = 'editing';
      if (err instanceof ApiError) {
        const mapped = mapServerErrors(err.details, objectName.value, form.value ?? undefined);
        errors.value = { ...mapped.fields };
        general.value = [err.message, ...mapped.general].filter(
          (m, i, a) => m && a.indexOf(m) === i,
        );
        if (err.status === 409) general.value.push('Reload the page to get the latest version.');
      } else {
        general.value = [(err as Error).message];
      }
      return null;
    }
  }

  function settle(c: TrackedCommand) {
    command.value = c;
    if (c.status === 'succeeded') phase.value = 'done';
    else if (c.status === 'conflict') phase.value = 'conflict';
    else {
      phase.value = 'editing';
      general.value = [
        c.statusCode !== null
          ? `QuickBooks error ${c.statusCode}: ${c.statusMessage ?? ''}`
          : (c.statusMessage ?? `Command ${c.status}`),
      ];
      // a rejected/failed request may carry per-field detail in result
      const details = (c.result as Record<string, unknown> | null)?.errors;
      if (details && objectName.value) {
        errors.value = mapServerErrors(details, objectName.value, form.value ?? undefined).fields;
      }
    }
  }

  /** Id of the saved object (for adds, taken from the command result). */
  const savedId = computed(() => {
    const c = command.value;
    if (!c) return o().id ?? null;
    if (c.objectId) return c.objectId;
    const r = (c.result ?? {}) as Record<string, unknown>;
    const ret = (r.ret ?? r.object ?? r.data ?? r) as Record<string, unknown>;
    const v = r.qbId ?? r.objectId ?? ret.ListID ?? ret.TxnID ?? r.id;
    return typeof v === 'string' ? v : null;
  });

  return {
    phase,
    objectName,
    form,
    value,
    base,
    original,
    errors,
    general,
    note,
    command,
    loadError,
    isEdit,
    savedId,
    load,
    check,
    body,
    submit,
  };
}
