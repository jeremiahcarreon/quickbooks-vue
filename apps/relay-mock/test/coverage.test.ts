// Every request type in the catalog: a minimal schema-valid request must get
// a schema-valid response (success or a QuickBooks status), never an internal error.
import { buildRequest, catalog, getObject, minimalRequestBody, parseResponse } from '@qbv/qbxml';
import { describe, expect, it } from 'vitest';
import { seedSampleCompany } from '../src/seed.js';
import { expectValid, testEngine } from './helpers.js';

const requests = Object.values(catalog.requests).sort((a, b) => a.name.localeCompare(b.name));

describe('every catalog request', () => {
  const t = testEngine();
  seedSampleCompany(t.engine);

  it('covers all requests', () => {
    expect(requests.length).toBeGreaterThan(250);
  });

  it.each(requests.map((r) => [r.name]))('%s gets an XSD-valid response', (name) => {
    const def = catalog.requests[name]!;
    const xml = buildRequest(name, minimalRequestBody(name), { requestID: '7' });
    expectValid(xml);
    const res = t.engine.processXml(xml);
    expectValid(res);
    const [rs] = parseResponse(res);
    expect(rs!.name).toBe(def.response);
    expect(rs!.requestID).toBe('7');
    expect(rs!.statusCode, rs!.statusMessage).not.toBe(1000);
    if (def.supportsIterator) {
      const body = minimalRequestBody(name);
      if (getObject(name).fields.some((f) => f.name === 'MaxReturned')) body.MaxReturned = 2;
      const it = buildRequest(name, body, { iterator: 'Start' });
      const r2 = t.engine.processXml(it);
      expectValid(r2);
      expect(parseResponse(r2)[0]!.statusCode).not.toBe(1000);
    }
    expect(t.internalErrors).toEqual([]);
  });
});
