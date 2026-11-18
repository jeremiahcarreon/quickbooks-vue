import {
  buildBatch,
  buildRequest,
  parseResponse,
  validate,
  type BatchPart,
  type BuildOptions,
  type ParsedRs,
} from '@qbv/qbxml';
import { expect } from 'vitest';
import { Engine } from '../src/engine.js';

export interface TestEngine {
  engine: Engine;
  internalErrors: string[];
  /** Send one request; asserts the request and the response are XSD-valid. */
  rq(name: string, body?: object, opts?: BuildOptions): ParsedRs;
  /** Send a batch; asserts validity both ways. */
  batch(
    parts: BatchPart[],
    onError?: 'stopOnError' | 'continueOnError' | 'rollbackOnError',
  ): ParsedRs[];
  /** Move the clock (ms since epoch, or Date). */
  setNow(d: Date | string): void;
  advance(ms: number): void;
}

export function expectValid(xml: string): void {
  const r = validate(xml);
  expect(r.errors, r.errors.map((e) => `line ${e.line}: ${e.message}`).join('\n')).toEqual([]);
  expect(r.valid).toBe(true);
}

export function testEngine(start = '2026-06-15T10:00:00Z'): TestEngine {
  let now = new Date(start).getTime();
  const internalErrors: string[] = [];
  const engine = new Engine({
    clock: { now: () => new Date(now) },
    onInternalError: (err, rq) =>
      internalErrors.push(`${rq}: ${err instanceof Error ? err.stack : String(err)}`),
  });
  engine.ensureSingletons();
  const send = (xml: string): ParsedRs[] => {
    expectValid(xml);
    const res = engine.processXml(xml);
    expectValid(res);
    return parseResponse(res);
  };
  return {
    engine,
    internalErrors,
    rq(name, body = {}, opts = {}) {
      const [rs] = send(buildRequest(name, body, opts));
      return rs!;
    },
    batch(parts, onError = 'stopOnError') {
      return send(buildBatch(parts, onError));
    },
    setNow(d) {
      now = new Date(d).getTime();
    },
    advance(ms) {
      now += ms;
    },
  };
}

export const ref = (FullName: string) => ({ FullName });

export function ok(rs: ParsedRs): ParsedRs {
  expect(`${rs.statusCode} ${rs.statusMessage}`).toBe('0 Status OK');
  return rs;
}

export function ret(rs: ParsedRs): Record<string, unknown> {
  ok(rs);
  return rs.rets[0]!;
}
