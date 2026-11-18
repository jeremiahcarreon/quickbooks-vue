// Parse an incoming qbXML request document into the JS shape used by
// @qbv/qbxml (element names as keys, repeated elements as arrays decided by
// the catalog's maxOccurs, leaf values as strings, attributes as '@name').
import { XMLParser } from 'fast-xml-parser';
import { type ObjectDef } from '@qbv/qbxml';
import { cat } from './qb.js';
import { type Json } from './util.js';

export interface ParsedRq {
  name: string;
  attrs: Record<string, string>;
  body: Json;
}

export interface ParsedRequestDoc {
  version?: string;
  msgSet: 'QBXMLMsgsRq' | 'QBXMLSubscriptionMsgsRq';
  onError: 'stopOnError' | 'continueOnError' | 'rollbackOnError';
  requests: ParsedRq[];
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
  trimValues: false,
  processEntities: false,
  ignoreDeclaration: false,
  ignorePiTags: false,
  commentPropName: false,
  cdataPropName: '#cdata',
});

const ENTITY_REF = /&(?:#(x[0-9a-fA-F]+|[0-9]+)|(amp|lt|gt|quot|apos));/g;
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(ENTITY_REF, (m, n: string | undefined, named: string | undefined) => {
    if (named) return NAMED[named] ?? m;
    const cp = n![0] === 'x' ? parseInt(n!.slice(1), 16) : parseInt(n!, 10);
    try {
      return String.fromCodePoint(cp);
    } catch {
      return m;
    }
  });
}

function toNodes(items: unknown[]): Node[] {
  const out: Node[] = [];
  for (const item of items as Record<string, unknown>[]) {
    const tag = Object.keys(item).find((k) => k !== ':@');
    if (!tag || tag === '#text' || tag === '#cdata' || tag.startsWith('?')) continue;
    const kids = (item[tag] as unknown[]) ?? [];
    let t = '';
    for (const k of kids as Record<string, unknown>[]) {
      if ('#text' in k) t += decode(String(k['#text']));
      else if ('#cdata' in k) {
        for (const c of k['#cdata'] as Record<string, unknown>[]) t += String(c['#text'] ?? '');
      }
    }
    const rawAttrs = (item[':@'] as Record<string, string>) ?? {};
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawAttrs)) attrs[k] = decode(String(v));
    out.push({ tag, attrs, children: toNodes(kids), text: t });
  }
  return out;
}

function convert(node: Node, def: ObjectDef | undefined): unknown {
  const objects = cat().objects;
  const attrEntries = Object.entries(node.attrs);
  if (node.children.length === 0) {
    const complex = def !== undefined && (def.fields.length > 0 || def.attributes !== undefined);
    if (attrEntries.length === 0) return complex && node.text.trim() === '' ? {} : node.text;
    const o: Json = {};
    for (const [k, v] of attrEntries) o[`@${k}`] = v;
    if (!complex || node.text.trim() !== '') o['#text'] = node.text;
    return o;
  }
  const o: Json = {};
  for (const [k, v] of attrEntries) o[`@${k}`] = v;
  const fields = new Map(def?.fields.map((f) => [f.name, f]));
  const counts = new Map<string, number>();
  for (const c of node.children) counts.set(c.tag, (counts.get(c.tag) ?? 0) + 1);
  for (const c of node.children) {
    const f = fields.get(c.tag);
    const cd = f?.kind === 'complex' ? objects[f.children ?? f.type] : undefined;
    const v = convert(c, cd);
    const many = f ? f.maxOccurs === 'unbounded' || f.maxOccurs > 1 : (counts.get(c.tag) ?? 0) > 1;
    if (many) {
      const list = (o[c.tag] as unknown[] | undefined) ?? [];
      list.push(v);
      o[c.tag] = list;
    } else {
      o[c.tag] = v;
    }
  }
  return o;
}

/** Read the qbXML version from the `<?qbxml version="x"?>` processing instruction. */
export function qbxmlVersion(xml: string): string | undefined {
  const m = /<\?qbxml\s+version\s*=\s*["']([^"']+)["']\s*\?>/.exec(xml);
  return m?.[1];
}

/**
 * Parse a request document that has already passed XSD validation.
 * Throws on documents that are not qbXML requests.
 */
export function parseRequestDoc(xml: string): ParsedRequestDoc {
  const nodes = toNodes(parser.parse(xml, true) as unknown[]);
  const root = nodes.find((n) => n.tag === 'QBXML');
  if (!root) throw new Error('missing <QBXML> root');
  const set = root.children.find(
    (n) => n.tag === 'QBXMLMsgsRq' || n.tag === 'QBXMLSubscriptionMsgsRq',
  );
  if (!set) throw new Error('missing QBXMLMsgsRq');
  const objects = cat().objects;
  const onError = set.attrs.onError ?? 'stopOnError';
  return {
    version: qbxmlVersion(xml),
    msgSet: set.tag as ParsedRequestDoc['msgSet'],
    onError: (['stopOnError', 'continueOnError', 'rollbackOnError'].includes(onError)
      ? onError
      : 'stopOnError') as ParsedRequestDoc['onError'],
    requests: set.children.map((n) => {
      const v = convert(n, objects[n.tag]);
      const body: Json = typeof v === 'object' && v !== null ? { ...(v as Json) } : {};
      for (const k of Object.keys(body)) if (k.startsWith('@')) delete body[k];
      return { name: n.tag, attrs: n.attrs, body };
    }),
  };
}
