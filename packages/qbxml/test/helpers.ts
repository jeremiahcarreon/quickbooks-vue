import { expect } from 'vitest';
import { validate } from '../src/index.js';

/** Assert that a qbXML document is valid against the XSD, showing libxml2 errors otherwise. */
export function expectValid(xml: string): void {
  const r = validate(xml);
  expect(r.errors, xml).toEqual([]);
  expect(r.valid).toBe(true);
}

export function wrapRq(inner: string, onError = 'stopOnError'): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<?qbxml version="16.0"?>\n<QBXML>\n<QBXMLMsgsRq onError="${onError}">\n${inner}\n</QBXMLMsgsRq>\n</QBXML>\n`;
}
