import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  XmlBufferInputProvider,
  XmlDocument,
  XmlLibError,
  XsdValidator,
  xmlRegisterInputProvider,
  type ErrorDetail,
} from 'libxml2-wasm';
import { packageRoot } from './catalog.js';
import { checkEnvelope } from './envelope.js';

export const SCHEMA_VERSION = '17.0';
export const ENTRY_XSD = 'QBUqbxmlops170.xsd';
const REQUIRED_XSDS = [ENTRY_XSD, 'QBUqbxml170.xsd', 'QBUqbxmlso170.xsd', 'qbxmltypes170.xsd'];

export interface ValidationIssue {
  line: number;
  column?: number;
  message: string;
  /** XPath of the offending node, when libxml2 reports one. */
  path?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
}

export interface QbSchema {
  /** Directory the XSDs were loaded from. */
  readonly dir: string;
  readonly version: string;
  validate(xml: string): ValidationResult;
  dispose(): void;
}

/** Thrown when a qbXML document fails XSD validation (or cannot be built). */
export class QbxmlValidationError extends Error {
  readonly errors: ValidationIssue[];
  readonly xml: string;
  constructor(errors: ValidationIssue[], xml: string, message?: string) {
    super(message ?? `qbXML failed XSD validation: ${formatIssues(errors)}`);
    this.name = 'QbxmlValidationError';
    this.errors = errors;
    this.xml = xml;
  }
}

export function formatIssues(errors: ValidationIssue[]): string {
  return errors.map((e) => (e.line ? `line ${e.line}: ${e.message}` : e.message)).join('; ');
}

export function defaultSchemaDir(): string {
  const env = process.env.QBXML_SCHEMA_DIR;
  if (env) return path.resolve(env);
  // <repo>/packages/qbxml -> <repo>/schemas/qbxml/17.0
  return path.resolve(packageRoot(), '..', '..', 'schemas', 'qbxml', SCHEMA_VERSION);
}

function toIssues(details: ErrorDetail[] | undefined, fallback: string): ValidationIssue[] {
  if (!details || details.length === 0) return [{ line: 0, message: fallback.trim() }];
  return details.map((d) => {
    const issue: ValidationIssue = { line: d.line ?? 0, message: d.message.trim() };
    if (d.col) issue.column = d.col;
    const xp = (d as { xpath?: string }).xpath;
    if (xp) issue.path = xp;
    return issue;
  });
}

let providerSeq = 0;

class LibxmlSchema implements QbSchema {
  readonly dir: string;
  readonly version = SCHEMA_VERSION;
  private validator: XsdValidator | undefined;

  constructor(dir: string) {
    this.dir = dir;
    const missing = REQUIRED_XSDS.filter((f) => !existsSync(path.join(dir, f)));
    if (missing.length) {
      throw new Error(
        `qbXML XSD files missing from ${dir}: ${missing.join(', ')}. ` +
          'Copy the Intuit qbXML 17.0 schemas from the QuickBooks SDK into that directory ' +
          'or set QBXML_SCHEMA_DIR (see docs/DESIGN.md §4).',
      );
    }
    // Serve every .xsd in the directory from memory under a private URL prefix,
    // so xsd:include resolves without touching the real filesystem layout.
    const prefix = `qbxsd-${++providerSeq}:///`;
    const buffers: Record<string, Uint8Array> = {};
    for (const f of readdirSync(dir)) {
      if (f.toLowerCase().endsWith('.xsd')) buffers[prefix + f] = readFileSync(path.join(dir, f));
    }
    xmlRegisterInputProvider(new XmlBufferInputProvider(buffers));
    const entryUrl = prefix + ENTRY_XSD;
    const entry = buffers[entryUrl];
    if (!entry) throw new Error(`qbXML entry schema ${ENTRY_XSD} not found in ${dir}`);
    let doc: XmlDocument | undefined;
    try {
      doc = XmlDocument.fromBuffer(entry, { url: entryUrl });
      this.validator = XsdValidator.fromDoc(doc);
    } catch (err) {
      const details = err instanceof XmlLibError ? err.details : undefined;
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to compile qbXML schema from ${dir}: ${formatIssues(toIssues(details, msg))}`,
      );
    } finally {
      doc?.dispose();
    }
  }

  validate(xml: string): ValidationResult {
    if (!this.validator) throw new Error('qbXML schema has been disposed');
    let doc: XmlDocument;
    try {
      doc = XmlDocument.fromString(xml);
    } catch (err) {
      const details = err instanceof XmlLibError ? err.details : undefined;
      const msg = err instanceof Error ? err.message : String(err);
      return { valid: false, errors: toIssues(details, msg) };
    }
    // The XSD cannot express the <?qbxml version?> instruction QuickBooks
    // needs, so request documents are also checked for it here.
    const envelope = checkEnvelope(xml);
    try {
      this.validator.validate(doc);
      return envelope.length ? { valid: false, errors: envelope } : { valid: true, errors: [] };
    } catch (err) {
      const details = err instanceof XmlLibError ? err.details : undefined;
      const msg = err instanceof Error ? err.message : String(err);
      return { valid: false, errors: [...toIssues(details, msg), ...envelope] };
    } finally {
      doc.dispose();
    }
  }

  dispose(): void {
    this.validator?.dispose();
    this.validator = undefined;
  }
}

const cache = new Map<string, QbSchema>();
let active: QbSchema | undefined;

/** Load and compile the schema synchronously (cached per directory). */
export function loadSchemaSync(dir?: string): QbSchema {
  const d = path.resolve(dir ?? defaultSchemaDir());
  let s = cache.get(d);
  if (!s) {
    s = new LibxmlSchema(d);
    cache.set(d, s);
  }
  if (dir !== undefined || !active) active = s;
  return s;
}

/**
 * Load and compile the qbXML schema (default: QBXML_SCHEMA_DIR or
 * <repo>/schemas/qbxml/17.0). The compiled schema is cached; loading a
 * directory explicitly makes it the one `validate()` and `buildRequest()` use.
 */
export async function loadSchema(dir?: string): Promise<QbSchema> {
  return loadSchemaSync(dir);
}

/** The schema used by `validate()`; loads the default on first use. */
export function activeSchema(): QbSchema {
  return active ?? loadSchemaSync();
}

/** Validate a qbXML document against the XSD. Never throws for invalid XML. */
export function validate(xml: string): ValidationResult {
  return activeSchema().validate(xml);
}

/** Validate and throw QbxmlValidationError when invalid. */
export function assertValid(xml: string): void {
  const r = validate(xml);
  if (!r.valid) throw new QbxmlValidationError(r.errors, xml);
}
