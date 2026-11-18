import { XMLParser } from 'fast-xml-parser';
import { loadCatalog, type RequestDef, type RequestOp } from '@qbv/qbxml';

/** One request element (`XxxRq`) of a qbXML request document. */
export interface RqInfo {
  /** Element name, e.g. CustomerAddRq. */
  name: string;
  /** Position inside the message set (0-based). */
  index: number;
  requestID?: string;
  /** Element content: element names as keys, leaf values as strings, repeated elements as arrays. */
  body: Record<string, unknown>;
  def?: RequestDef;
  op: RequestOp;
  /** True for query requests (anything named *QueryRq), which never change QuickBooks data. */
  readOnly: boolean;
  /** The request asks for a subset of Ret elements, so returned Rets are partial. */
  partial: boolean;
}

export interface RequestInfo {
  msgSet: string;
  onError?: string;
  rqs: RqInfo[];
  /** Every request in the document is a query. */
  readOnly: boolean;
}

interface Node {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
  text: string;
}

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
  cdataPropName: '#cdata',
});

function toNodes(arr: unknown[]): Node[] {
  const out: Node[] = [];
  for (const item of arr as Record<string, unknown>[]) {
    const tag = Object.keys(item).find((k) => k !== ':@');
    if (!tag || tag === '#text' || tag === '#cdata' || tag.startsWith('?')) continue;
    const kids = (item[tag] as unknown[]) ?? [];
    let text = '';
    for (const k of kids as Record<string, unknown>[]) {
      if ('#text' in k) text += String(k['#text']);
      else if ('#cdata' in k) {
        for (const c of k['#cdata'] as Record<string, unknown>[]) text += String(c['#text'] ?? '');
      }
    }
    out.push({
      tag,
      attrs: (item[':@'] as Record<string, string>) ?? {},
      children: toNodes(kids),
      text,
    });
  }
  return out;
}

function toValue(n: Node): unknown {
  if (n.children.length === 0) {
    if (Object.keys(n.attrs).length === 0) return n.text;
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n.attrs)) o[`@${k}`] = v;
    if (n.text !== '') o['#text'] = n.text;
    return o;
  }
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n.attrs)) o[`@${k}`] = v;
  for (const c of n.children) {
    const v = toValue(c);
    const prev = o[c.tag];
    if (prev === undefined) o[c.tag] = v;
    else if (Array.isArray(prev)) prev.push(v);
    else o[c.tag] = [prev, v];
  }
  return o;
}

export class RequestParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestParseError';
  }
}

/**
 * Describe a qbXML request document: its message set, onError mode and every
 * request element with its requestID and content. Call it only on documents
 * that already passed XSD validation.
 */
export function describeRequest(xml: string): RequestInfo {
  let nodes: Node[];
  try {
    nodes = toNodes(parser.parse(xml) as unknown[]);
  } catch (err) {
    throw new RequestParseError(`Cannot parse qbXML request: ${(err as Error).message}`);
  }
  const root = nodes.find((n) => n.tag === 'QBXML');
  const set = root?.children.find(
    (n) => n.tag === 'QBXMLMsgsRq' || n.tag === 'QBXMLSubscriptionMsgsRq',
  );
  if (!set) throw new RequestParseError('Not a qbXML request: no QBXMLMsgsRq element');
  const cat = loadCatalog();
  const rqs = set.children.map((n, index): RqInfo => {
    const def = cat.requests[n.tag];
    const body = toValue(n);
    const bodyObj =
      body && typeof body === 'object'
        ? (body as Record<string, unknown>)
        : ({} as Record<string, unknown>);
    delete bodyObj['@requestID'];
    const readOnly = n.tag.endsWith('QueryRq');
    const info: RqInfo = {
      name: n.tag,
      index,
      body: bodyObj,
      op: def?.op ?? 'Other',
      readOnly,
      partial: 'IncludeRetElement' in bodyObj,
    };
    if (def) info.def = def;
    if (n.attrs.requestID !== undefined) info.requestID = n.attrs.requestID;
    return info;
  });
  const out: RequestInfo = { msgSet: set.tag, rqs, readOnly: rqs.every((r) => r.readOnly) };
  if (set.attrs.onError) out.onError = set.attrs.onError;
  return out;
}

/** First string value of a field (arrays and `#text` objects unwrapped). */
export function textOf(v: unknown): string | undefined {
  const x = Array.isArray(v) ? v[0] : v;
  if (typeof x === 'string') return x;
  if (x && typeof x === 'object' && '#text' in x) {
    const t = (x as Record<string, unknown>)['#text'];
    return typeof t === 'string' ? t : undefined;
  }
  return undefined;
}

/** Object value of a field (first entry when repeated). */
export function objectOf(v: unknown): Record<string, unknown> | undefined {
  const x = Array.isArray(v) ? v[0] : v;
  return x && typeof x === 'object' ? (x as Record<string, unknown>) : undefined;
}
