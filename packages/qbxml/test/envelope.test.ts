import { describe, expect, it } from 'vitest';
import {
  buildRequest,
  checkEnvelope,
  compareQbxmlVersions,
  qbxmlVersionOf,
  validate,
} from '../src/index.js';

const body = `<QBXML>
  <QBXMLMsgsRq onError="stopOnError">
    <CustomerQueryRq><MaxReturned>1</MaxReturned></CustomerQueryRq>
  </QBXMLMsgsRq>
</QBXML>`;
const doc = (prolog: string) => `${prolog}\n${body}`;

describe('qbXML envelope', () => {
  it('accepts a request with one supported version instruction', () => {
    const xml = doc('<?xml version="1.0"?>\n<?qbxml version="16.0"?>');
    expect(validate(xml)).toEqual({ valid: true, errors: [] });
    expect(qbxmlVersionOf(xml)).toBe('16.0');
    expect(validate(doc("<?qbxml version='13.0'?>")).valid).toBe(true);
    expect(validate(doc('﻿<!-- c --><?qbxml version="17.0" ?>')).valid).toBe(true);
  });

  it('rejects a request without the instruction', () => {
    const r = validate(doc('<?xml version="1.0"?>'));
    expect(r.valid).toBe(false);
    expect(r.errors[0]!.message).toMatch(/Missing <\?qbxml version/);
    expect(r.errors[0]!.line).toBe(2);
  });

  it('rejects unknown, malformed and repeated versions', () => {
    expect(validate(doc('<?qbxml version="99.0"?>')).errors[0]!.message).toMatch(
      /Unsupported qbXML version "99.0"/,
    );
    expect(validate(doc('<?qbxml version="9.0"?>')).valid).toBe(false);
    expect(validate(doc('<?qbxml?>')).valid).toBe(false);
    expect(validate(doc('<?qbxml vers="16.0"?>')).valid).toBe(false);
    const twice = validate(doc('<?qbxml version="16.0"?>\n<?qbxml version="16.0"?>'));
    expect(twice.valid).toBe(false);
    expect(twice.errors[0]!.message).toMatch(/Exactly one/);
  });

  it('ignores an instruction placed after the root element', () => {
    const xml = body.replace('<QBXML>', '<QBXML><?qbxml version="16.0"?>');
    expect(validate(xml).valid).toBe(false);
  });

  it('reports XSD errors and envelope errors together', () => {
    const r = validate(doc('').replace('<MaxReturned>1</MaxReturned>', '<Bogus/>'));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /Bogus/.test(e.message))).toBe(true);
    expect(r.errors.some((e) => /Missing <\?qbxml/.test(e.message))).toBe(true);
  });

  it('does not require the instruction on responses', () => {
    const rs = `<?xml version="1.0" ?>
<QBXML><QBXMLMsgsRs><CustomerQueryRs statusCode="1" statusSeverity="Info" statusMessage="none"/></QBXMLMsgsRs></QBXML>`;
    expect(checkEnvelope(rs)).toEqual([]);
  });

  it('enforces a maximum version when asked', () => {
    const xml = buildRequest('CustomerQueryRq', {}, { version: '17.0' });
    expect(validate(xml).valid).toBe(true);
    expect(checkEnvelope(xml, { maxVersion: '16.0' })[0]!.message).toMatch(/newer than/);
    expect(checkEnvelope(xml, { maxVersion: '17.0' })).toEqual([]);
    expect(compareQbxmlVersions('8.0', '16.0')).toBeLessThan(0);
    expect(compareQbxmlVersions('4.1', '4.0')).toBeGreaterThan(0);
  });

  it('buildRequest refuses an unsupported version header', () => {
    expect(() => buildRequest('CustomerQueryRq', {}, { version: '99.0' })).toThrow(
      /Unsupported qbXML version/,
    );
  });
});
