import {
  getObject,
  getRequest,
  loadCatalog,
  suggest,
  type FieldDef,
  type ObjectDef,
  type RequestDef,
} from './catalog.js';
import { QbxmlValidationError, validate, type ValidationIssue } from './schema.js';
import { formatValue, QbxmlValueError, type QbScalar } from './values.js';

export type OnError = 'stopOnError' | 'continueOnError' | 'rollbackOnError';

export interface BuildOptions {
  requestID?: string;
  onError?: OnError;
  /** qbXML version header; default process.env.QBXML_VERSION || '16.0'. */
  version?: string;
  iterator?: 'Start' | 'Continue' | 'Stop';
  iteratorID?: string;
  metaData?: 'NoMetaData' | 'MetaDataOnly' | 'MetaDataAndResponseData';
}

export interface BatchPart {
  rq: string;
  body?: object;
  opts?: Omit<BuildOptions, 'onError' | 'version'>;
}

/** Thrown before validation when the body does not fit the catalog (unknown field, bad value, ...). */
export class QbxmlBuildError extends QbxmlValidationError {
  constructor(issues: ValidationIssue[]) {
    super(issues, '', `Cannot build qbXML: ${issues.map((i) => i.message).join('; ')}`);
    this.name = 'QbxmlBuildError';
  }
}

export function defaultVersion(): string {
  return process.env.QBXML_VERSION || '16.0';
}

// Characters that are not allowed in XML 1.0 documents.
// eslint-disable-next-line no-control-regex
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

/** Escape text for element content or a double-quoted attribute value. */
export function escapeXml(s: string): string {
  return s
    .replace(XML_INVALID, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

type Json = Record<string, unknown>;

function isPlainObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

class Writer {
  readonly lines: string[] = [];
  readonly issues: ValidationIssue[] = [];
  private fieldIndex = new Map<string, Map<string, { field: FieldDef; index: number }>>();

  private indexOf(obj: ObjectDef): Map<string, { field: FieldDef; index: number }> {
    let m = this.fieldIndex.get(obj.name);
    if (!m) {
      m = new Map();
      obj.fields.forEach((field, index) => {
        if (!m!.has(field.name)) m!.set(field.name, { field, index });
      });
      this.fieldIndex.set(obj.name, m);
    }
    return m;
  }

  fail(path: string, message: string): void {
    this.issues.push({ line: 0, message: `${path}: ${message}`, path });
  }

  /** Render attributes from '@name' keys plus extra attributes. */
  private attrs(
    allowed: { name: string }[] | undefined,
    value: Json,
    path: string,
    extra: [string, string | undefined][] = [],
  ): string {
    const out: string[] = [];
    for (const [k, v] of extra) if (v !== undefined) out.push(` ${k}="${escapeXml(v)}"`);
    for (const [k, v] of Object.entries(value)) {
      if (!k.startsWith('@') || v === undefined || v === null) continue;
      const name = k.slice(1);
      if (!allowed?.some((a) => a.name === name)) {
        const names = (allowed ?? []).map((a) => a.name);
        const hint = suggest(name, names);
        this.fail(path, `unknown attribute "${name}"${hint ? `; did you mean ${hint}?` : ''}`);
        continue;
      }
      if (extra.some(([e]) => e === name)) continue;
      out.push(` ${name}="${escapeXml(String(v))}"`);
    }
    return out.join('');
  }

  element(
    name: string,
    obj: ObjectDef,
    value: Json,
    path: string,
    depth: number,
    extra: [string, string | undefined][] = [],
  ): void {
    const ind = '  '.repeat(depth);
    const attrs = this.attrs(obj.attributes, value, path, extra);
    const start = this.lines.length;
    this.lines.push(`${ind}<${name}${attrs}>`);
    this.content(obj, value, path, depth + 1);
    if (this.lines.length === start + 1) this.lines[start] = `${ind}<${name}${attrs} />`;
    else this.lines.push(`${ind}</${name}>`);
  }

  content(obj: ObjectDef, value: Json, path: string, depth: number): void {
    const idx = this.indexOf(obj);
    const entries: { field: FieldDef; index: number; key: string; v: unknown }[] = [];
    for (const [key, v] of Object.entries(value)) {
      if (key.startsWith('@')) continue;
      if (v === undefined || v === null) continue;
      const hit = idx.get(key);
      if (!hit) {
        const names = obj.fields.map((f) => f.name);
        const hint = suggest(key, names);
        this.fail(
          path,
          `unknown field "${key}" in ${obj.name}` +
            (hint ? `; did you mean ${hint}?` : `; allowed: ${names.join(', ') || '(none)'}`),
        );
        continue;
      }
      entries.push({ ...hit, key, v });
    }
    entries.sort((a, b) => a.index - b.index);
    for (const { field, key, v } of entries) {
      const many = field.maxOccurs === 'unbounded' || field.maxOccurs > 1;
      let items: unknown[] = Array.isArray(v) ? v : [v];
      if (!many && items.length > 1) {
        this.fail(
          `${path}.${key}`,
          `${key} may occur at most once but ${items.length} values were given`,
        );
        items = items.slice(0, 1);
      }
      items.forEach((item, i) => {
        const p = Array.isArray(v) ? `${path}.${key}[${i}]` : `${path}.${key}`;
        if (item === undefined || item === null) return;
        if (field.kind === 'complex') {
          if (!isPlainObject(item)) {
            this.fail(p, `expected an object for ${key}, got ${typeof item}`);
            return;
          }
          this.element(field.name, getObject(field.children ?? field.type), item, p, depth);
        } else {
          this.simple(field, item, p, depth);
        }
      });
    }
  }

  simple(field: FieldDef, item: unknown, path: string, depth: number): void {
    const ind = '  '.repeat(depth);
    let text: unknown = item;
    let attrs = '';
    if (isPlainObject(item)) {
      if (!field.attributes) {
        this.fail(path, `${field.name} is a simple ${field.type} value; got an object`);
        return;
      }
      attrs = this.attrs(field.attributes, item, path);
      for (const k of Object.keys(item)) {
        if (k !== '#text' && !k.startsWith('@'))
          this.fail(path, `unexpected key "${k}" in ${field.name}`);
      }
      text = item['#text'] ?? '';
    }
    let s: string;
    try {
      s = formatValue(field.type, text as QbScalar);
    } catch (err) {
      this.fail(path, err instanceof QbxmlValueError ? err.message : String(err));
      return;
    }
    this.lines.push(`${ind}<${field.name}${attrs}>${escapeXml(s)}</${field.name}>`);
  }
}

/**
 * Accept either the content of the Rq element ({ CustomerAdd: {...} }) or, for
 * requests with a body element, just the body ({ Name: 'x' }), which is wrapped.
 */
function normalizeBody(rq: RequestDef, body: object | undefined): Json {
  const b: Json = body === undefined ? {} : (body as Json);
  if (!isPlainObject(b))
    throw new QbxmlBuildError([{ line: 0, message: `${rq.name}: body must be an object` }]);
  if (!rq.bodyElement) return b;
  const rqObj = getObject(rq.name);
  const top = new Set(rqObj.fields.map((f) => f.name));
  const keys = Object.keys(b).filter((k) => !k.startsWith('@'));
  if (keys.length === 0 || keys.every((k) => top.has(k))) return b;
  const bodyObj = getObject(rq.bodyElement);
  const inner = new Set(bodyObj.fields.map((f) => f.name));
  const wrapped: Json = { [rq.bodyElement]: {} };
  const target = wrapped[rq.bodyElement] as Json;
  for (const [k, v] of Object.entries(b)) {
    if (top.has(k) && !inner.has(k))
      wrapped[k] = v; // e.g. IncludeRetElement
    else target[k] = v;
  }
  return wrapped;
}

function renderRq(
  w: Writer,
  rqName: string,
  body: object | undefined,
  opts: BuildOptions,
  depth: number,
): RequestDef {
  const rq = getRequest(rqName);
  const obj = getObject(rq.name);
  const value = normalizeBody(rq, body);
  const p = rq.name;
  if ((opts.iterator || opts.iteratorID) && !rq.supportsIterator) {
    w.fail(p, `${rq.name} does not support iterators`);
  }
  if (opts.metaData && !rq.supportsMetaData)
    w.fail(p, `${rq.name} does not support the metaData attribute`);
  if (opts.iterator === 'Continue' || opts.iterator === 'Stop') {
    if (!opts.iteratorID) w.fail(p, `iterator="${opts.iterator}" requires iteratorID`);
  }
  w.element(rq.name, obj, value, p, depth, [
    ['requestID', opts.requestID],
    ['metaData', opts.metaData],
    ['iterator', opts.iterator],
    ['iteratorID', opts.iterator === 'Start' ? undefined : opts.iteratorID],
  ]);
  return rq;
}

function wrap(inner: string[], msgSet: string, onError: OnError, version: string): string {
  const attrs = msgSet === 'QBXMLMsgsRq' ? ` onError="${onError}"` : '';
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<?qbxml version="${escapeXml(version)}"?>`,
    '<QBXML>',
    `  <${msgSet}${attrs}>`,
    ...inner,
    `  </${msgSet}>`,
    '</QBXML>',
    '',
  ].join('\n');
}

function finish(w: Writer, xml: () => string): string {
  if (w.issues.length) throw new QbxmlBuildError(w.issues);
  const doc = xml();
  const r = validate(doc);
  if (!r.valid) throw new QbxmlValidationError(r.errors, doc);
  return doc;
}

/**
 * Build one qbXML request document: keys reordered into schema order, values
 * escaped, wrapped in QBXML/QBXMLMsgsRq, then validated against the XSD.
 * @throws QbxmlBuildError for unknown fields / unrepresentable values
 * @throws QbxmlValidationError when the document fails XSD validation
 */
export function buildRequest(rq: string, body?: object, opts: BuildOptions = {}): string {
  loadCatalog();
  const w = new Writer();
  const def = renderRq(w, rq, body, opts, 2);
  return finish(w, () =>
    wrap(w.lines, def.msgSet, opts.onError ?? 'stopOnError', opts.version ?? defaultVersion()),
  );
}

/**
 * Build a multi-request document. Parts without a requestID get their index
 * ("0", "1", ...) so responses can be matched. All parts must belong to the
 * same message set.
 */
export function buildBatch(
  parts: BatchPart[],
  onError: OnError | { onError?: OnError; version?: string } = 'stopOnError',
): string {
  loadCatalog();
  const o = typeof onError === 'string' ? { onError } : onError;
  if (parts.length === 0)
    throw new QbxmlBuildError([{ line: 0, message: 'buildBatch: no requests given' }]);
  const w = new Writer();
  let msgSet: string | undefined;
  parts.forEach((part, i) => {
    const def = renderRq(
      w,
      part.rq,
      part.body,
      { ...part.opts, requestID: part.opts?.requestID ?? String(i) },
      2,
    );
    if (msgSet && def.msgSet !== msgSet) {
      w.fail(part.rq, `cannot mix ${def.msgSet} and ${msgSet} requests in one batch`);
    }
    msgSet ??= def.msgSet;
  });
  return finish(w, () =>
    wrap(
      w.lines,
      msgSet ?? 'QBXMLMsgsRq',
      o.onError ?? 'stopOnError',
      o.version ?? defaultVersion(),
    ),
  );
}

export interface ResponsePart {
  /** Response element name, e.g. CustomerQueryRs. */
  rs: string;
  /** Content of the Rs element, e.g. { CustomerRet: [...] }. */
  body?: object;
  requestID?: string;
  statusCode?: number;
  statusSeverity?: 'Info' | 'Warn' | 'Error';
  statusMessage?: string;
  retCount?: number;
  iteratorID?: string;
  iteratorRemainingCount?: number;
}

/**
 * Build a qbXML response document (what QuickBooks returns), validated against
 * the XSD. Used by test doubles such as the relay mock.
 */
export function buildResponse(parts: ResponsePart[]): string {
  const cat = loadCatalog();
  const w = new Writer();
  let msgSet: string | undefined;
  for (const part of parts) {
    const rqName = part.rs.replace(/Rs$/, 'Rq');
    const rq = cat.requests[rqName];
    const obj = cat.objects[part.rs];
    if (!rq || !obj || rq.response !== part.rs) {
      const hint = suggest(
        part.rs,
        Object.values(cat.requests).map((r) => r.response),
      );
      w.fail(part.rs, `unknown response "${part.rs}"${hint ? `; did you mean ${hint}?` : ''}`);
      continue;
    }
    const set = rq.msgSet === 'QBXMLMsgsRq' ? 'QBXMLMsgsRs' : 'QBXMLSubscriptionMsgsRs';
    if (msgSet && set !== msgSet) w.fail(part.rs, `cannot mix ${set} and ${msgSet} responses`);
    msgSet ??= set;
    const code = part.statusCode ?? 0;
    const body = (part.body ?? {}) as Json;
    if (!isPlainObject(body)) {
      w.fail(part.rs, 'body must be an object');
      continue;
    }
    w.element(part.rs, obj, body, part.rs, 2, [
      ['requestID', part.requestID],
      ['statusCode', String(code)],
      [
        'statusSeverity',
        part.statusSeverity ?? (code === 0 ? 'Info' : code < 1000 ? 'Warn' : 'Error'),
      ],
      ['statusMessage', part.statusMessage ?? (code === 0 ? 'Status OK' : undefined)],
      ['retCount', part.retCount !== undefined ? String(part.retCount) : undefined],
      [
        'iteratorRemainingCount',
        part.iteratorRemainingCount !== undefined ? String(part.iteratorRemainingCount) : undefined,
      ],
      ['iteratorID', part.iteratorID],
    ]);
  }
  return finish(w, () =>
    [
      '<?xml version="1.0" ?>',
      '<QBXML>',
      `  <${msgSet ?? 'QBXMLMsgsRs'}>`,
      ...w.lines,
      `  </${msgSet ?? 'QBXMLMsgsRs'}>`,
      '</QBXML>',
      '',
    ].join('\n'),
  );
}
