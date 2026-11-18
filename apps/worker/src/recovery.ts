import { listPendingCommands, type Db } from '@qbv/db';
import { COMMAND_JOB, DEFAULT_JOB_OPTIONS, type RelayQueue } from '@qbv/queue';
import { silentLogger, type Logger } from './types.js';

export interface RecoveryReport {
  /** Commands still queued or sending. */
  pending: number;
  /** Of those, commands left in 'sending' by an earlier run (they are checked before any resend). */
  interrupted: number;
  /** Jobs added back to the queue because they were missing or already finished. */
  requeued: number;
}

/**
 * Make sure every queued/sending command has a live job. Run on startup.
 *
 * A command left in `sending` was being sent when the previous worker stopped.
 * It is NOT resent blindly: when its job runs, the processor sees the
 * `sending` status and first queries QuickBooks to find out whether the write
 * was applied (see verify.ts). Only then is it resent, finished, or failed
 * with an explanation.
 */
export async function recoverPending(
  db: Db,
  queue: RelayQueue,
  log: Logger = silentLogger,
): Promise<RecoveryReport> {
  const pending = await listPendingCommands(db, 100_000);
  let requeued = 0;
  let interrupted = 0;
  for (const c of pending) {
    if (c.status === 'sending') interrupted++;
    const job = await queue.getJob(c.id);
    const state = job ? await job.getState() : 'missing';
    if (
      state === 'waiting' ||
      state === 'prioritized' ||
      state === 'delayed' ||
      state === 'active' ||
      state === 'waiting-children'
    ) {
      continue;
    }
    if (job) await job.remove().catch(() => undefined);
    await queue.add(
      COMMAND_JOB,
      { commandId: c.id },
      { ...DEFAULT_JOB_OPTIONS, jobId: c.id, priority: c.priority },
    );
    requeued++;
  }
  if (pending.length) {
    log.info({ pending: pending.length, interrupted, requeued }, 'recovered pending commands');
  }
  return { pending: pending.length, interrupted, requeued };
}
