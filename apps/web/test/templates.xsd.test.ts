// @vitest-environment node
import { validate } from '@qbv/qbxml';
import { describe, expect, it } from 'vitest';
import { QBXML_TEMPLATES } from '@/lib/qbxmlTemplates';
import { prettyXml } from '@/lib/xml';

describe('qbXML console templates', () => {
  it.each(QBXML_TEMPLATES.map((t) => [t.name, t.xml]))('%s is XSD-valid', (_name, xml) => {
    const res = validate(xml);
    expect(res.errors, xml).toEqual([]);
    expect(res.valid).toBe(true);
  });

  it('stay XSD-valid after the console reformats them', () => {
    for (const t of QBXML_TEMPLATES) {
      const res = validate(prettyXml(t.xml));
      expect(res.errors, t.name).toEqual([]);
    }
  });

  it('libxml2 reports line numbers the console can mark', () => {
    const bad = QBXML_TEMPLATES[2]!.xml.replace(
      '<MaxReturned>10</MaxReturned>',
      '<MaxReturned>ten</MaxReturned>',
    );
    const res = validate(bad);
    expect(res.valid).toBe(false);
    expect(res.errors[0]!.line).toBe(6);
  });
});
