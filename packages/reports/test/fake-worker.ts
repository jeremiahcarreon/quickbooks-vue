import { randomBytes } from 'node:crypto';
import { Worker } from 'bullmq';
import { buildResponse, parseResponse, validate } from '@qbv/qbxml';
import { testRedisUrl } from '@qbv/config/testing';
import { finishCommand, markCommandSending, type Db } from '@qbv/db';
import {
  COMMAND_JOB,
  createEventBus,
  createRedis,
  createRelayQueue,
  RELAY_QUEUE,
  type EventBus,
  type RelayJobData,
  type RelayQueue,
} from '@qbv/queue';

export interface FakeQb {
  queue: RelayQueue;
  events: EventBus;
  /** Every request the fake QuickBooks received. */
  received: string[];
  /** Per-call behaviour; default answers with a small report. */
  behaviour: { delayMs: number; error?: { code: number; message: string }; paused: boolean };
  start(): void;
  close(): Promise<void>;
}

/** A small, XSD-valid ReportRet titled after the requested report type. */
export function reportRetFor(reportType: string, amount = '1234.50'): Record<string, unknown> {
  return {
    ReportTitle: `Report ${reportType}`,
    ReportSubtitle: 'January 2024',
    ReportBasis: 'Accrual',
    NumRows: 3,
    NumColumns: 2,
    NumColTitleRows: 1,
    ColDesc: [
      { '@colID': '1', '@dataType': 'STRTYPE', ColTitle: [{ '@titleRow': '1' }], ColType: 'Label' },
      {
        '@colID': '2',
        '@dataType': 'AMTTYPE',
        ColTitle: [{ '@titleRow': '1', '@value': 'TOTAL' }],
        ColType: 'Total',
      },
    ],
    ReportData: {
      TextRow: [{ '@rowNumber': '1', '@value': 'Income' }],
      DataRow: [
        {
          '@rowNumber': '2',
          RowData: { '@rowType': 'account', '@value': 'Sales' },
          ColData: [
            { '@colID': '1', '@value': 'Sales' },
            { '@colID': '2', '@value': amount },
          ],
        },
      ],
      SubtotalRow: [
        {
          '@rowNumber': '3',
          ColData: [
            { '@colID': '1', '@value': 'Total Income' },
            { '@colID': '2', '@value': amount },
          ],
        },
      ],
      TotalRow: [
        {
          '@rowNumber': '4',
          ColData: [
            { '@colID': '1', '@value': 'Net Income' },
            { '@colID': '2', '@value': amount },
          ],
        },
      ],
    },
  };
}

/**
 * Stands in for worker + relay + QuickBooks: consumes the relay queue,
 * rejects any request that is not XSD-valid (like the real worker and the
 * relay mock), and answers report requests with a validated response.
 */
export function createFakeQb(db: Db): FakeQb {
  const prefix = `qbvrpt${randomBytes(4).toString('hex')}`;
  const redis = createRedis(testRedisUrl());
  const queue = createRelayQueue(redis, { prefix });
  const events = createEventBus(testRedisUrl(), { channel: `${prefix}:events` });
  const received: string[] = [];
  const behaviour: FakeQb['behaviour'] = { delayMs: 0, paused: false };
  let worker: Worker<RelayJobData> | undefined;
  let workerConn: ReturnType<typeof createRedis> | undefined;

  const handle = async (commandId: string) => {
    while (behaviour.paused) await new Promise((r) => setTimeout(r, 25));
    const cmd = await markCommandSending(db, commandId);
    if (!cmd?.request_xml) return;
    const v = validate(cmd.request_xml);
    if (!v.valid) {
      await finishCommand(db, cmd.id, {
        status: 'rejected',
        statusMessage: v.errors.map((e) => e.message).join('; '),
      });
      return;
    }
    received.push(cmd.request_xml);
    if (behaviour.delayMs) await new Promise((r) => setTimeout(r, behaviour.delayMs));
    const rq = /<(\w+ReportQueryRq)\b/.exec(cmd.request_xml)?.[1] ?? 'GeneralSummaryReportQueryRq';
    const reportType = /<\w+ReportType>([^<]*)</.exec(cmd.request_xml)?.[1] ?? '';
    const rs = rq.replace(/Rq$/, 'Rs');
    const err = behaviour.error;
    const xml = buildResponse([
      err
        ? { rs, requestID: '1', statusCode: err.code, statusMessage: err.message }
        : { rs, requestID: '1', body: { ReportRet: reportRetFor(reportType) } },
    ]);
    if (!validate(xml).valid) throw new Error('fake response is not XSD-valid');
    const parsed = parseResponse(xml)[0]!;
    await finishCommand(db, cmd.id, {
      status: parsed.statusSeverity === 'Error' ? 'failed' : 'succeeded',
      statusCode: parsed.statusCode,
      statusMessage: parsed.statusMessage,
      responseXml: xml,
    });
    await events.publish({ type: 'command.updated', id: cmd.id, status: 'done' });
  };

  return {
    queue,
    events,
    received,
    behaviour,
    start() {
      workerConn = createRedis(testRedisUrl());
      worker = new Worker<RelayJobData>(
        RELAY_QUEUE,
        async (job) => {
          if (job.name === COMMAND_JOB) await handle(job.data.commandId);
        },
        { connection: workerConn, prefix, concurrency: 1 },
      );
    },
    async close() {
      await worker?.close();
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
      await events.close();
      await redis.quit().catch(() => undefined);
      await workerConn?.quit().catch(() => undefined);
    },
  };
}
