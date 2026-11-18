import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { validate } from '@qbv/qbxml';
import { finishCommand, getCommand, markCommandSending, type Db } from '@qbv/db';
import { RELAY_QUEUE, type EventBus, type RelayJobData } from '@qbv/queue';
import type { FakeQuickBooks } from './fake-qb.js';

/**
 * Stand-in for apps/worker in tests: consumes the relay queue (concurrency 1),
 * re-validates request_xml against the XSD, asks the fake QuickBooks and
 * finishes the command with the response, as DESIGN 6.4 describes.
 */
export function startFakeWorker(opts: {
  db: Db;
  redis: Redis;
  prefix: string;
  qb: FakeQuickBooks;
  events?: EventBus;
  /** Priorities seen, in processing order. */
  seen?: Array<{ rq: string | null; priority: number; payload: unknown }>;
}): Worker<RelayJobData> {
  return new Worker<RelayJobData>(
    RELAY_QUEUE,
    async (job) => {
      const cmd = await getCommand(opts.db, job.data.commandId);
      if (!cmd) return;
      await markCommandSending(opts.db, cmd.id);
      opts.seen?.push({ rq: cmd.rq_name, priority: cmd.priority, payload: cmd.payload });
      const xml = cmd.request_xml ?? '';
      if (!validate(xml).valid) {
        await finishCommand(opts.db, cmd.id, {
          status: 'rejected',
          statusMessage: 'invalid qbXML',
        });
      } else {
        const responseXml = opts.qb.handle(xml);
        const code = Number(/statusCode="(-?\d+)"/.exec(responseXml)?.[1] ?? 0);
        await finishCommand(opts.db, cmd.id, {
          status: code >= 1000 || code < 0 ? 'failed' : 'succeeded',
          statusCode: code,
          responseXml,
        });
      }
      const after = await getCommand(opts.db, cmd.id);
      await opts.events?.publish({ type: 'command.updated', id: cmd.id, status: after!.status });
    },
    { connection: opts.redis.duplicate(), prefix: opts.prefix, concurrency: 1 },
  );
}
