import { XMLParser } from 'fast-xml-parser';
import { loadCatalog, type ObjectDef } from './catalog.js';

export interface ParsedRs {
  /** Response element name, e.g. CustomerQueryRs. */
  name: string;
  requestID?: string;
  statusCode: number;
  statusSeverity: 'Info' | 'Warn' | 'Error';
  statusMessage: string;
  /** Every *Ret element in document order. */
  rets: Record<string, unknown>[];
  /** Ret element name when all rets share one (or the response defines exactly one). */
  retName?: string;
  /** Ret element name of each entry in `rets` (useful for union queries such as ItemQueryRq). */
  retNames: string[];
  retCount?: number;
  iteratorID?: string;
  iteratorRemainingCount?: number;
  /** Whole parsed response element (attributes as '@name'). */
  body: Record<string, unknown>;
  /** Raw XML of this response element. */
  raw: string;
}

export class QbxmlParseError extends Error {
  readonly xml: string;
  constructor(message: string, xml: string) {
    super(message);
    this.name = 'QbxmlParseError';
    this.xml = xml;
  }
}

interface ONode {
  tag: string;
  attrs: Record<string, string>;
  children: ONode[];
  text: string;
}

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  // Entities are decoded below in a single pass so "&amp;#38;" stays "&#38;".
  processEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  commentPropName: false,
  cdataPropName: '#cdata',
});

function toNodes(arr: unknown[]): ONode[] {
  const out: ONode[] = [];
  for (const item of arr as Record<string, unknown>[]) {
    const tag = Object.keys(item).find((k) => k !== ':@');
    if (!tag || tag === '#text' || tag === '#cdata' || tag.startsWith('?')) continue;
    const kids = (item[tag] as unknown[]) ?? [];
    let text = '';
    for (const k of kids as Record<string, unknown>[]) {
      if ('#text' in k) text += decodeEntities(String(k['#text']));
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

const ENTITY_REF = /&(?:#(x[0-9a-fA-F]+|[0-9]+)|(amp|lt|gt|quot|apos));/g;
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decode XML predefined entities and character references in one pass. */
function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(ENTITY_REF, (m, num: string | undefined, named: string | undefined) => {
    if (named) return NAMED[named] ?? m;
    const cp = num![0] === 'x' ? parseInt(num!.slice(1), 16) : parseInt(num!, 10);
    try {
      return String.fromCodePoint(cp);
    } catch {
      return m;
    }
  });
}

/** Convert an element to the JS shape. `def` drives which children are arrays. */
function convert(
  node: ONode,
  def: ObjectDef | undefined,
  objects: Record<string, ObjectDef>,
): unknown {
  const attrEntries = Object.entries(node.attrs);
  if (node.children.length === 0) {
    const isComplexDef =
      def !== undefined && (def.fields.length > 0 || def.attributes !== undefined);
    if (attrEntries.length === 0) {
      // Leaf: string, unless the schema says it is a complex element (then {}).
      return isComplexDef && node.text.trim() === '' ? {} : node.text;
    }
    const o: Record<string, unknown> = {};
    for (const [k, v] of attrEntries) o[`@${k}`] = decodeEntities(v);
    if (!isComplexDef || node.text.trim() !== '') o['#text'] = node.text;
    return o;
  }
  const o: Record<string, unknown> = {};
  for (const [k, v] of attrEntries) o[`@${k}`] = decodeEntities(v);
  const fieldMap = new Map(def?.fields.map((f) => [f.name, f]));
  const counts = new Map<string, number>();
  for (const c of node.children) counts.set(c.tag, (counts.get(c.tag) ?? 0) + 1);
  for (const c of node.children) {
    const f = fieldMap.get(c.tag);
    const childDef = f?.kind === 'complex' ? objects[f.children ?? f.type] : undefined;
    const v = convert(c, childDef, objects);
    const many = f ? f.maxOccurs === 'unbounded' || f.maxOccurs > 1 : (counts.get(c.tag) ?? 0) > 1;
    if (many) {
      const arr = (o[c.tag] as unknown[] | undefined) ?? [];
      arr.push(v);
      o[c.tag] = arr;
    } else {
      o[c.tag] = v;
    }
  }
  return o;
}

/** Locate the raw text of each response element in document order. */
function rawSlices(xml: string, names: string[]): string[] {
  const out: string[] = [];
  let pos = 0;
  for (const name of names) {
    const re = new RegExp(`<${name}(?=[\\s/>])`, 'g');
    re.lastIndex = pos;
    const m = re.exec(xml);
    if (!m) {
      out.push('');
      continue;
    }
    const start = m.index;
    const gt = xml.indexOf('>', start);
    if (gt > 0 && xml[gt - 1] === '/') {
      out.push(xml.slice(start, gt + 1));
      pos = gt + 1;
      continue;
    }
    const close = `</${name}>`;
    const end = xml.indexOf(close, gt);
    const stop = end < 0 ? xml.length : end + close.length;
    out.push(xml.slice(start, stop));
    pos = stop;
  }
  return out;
}

const SEVERITIES = new Set(['Info', 'Warn', 'Error']);

/**
 * Parse a qbXML response document into one ParsedRs per response element
 * (QBXMLMsgsRs / QBXMLSubscriptionMsgsRs children, in order). Repeated
 * elements become arrays based on the catalog's maxOccurs, so a single
 * invoice line is still an array; leaf values stay strings.
 */
export function parseResponse(xml: string): ParsedRs[] {
  let nodes: ONode[];
  try {
    nodes = toNodes(parser.parse(xml, true) as unknown[]);
  } catch (err) {
    throw new QbxmlParseError(
      `Malformed qbXML response: ${err instanceof Error ? err.message : String(err)}`,
      xml,
    );
  }
  const root = nodes.find((n) => n.tag === 'QBXML');
  if (!root) throw new QbxmlParseError('Not a qbXML document: missing <QBXML> root', xml);
  const cat = loadCatalog();
  const rsNodes: ONode[] = [];
  for (const set of root.children) {
    if (set.tag === 'QBXMLMsgsRs' || set.tag === 'QBXMLSubscriptionMsgsRs')
      rsNodes.push(...set.children);
  }
  const raws = rawSlices(
    xml,
    rsNodes.map((n) => n.tag),
  );
  return rsNodes.map((node, i) => {
    const def = cat.objects[node.tag];
    const body = convert(node, def, cat.objects);
    const bodyObj: Record<string, unknown> =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const a = node.attrs;
    const rets: Record<string, unknown>[] = [];
    const retNames: string[] = [];
    for (const c of node.children) {
      if (!c.tag.endsWith('Ret')) continue;
      const f = def?.fields.find((x) => x.name === c.tag);
      const v = convert(c, f ? cat.objects[f.children ?? f.type] : undefined, cat.objects);
      rets.push(
        typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : { '#text': v },
      );
      retNames.push(c.tag);
    }
    const rqDef = cat.requests[node.tag.replace(/Rs$/, 'Rq')];
    const unique = [...new Set(retNames)];
    const retName =
      unique.length === 1 ? unique[0] : unique.length === 0 ? rqDef?.retElement : undefined;
    const severity = a.statusSeverity ?? 'Info';
    const out: ParsedRs = {
      name: node.tag,
      statusCode: a.statusCode !== undefined ? Number(a.statusCode) : 0,
      statusSeverity: (SEVERITIES.has(severity) ? severity : 'Error') as ParsedRs['statusSeverity'],
      statusMessage: a.statusMessage !== undefined ? decodeEntities(a.statusMessage) : '',
      rets,
      retNames,
      body: bodyObj,
      raw: raws[i] ?? '',
    };
    if (a.requestID !== undefined) out.requestID = a.requestID;
    if (retName) out.retName = retName;
    if (a.retCount !== undefined) out.retCount = Number(a.retCount);
    if (a.iteratorID !== undefined) out.iteratorID = a.iteratorID;
    if (a.iteratorRemainingCount !== undefined)
      out.iteratorRemainingCount = Number(a.iteratorRemainingCount);
    return out;
  });
}

/** True for statusCode 0 and informational/warning codes (1–999) that still succeeded. */
export function isOk(rs: Pick<ParsedRs, 'statusCode' | 'statusSeverity'>): boolean {
  return rs.statusCode === 0 || (rs.statusSeverity !== 'Error' && rs.statusCode < 1000);
}
