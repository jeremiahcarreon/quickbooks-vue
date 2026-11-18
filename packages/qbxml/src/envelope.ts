import type { ValidationIssue } from './schema.js';

/**
 * qbXML versions QuickBooks Desktop (US) has shipped. The XSD cannot express
 * the `<?qbxml version="..."?>` processing instruction, so request documents
 * are checked against this list separately.
 */
export const QBXML_VERSIONS = [
  '1.0',
  '1.1',
  '2.0',
  '2.1',
  '3.0',
  '4.0',
  '4.1',
  '5.0',
  '6.0',
  '7.0',
  '8.0',
  '10.0',
  '11.0',
  '12.0',
  '13.0',
  '14.0',
  '15.0',
  '16.0',
  '17.0',
] as const;

const KNOWN = new Set<string>(QBXML_VERSIONS);

/** Compare two `major.minor` version strings. */
export function compareQbxmlVersions(a: string, b: string): number {
  const [am = 0, an = 0] = a.split('.').map(Number);
  const [bm = 0, bn = 0] = b.split('.').map(Number);
  return am - bm || an - bn;
}

export interface QbxmlEnvelope {
  /** True when the root holds a request message set (QBXMLMsgsRq / QBXMLSubscriptionMsgsRq). */
  isRequest: boolean;
  /** Value of the single `<?qbxml version?>` processing instruction in the prolog. */
  version?: string;
  /** Number of `<?qbxml ...?>` instructions found in the prolog. */
  piCount: number;
}

const PI_RE = /^<\?qbxml(?:\s+([^?]*))?\?>/;
const VERSION_ATTR_RE = /^version\s*=\s*(["'])([^"']*)\1\s*$/;

function lineOf(xml: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < xml.length; i++) if (xml.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * Scan the prolog (everything before the root element) for `<?qbxml?>`
 * processing instructions. Never throws; malformed XML is left to libxml2.
 */
export function readEnvelope(xml: string): QbxmlEnvelope & { issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  const versions: { value: string | undefined; at: number }[] = [];
  let rootAt = -1;
  while (i < xml.length) {
    const c = xml[i]!;
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }
    if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<?', i)) {
      const end = xml.indexOf('?>', i + 2);
      if (end < 0) break;
      const pi = xml.slice(i, end + 2);
      const m = PI_RE.exec(pi);
      if (m) {
        const attrs = (m[1] ?? '').trim();
        const v = VERSION_ATTR_RE.exec(attrs);
        versions.push({ value: v ? v[2] : undefined, at: i });
      }
      i = end + 2;
      continue;
    }
    if (xml.startsWith('<!DOCTYPE', i)) {
      // Leave DOCTYPE handling to the XSD check (QuickBooks rejects DTDs).
      const end = xml.indexOf('>', i);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (c === '<') rootAt = i;
    break;
  }
  const body = rootAt >= 0 ? xml.slice(rootAt) : '';
  const isRequest = /<QBXML(?:Subscription)?MsgsRq[\s>/]/.test(body);
  const env: QbxmlEnvelope & { issues: ValidationIssue[] } = {
    isRequest,
    piCount: versions.length,
    issues,
  };
  if (versions.length === 1 && versions[0]!.value !== undefined) env.version = versions[0]!.value;
  if (!isRequest) return env;

  if (versions.length === 0) {
    issues.push({
      line: rootAt >= 0 ? lineOf(xml, rootAt) : 1,
      message:
        'Missing <?qbxml version="..."?> processing instruction before the <QBXML> root element; QuickBooks cannot parse a request without it',
    });
  } else if (versions.length > 1) {
    issues.push({
      line: lineOf(xml, versions[1]!.at),
      message: `Exactly one <?qbxml version="..."?> processing instruction is allowed; found ${versions.length}`,
    });
  } else {
    const { value, at } = versions[0]!;
    if (value === undefined) {
      issues.push({
        line: lineOf(xml, at),
        message: 'The <?qbxml?> processing instruction must be exactly version="N.N"',
      });
    } else if (!KNOWN.has(value)) {
      issues.push({
        line: lineOf(xml, at),
        message: `Unsupported qbXML version "${value}"; expected one of ${QBXML_VERSIONS.join(', ')}`,
      });
    }
  }
  return env;
}

/**
 * Envelope problems of a request document: a missing, repeated, malformed or
 * unknown `<?qbxml version?>` instruction, or (with `maxVersion`) a version
 * newer than QuickBooks is configured to accept. Responses are not checked.
 */
export function checkEnvelope(xml: string, opts: { maxVersion?: string } = {}): ValidationIssue[] {
  const env = readEnvelope(xml);
  const issues = [...env.issues];
  if (
    env.isRequest &&
    issues.length === 0 &&
    env.version &&
    opts.maxVersion &&
    compareQbxmlVersions(env.version, opts.maxVersion) > 0
  ) {
    issues.push({
      line: 1,
      message: `qbXML version ${env.version} is newer than the configured maximum ${opts.maxVersion}`,
    });
  }
  return issues;
}

/** Version from the document's `<?qbxml version?>` instruction, if there is exactly one. */
export function qbxmlVersionOf(xml: string): string | undefined {
  return readEnvelope(xml).version;
}
