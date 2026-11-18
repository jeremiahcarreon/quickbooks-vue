import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultSchemaDir,
  loadSchema,
  loadSchemaSync,
  validate,
  assertValid,
  QbxmlValidationError,
} from '../src/index.js';
import { wrapRq } from './helpers.js';

describe('schema loading', () => {
  it('loads the default schema directory and caches the compiled schema', async () => {
    const a = await loadSchema();
    const b = await loadSchema();
    expect(a).toBe(b);
    expect(a.version).toBe('17.0');
    expect(a.dir).toBe(defaultSchemaDir());
    expect(loadSchemaSync(defaultSchemaDir())).toBe(a);
  });

  it('honours QBXML_SCHEMA_DIR', () => {
    const prev = process.env.QBXML_SCHEMA_DIR;
    try {
      process.env.QBXML_SCHEMA_DIR = '/nonexistent/qbxml';
      expect(defaultSchemaDir()).toBe('/nonexistent/qbxml');
    } finally {
      if (prev === undefined) delete process.env.QBXML_SCHEMA_DIR;
      else process.env.QBXML_SCHEMA_DIR = prev;
    }
  });

  it('fails with a clear message when the XSDs are missing', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qbv-noxsd-'));
    writeFileSync(path.join(dir, 'QBUqbxmlops170.xsd'), '<x/>');
    await expect(loadSchema(dir)).rejects.toThrow(
      /XSD files missing .*QBUqbxml170\.xsd.*QBXML_SCHEMA_DIR/s,
    );
    // the default schema stays active after the failure
    expect(validate(wrapRq('<CustomerQueryRq />')).valid).toBe(true);
  });
});

describe('validate', () => {
  it('accepts a known-good request', () => {
    const xml = wrapRq(
      '<CustomerAddRq requestID="1"><CustomerAdd><Name>Acme &amp; Co</Name><CompanyName>Acme</CompanyName>' +
        '<BillAddress><Addr1>1 Main St</Addr1><City>Springfield</City><State>IL</State></BillAddress></CustomerAdd></CustomerAddRq>',
    );
    expect(validate(xml)).toEqual({ valid: true, errors: [] });
  });

  it('rejects out-of-order elements with a line number', () => {
    const xml = wrapRq(
      '<CustomerAddRq>\n<CustomerAdd>\n<CompanyName>Acme</CompanyName>\n<Name>Acme</Name>\n</CustomerAdd>\n</CustomerAddRq>',
    );
    const r = validate(xml);
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatchObject({ line: 7, path: expect.stringContaining('CompanyName') });
    expect(r.errors[0]!.message).toMatch(/CompanyName.*not expected.*Expected is \( Name \)/);
  });

  it('rejects unknown elements', () => {
    const r = validate(
      wrapRq(
        '<CustomerAddRq><CustomerAdd><Name>A</Name><Nickname>x</Nickname></CustomerAdd></CustomerAddRq>',
      ),
    );
    expect(r.valid).toBe(false);
    expect(r.errors[0]!.message).toMatch(/Nickname.*not expected/);
  });

  it('rejects values longer than maxLength', () => {
    const r = validate(
      wrapRq(
        `<CustomerAddRq><CustomerAdd><Name>${'x'.repeat(42)}</Name></CustomerAdd></CustomerAddRq>`,
      ),
    );
    expect(r.valid).toBe(false);
    expect(r.errors[0]!.message).toMatch(/maxLength.*42.*41/);
  });

  it('rejects bad enum and bad AMTTYPE lexical values', () => {
    expect(
      validate(wrapRq('<CustomerQueryRq><ActiveStatus>Sometimes</ActiveStatus></CustomerQueryRq>'))
        .valid,
    ).toBe(false);
    const amt = validate(
      wrapRq(
        '<InvoiceAddRq><InvoiceAdd><CustomerRef><FullName>A</FullName></CustomerRef>' +
          '<InvoiceLineAdd><Amount>1.234</Amount></InvoiceLineAdd></InvoiceAdd></InvoiceAddRq>',
      ),
    );
    expect(amt.valid).toBe(false);
    expect(amt.errors[0]!.message).toMatch(/Amount/);
  });

  it('rejects a missing required attribute (onError)', () => {
    const r = validate(
      '<?xml version="1.0"?><QBXML><QBXMLMsgsRq><CustomerQueryRq/></QBXMLMsgsRq></QBXML>',
    );
    expect(r.valid).toBe(false);
    expect(r.errors[0]!.message).toMatch(/onError/);
  });

  it('reports malformed XML as errors with a line number instead of throwing', () => {
    const r = validate(
      '<?xml version="1.0"?>\n<QBXML>\n<QBXMLMsgsRq onError="stopOnError">\n<CustomerQueryRq>\n</QBXMLMsgsRq></QBXML>',
    );
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]!.line).toBeGreaterThan(0);
  });

  it('assertValid throws QbxmlValidationError carrying the errors and xml', () => {
    const xml = wrapRq('<Bogus/>');
    try {
      assertValid(xml);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(QbxmlValidationError);
      const err = e as QbxmlValidationError;
      expect(err.xml).toBe(xml);
      expect(err.errors[0]!.message).toMatch(/Bogus/);
      expect(err.message).toMatch(/line \d+: /);
    }
  });
});
