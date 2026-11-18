/**
 * Submit a write and follow its command until QuickBooks answers:
 * submitting -> pending (queued/sending) -> confirmed | conflict | failed.
 *
 * Follows the command through the app's commands store (live `command.updated`
 * events, with its own polling fallback), so the write also shows in the
 * global command tray; GET /commands/:id polling with a gentle backoff runs
 * alongside as a safety net.
 */
import { onBeforeUnmount, ref } from 'vue';
import { ApiError } from '@/api/client';
import { useCommandsStore } from '@/stores/commands';
import {
  conflictCurrent,
  getCommand,
  resultObjectId,
  submitObject,
  TERMINAL,
  type CommandView,
} from './api';

export type Phase = 'idle' | 'submitting' | 'pending' | 'confirmed' | 'conflict' | 'failed';

export function phaseOf(status: CommandView['status']): Phase {
  switch (status) {
    case 'succeeded':
      return 'confirmed';
    case 'conflict':
      return 'conflict';
    case 'failed':
    case 'rejected':
      return 'failed';
    default:
      return 'pending';
  }
}

const POLL_STEPS = [300, 600, 1000, 1500, 2000, 3000];
const POLL_LIMIT_MS = 5 * 60_000;

function tellTray(input: Parameters<ReturnType<typeof useCommandsStore>['track']>[0]): void {
  try {
    useCommandsStore().track(input);
  } catch {
    // No active Pinia (isolated component tests): the form shows its own status.
  }
}

export interface RunOptions {
  /** Shown in the command tray. */
  label?: string;
  /** Ret data the edit started from (for the tray's conflict diff). */
  base?: Record<string, unknown> | null;
  formObject?: string;
}

export function useCommand() {
  const phase = ref<Phase>('idle');
  const command = ref<CommandView | null>(null);
  const error = ref<string | null>(null);
  const errorDetails = ref<unknown>(null);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  onBeforeUnmount(() => {
    stopped = true;
    if (timer) clearTimeout(timer);
  });

  let held = false;

  /** Keep the current status through the next `resetOnNavigate()` (e.g. after redirecting to the saved record). */
  function hold() {
    held = true;
  }

  function resetOnNavigate() {
    if (held) {
      held = false;
      return;
    }
    reset();
  }

  function reset() {
    phase.value = 'idle';
    command.value = null;
    error.value = null;
    errorDetails.value = null;
  }

  function settle(c: CommandView) {
    command.value = c;
    phase.value = phaseOf(c.status);
    if (phase.value === 'failed') {
      error.value =
        c.statusMessage ??
        (c.status === 'rejected'
          ? 'The request did not pass qbXML schema validation and was not sent.'
          : 'QuickBooks rejected the request.');
    }
  }

  async function follow(id: string): Promise<CommandView> {
    const started = Date.now();
    let step = 0;
    for (;;) {
      if (stopped) return command.value ?? { id, status: 'queued' };
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, POLL_STEPS[Math.min(step, POLL_STEPS.length - 1)]);
      });
      step += 1;
      try {
        const c = await getCommand(id);
        settle(c);
        if (TERMINAL.includes(c.status)) return c;
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) throw err;
        // transient: keep polling
      }
      if (Date.now() - started > POLL_LIMIT_MS) {
        return command.value ?? { id, status: 'queued' };
      }
    }
  }

  /**
   * POST (no id) or PATCH (with id) the body. Resolves with the final command
   * (or the last known one if QuickBooks has not answered within five minutes).
   * Returns null when the API refused the request outright (see `error`).
   */
  async function run(
    type: string,
    body: Record<string, unknown>,
    id?: string,
    opts: RunOptions = {},
  ): Promise<CommandView | null> {
    reset();
    phase.value = 'submitting';
    try {
      const res = await submitObject(type, body, id);
      tellTray({
        id: res.commandId,
        status: (res.command?.status ?? 'queued') as CommandView['status'],
        op: id ? 'mod' : 'add',
        entity: type,
        objectId: id ?? null,
        label: opts.label,
        submitted: body,
        base: opts.base ?? null,
        formObject: opts.formObject ?? null,
      });
      command.value = res.command ?? { id: res.commandId, status: 'queued' };
      phase.value = 'pending';
      if (res.command && TERMINAL.includes(res.command.status)) {
        settle(res.command);
        return res.command;
      }
      return await follow(res.commandId);
    } catch (err) {
      phase.value = 'failed';
      error.value = err instanceof Error ? err.message : String(err);
      errorDetails.value = err instanceof ApiError ? err.details : null;
      return null;
    }
  }

  return {
    phase,
    command,
    error,
    errorDetails,
    run,
    reset,
    hold,
    resetOnNavigate,
    /** TxnID/ListID QuickBooks assigned (from the command result). */
    createdId: () => command.value?.objectId ?? resultObjectId(command.value?.result),
    /** The refreshed object attached to a conflict. */
    current: () => conflictCurrent(command.value?.result),
  };
}
