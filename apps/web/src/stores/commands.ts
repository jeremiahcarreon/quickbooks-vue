import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { commandsApi, objectsApi } from '@/api/endpoints';
import {
  ACTIVE_STATUSES,
  PROBLEM_STATUSES,
  TERMINAL_STATUSES,
  type Command,
  type CommandStatus,
  type QbvEvent,
} from '@/api/types';
import { humanize } from '@/lib/labels';
import { useAuthStore } from './auth';
import { useEventsStore } from './events';

export type WriteOp = 'add' | 'mod' | 'del' | 'void' | 'raw';

export interface TrackedCommand {
  id: string;
  status: CommandStatus;
  op: WriteOp;
  entity: string | null;
  objectId: string | null;
  label: string;
  /** The JSON body that was submitted (Add/Mod shape). */
  submitted: Record<string, unknown> | null;
  /** The object's Ret data when the edit began, for the conflict diff. */
  base: Record<string, unknown> | null;
  /** Mod ObjectDef name, so a conflict can be reapplied. */
  formObject: string | null;
  statusCode: number | null;
  statusMessage: string | null;
  result: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  dismissed: boolean;
}

export interface SubmitInput {
  op: Exclude<WriteOp, 'raw'>;
  entity: string;
  /** Object id for mod/del/void. */
  id?: string;
  body?: Record<string, unknown>;
  base?: Record<string, unknown> | null;
  formObject?: string;
  /** Shown in the tray, e.g. "Invoice INV-1001". */
  label?: string;
}

const STORAGE_KEY = 'qbv.commands.v1';
const KEEP = 50;
export const POLL_MS = 3000;

const isActive = (s: CommandStatus) => ACTIVE_STATUSES.includes(s);
const isProblem = (s: CommandStatus) => PROBLEM_STATUSES.includes(s);
const isTerminal = (s: CommandStatus) => TERMINAL_STATUSES.includes(s);

function load(): TrackedCommand[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const list = raw ? (JSON.parse(raw) as TrackedCommand[]) : [];
    return Array.isArray(list) ? list.filter((c) => c && typeof c.id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The live command tray. Every write submitted from this browser is tracked
 * here until QuickBooks confirms it (or it fails / conflicts). Status comes
 * from command.updated events, with polling while the event stream is down.
 */
export const useCommandsStore = defineStore('commands', () => {
  const items = ref<TrackedCommand[]>(load());
  const settledHandlers = new Set<(c: TrackedCommand, prev: CommandStatus) => void>();
  const waiters = new Map<string, ((c: TrackedCommand) => void)[]>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let unsub: (() => void)[] = [];
  /** command.updated statuses for ids not tracked (yet). */
  const early = new Map<string, CommandStatus>();

  const visible = computed(() =>
    [...items.value].filter((c) => !c.dismissed).sort((a, b) => b.createdAt - a.createdAt),
  );
  const active = computed(() => visible.value.filter((c) => isActive(c.status)));
  const problems = computed(() => visible.value.filter((c) => isProblem(c.status)));
  const conflicts = computed(() => visible.value.filter((c) => c.status === 'conflict'));
  const badgeCount = computed(() => active.value.length + problems.value.length);

  function persist() {
    try {
      const keep = [...items.value].sort((a, b) => b.createdAt - a.createdAt).slice(0, KEEP);
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(keep));
    } catch {
      // storage full or disabled: the tray still works for this page load
    }
  }

  function find(id: string) {
    return items.value.find((c) => c.id === id);
  }

  function upsert(c: TrackedCommand) {
    const i = items.value.findIndex((x) => x.id === c.id);
    if (i >= 0) items.value[i] = c;
    else items.value.push(c);
    persist();
  }

  function apply(id: string, patch: Partial<TrackedCommand>) {
    const cur = find(id);
    if (!cur) return;
    const prev = cur.status;
    const next: TrackedCommand = { ...cur, ...patch, updatedAt: Date.now() };
    upsert(next);
    if (prev !== next.status && isTerminal(next.status)) {
      settledHandlers.forEach((h) => h(next, prev));
      const ws = waiters.get(id);
      if (ws) {
        waiters.delete(id);
        ws.forEach((w) => w(next));
      }
    }
  }

  function fromCommand(cmd: Command): Partial<TrackedCommand> {
    return {
      status: cmd.status,
      statusCode: cmd.statusCode,
      statusMessage: cmd.statusMessage,
      result: cmd.result,
      ...(cmd.objectId ? { objectId: cmd.objectId } : {}),
    };
  }

  /** Track a command that was created elsewhere (e.g. a purpose-built screen or the raw console). */
  function track(input: {
    id: string;
    status?: CommandStatus;
    op: WriteOp;
    entity?: string | null;
    objectId?: string | null;
    label?: string;
    submitted?: Record<string, unknown> | null;
    base?: Record<string, unknown> | null;
    formObject?: string | null;
  }): TrackedCommand {
    const existing = find(input.id);
    if (existing) {
      // The command may already be known from a live event (adopted before the
      // 202 arrived): keep its status, but attach what only the submitter knows,
      // which the conflict diff and "reload and reapply" need.
      const merged: TrackedCommand = {
        ...existing,
        op: input.op,
        entity: existing.entity ?? input.entity ?? null,
        objectId: existing.objectId ?? input.objectId ?? null,
        label: input.label ?? existing.label,
        submitted: input.submitted ?? existing.submitted,
        base: input.base ?? existing.base,
        formObject: input.formObject ?? existing.formObject,
      };
      upsert(merged);
      return find(input.id) ?? merged;
    }
    const c: TrackedCommand = {
      id: input.id,
      status: input.status ?? 'queued',
      op: input.op,
      entity: input.entity ?? null,
      objectId: input.objectId ?? null,
      label: input.label ?? (input.entity ? `${humanize(input.entity)}` : 'qbXML request'),
      submitted: input.submitted ?? null,
      base: input.base ?? null,
      formObject: input.formObject ?? null,
      statusCode: null,
      statusMessage: null,
      result: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dismissed: false,
    };
    upsert(c);
    ensurePolling();
    const seen = early.get(c.id);
    early.delete(c.id);
    if (isTerminal(c.status) || (seen && isTerminal(seen))) void refresh(c.id);
    else if (seen && seen !== c.status) apply(c.id, { status: seen });
    return c;
  }

  /**
   * Submit a write through the REST API and track it. Throws ApiError when
   * the API rejects it outright (validation, permissions); the returned
   * command then moves through queued -> sending -> succeeded/failed/conflict.
   */
  async function submit(input: SubmitInput): Promise<TrackedCommand> {
    const { op, entity, id, body = {} } = input;
    let ref: { id: string; status: CommandStatus };
    switch (op) {
      case 'add':
        ref = await objectsApi.add(entity, body);
        break;
      case 'mod':
        ref = await objectsApi.mod(entity, id!, body);
        break;
      case 'del':
        ref = await objectsApi.del(entity, id!);
        break;
      case 'void':
        ref = await objectsApi.void(entity, id!);
        break;
    }
    const verb = { add: 'Add', mod: 'Edit', del: 'Delete', void: 'Void' }[op];
    return track({
      id: ref.id,
      status: ref.status,
      op,
      entity,
      objectId: id ?? null,
      label: input.label ?? `${verb} ${humanize(entity)}`,
      submitted: body,
      base: input.base ?? null,
      formObject: input.formObject ?? null,
    });
  }

  async function refresh(id: string): Promise<void> {
    try {
      const cmd = await commandsApi.get(id);
      apply(id, fromCommand(cmd));
    } catch {
      // keep the last known state; the next event or poll retries
    }
  }

  /** Resolve when the command reaches a final status. */
  function waitFor(id: string, timeoutMs = 120_000): Promise<TrackedCommand> {
    const cur = find(id);
    if (
      cur &&
      isTerminal(cur.status) &&
      (cur.result || cur.statusMessage || cur.status === 'succeeded')
    ) {
      return Promise.resolve(cur);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const ws = waiters.get(id)?.filter((w) => w !== done);
        if (ws) waiters.set(id, ws);
        reject(new Error('Timed out waiting for QuickBooks'));
      }, timeoutMs);
      const done = (c: TrackedCommand) => {
        clearTimeout(t);
        resolve(c);
      };
      waiters.set(id, [...(waiters.get(id) ?? []), done]);
    });
  }

  function handleEvent(e: QbvEvent) {
    if (e.type !== 'command.updated') return;
    const cur = find(e.id);
    if (!cur) {
      // The update may beat the 202 that tells us the id: remember it briefly.
      early.set(e.id, e.status);
      if (early.size > 200) early.delete(early.keys().next().value!);
      const auth = useAuthStore();
      if (e.actorId && auth.user && e.actorId === auth.user.id && e.objectType) {
        track({
          id: e.id,
          status: e.status,
          op: 'mod',
          entity: e.objectType,
          objectId: e.objectId ?? null,
        });
        void refresh(e.id);
      }
      return;
    }
    if (isTerminal(e.status)) {
      // Final status: fetch the row first so the settle carries the message
      // and result.current; fall back to the event's status.
      void commandsApi.get(e.id).then(
        (cmd) => apply(e.id, fromCommand(cmd)),
        () => apply(e.id, { status: e.status }),
      );
    } else {
      apply(e.id, { status: e.status });
    }
  }

  function pollOnce(): Promise<void[]> {
    return Promise.all(active.value.map((c) => refresh(c.id)));
  }

  function ensurePolling() {
    if (pollTimer || typeof setInterval === 'undefined') return;
    pollTimer = setInterval(() => {
      if (!active.value.length) {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        return;
      }
      const events = useEventsStore();
      // With a live stream, only re-check commands that have gone quiet.
      const stale = Date.now() - 15_000;
      if (events.status !== 'open' || active.value.some((c) => c.updatedAt < stale))
        void pollOnce();
    }, POLL_MS);
  }

  /** Subscribe to the event stream; call once after login. */
  function start() {
    stop();
    const events = useEventsStore();
    unsub = [events.on('command.updated', handleEvent), events.onReconnect(() => void pollOnce())];
    if (active.value.length) {
      ensurePolling();
      void pollOnce();
    }
  }

  function stop() {
    unsub.forEach((u) => u());
    unsub = [];
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function onSettled(cb: (c: TrackedCommand, prev: CommandStatus) => void): () => void {
    settledHandlers.add(cb);
    return () => settledHandlers.delete(cb);
  }

  function dismiss(id: string) {
    apply(id, { dismissed: true });
  }

  function clearFinished() {
    items.value = items.value.map((c) =>
      c.status === 'succeeded' || c.status === 'rejected' ? { ...c, dismissed: true } : c,
    );
    persist();
  }

  function reset() {
    stop();
    items.value = [];
    persist();
  }

  /** Latest unresolved command (pending or problem) for one object. */
  function pendingFor(entity: string, id: string): TrackedCommand | undefined {
    return visible.value.find(
      (c) =>
        c.entity === entity && c.objectId === id && (isActive(c.status) || isProblem(c.status)),
    );
  }

  /** Adds still in flight for an entity type (shown as optimistic rows). */
  function pendingAdds(entity: string): TrackedCommand[] {
    return visible.value.filter((c) => c.entity === entity && c.op === 'add' && isActive(c.status));
  }

  return {
    items,
    visible,
    active,
    problems,
    conflicts,
    badgeCount,
    track,
    submit,
    refresh,
    waitFor,
    handleEvent,
    pollOnce,
    start,
    stop,
    onSettled,
    dismiss,
    clearFinished,
    reset,
    pendingFor,
    pendingAdds,
    find,
  };
});
