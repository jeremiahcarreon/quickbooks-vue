#!/usr/bin/env node
// Generates packages/qbxml/generated/{catalog.json,types.ts} from the Intuit
// qbXML XSDs. The XSDs and the generated output are both local-only (see
// docs/DESIGN.md §4); nothing produced here may be committed.
//
// Usage:
//   node scripts/codegen.mjs              always regenerate (fails if XSDs missing)
//   node scripts/codegen.mjs --if-stale   regenerate only when inputs changed
//   node scripts/codegen.mjs --if-schemas like --if-stale, but exit 0 with a
//                                         notice when the XSDs are not present
//                                         (used by postinstall)
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, '..');
const repoRoot = path.resolve(pkgDir, '..', '..');
const outDir = path.join(pkgDir, 'generated');

export const ENTRY_XSD = 'QBUqbxmlops170.xsd';
export const SCHEMA_VERSION = '17.0';

export function defaultSchemaDir() {
  return process.env.QBXML_SCHEMA_DIR
    ? path.resolve(process.env.QBXML_SCHEMA_DIR)
    : path.join(repoRoot, 'schemas', 'qbxml', SCHEMA_VERSION);
}

const BASE_TYPES = new Set([
  'IDTYPE',
  'STRTYPE',
  'BOOLTYPE',
  'DATETYPE',
  'DATETIMETYPE',
  'TIMEINTERVALTYPE',
  'AMTTYPE',
  'PRICETYPE',
  'QUANTYPE',
  'PERCENTTYPE',
  'ENUMTYPE',
  'INTTYPE',
  'GUIDTYPE',
  'UUIDTYPE',
  'MACROTYPE',
  'FLOATTYPE',
]);

// ---------------------------------------------------------------------------
// XSD loading

/** @typedef {{ tag: string, attrs: Record<string,string>, children: XNode[] }} XNode */

function toNodes(arr) {
  /** @type {XNode[]} */
  const out = [];
  for (const item of arr) {
    const tag = Object.keys(item).find((k) => k !== ':@');
    if (!tag || tag === '#text' || tag === '#comment' || tag.startsWith('?')) continue;
    const local = tag.replace(/^xsd?:/, '');
    out.push({ tag: local, attrs: item[':@'] ?? {}, children: toNodes(item[tag] ?? []) });
  }
  return out;
}

function readSchemaFiles(dir) {
  const entry = path.join(dir, ENTRY_XSD);
  if (!existsSync(entry)) {
    throw new Error(
      `qbXML schema not found: ${entry}\n` +
        'Copy the Intuit qbXML 17.0 XSDs (QBUqbxmlops170.xsd, QBUqbxml170.xsd, ' +
        'QBUqbxmlso170.xsd, qbxmltypes170.xsd) from the QuickBooks SDK into ' +
        `${dir} or set QBXML_SCHEMA_DIR. See docs/DESIGN.md §4.`,
    );
  }
  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '',
    commentPropName: '#comment',
    parseAttributeValue: false,
    parseTagValue: false,
  });
  /** @type {{file: string, text: string, root: XNode}[]} */
  const files = [];
  const seen = new Set();
  const queue = [ENTRY_XSD];
  while (queue.length) {
    const f = /** @type {string} */ (queue.shift());
    if (seen.has(f)) continue;
    seen.add(f);
    const full = path.join(dir, f);
    if (!existsSync(full)) throw new Error(`qbXML schema include not found: ${full}`);
    const text = readFileSync(full, 'utf8');
    const nodes = toNodes(parser.parse(text));
    const root = nodes.find((n) => n.tag === 'schema');
    if (!root) throw new Error(`${full} is not an XML Schema document`);
    files.push({ file: f, text, root });
    for (const c of root.children) if (c.tag === 'include') queue.push(c.attrs.schemaLocation);
  }
  return files;
}

// ---------------------------------------------------------------------------
// Model compilation

function occ(v, dflt = 1) {
  if (v === undefined) return dflt;
  if (v === 'unbounded') return 'unbounded';
  return Number(v);
}
function mulMax(a, b) {
  if (a === 'unbounded' || b === 'unbounded') return a === 0 || b === 0 ? 0 : 'unbounded';
  return a * b;
}

export function compile(files) {
  /** @type {Map<string, XNode>} */ const elements = new Map();
  /** @type {Map<string, XNode>} */ const groups = new Map();
  /** @type {Map<string, XNode>} */ const complexTypes = new Map();
  /** @type {Map<string, XNode>} */ const simpleTypes = new Map();
  for (const { root } of files) {
    for (const c of root.children) {
      const n = c.attrs.name;
      if (c.tag === 'element') elements.set(n, c);
      else if (c.tag === 'group') groups.set(n, c);
      else if (c.tag === 'complexType') complexTypes.set(n, c);
      else if (c.tag === 'simpleType') simpleTypes.set(n, c);
    }
  }

  // Base simple types: record maxLength (IDTYPE has 36).
  const baseInfo = {};
  for (const [name, st] of simpleTypes) {
    const r = st.children.find((c) => c.tag === 'restriction');
    const ml = r?.children.find((c) => c.tag === 'maxLength');
    baseInfo[name] = { maxLength: ml ? Number(ml.attrs.value) : undefined };
  }

  /** @type {Record<string, any>} */ const objects = {};
  const structKeyByName = new Map(); // object name -> canonical structure key
  const nameByStruct = new Map(); // structure key -> object name
  const stats = { collisions: 0 };

  function simpleFromSimpleType(st) {
    // anonymous simpleType: restriction base=X with facets
    const r = st.children.find((c) => c.tag === 'restriction');
    if (!r) {
      if (st.children.some((c) => c.tag === 'union')) return { type: 'STRTYPE' };
      throw new Error('Unsupported simpleType without restriction');
    }
    return facets(r);
  }
  function facets(r) {
    const base = r.attrs.base.replace(/^xsd?:/, '');
    const out = { type: BASE_TYPES.has(base) ? base : base };
    const ml = r.children.find((c) => c.tag === 'maxLength');
    if (ml) out.maxLength = Number(ml.attrs.value);
    else if (baseInfo[base]?.maxLength !== undefined) out.maxLength = baseInfo[base].maxLength;
    const en = r.children.filter((c) => c.tag === 'enumeration').map((c) => c.attrs.value);
    if (en.length) out.enum = en;
    const minI = r.children.find((c) => c.tag === 'minInclusive');
    const maxI = r.children.find((c) => c.tag === 'maxInclusive');
    if (minI) out.minInclusive = Number(minI.attrs.value);
    if (maxI) out.maxInclusive = Number(maxI.attrs.value);
    return out;
  }
  function attrDefs(nodes) {
    const out = [];
    for (const a of nodes) {
      if (a.tag !== 'attribute') continue;
      const d = { name: a.attrs.name, type: 'STRTYPE', required: a.attrs.use === 'required' };
      if (a.attrs.type) d.type = a.attrs.type;
      const st = a.children.find((c) => c.tag === 'simpleType');
      if (st) Object.assign(d, simpleFromSimpleType(st));
      if (a.attrs.default !== undefined) d.default = a.attrs.default;
      out.push(d);
    }
    return out;
  }

  /**
   * Resolve an element declaration into a field descriptor (without occurrence info).
   * @param {XNode} el  the element node (local or global)
   * @param {string} parentName  object name of the containing object (for naming collisions)
   */
  function resolveElementType(el, parentName) {
    const name = el.attrs.name;
    if (el.attrs.type) {
      const t = el.attrs.type.replace(/^xsd?:/, '');
      if (simpleTypes.has(t) || BASE_TYPES.has(t)) {
        const f = { kind: 'simple', type: t };
        if (baseInfo[t]?.maxLength !== undefined) f.maxLength = baseInfo[t].maxLength;
        return f;
      }
      const ct = complexTypes.get(t);
      if (!ct) throw new Error(`Unknown type ${t} for element ${name}`);
      return complexObject(name, ct, parentName);
    }
    const st = el.children.find((c) => c.tag === 'simpleType');
    if (st) return { kind: 'simple', ...simpleFromSimpleType(st) };
    const ct = el.children.find((c) => c.tag === 'complexType');
    if (ct) {
      const sc = ct.children.find((c) => c.tag === 'simpleContent');
      if (sc) {
        const ext = sc.children.find((c) => c.tag === 'extension' || c.tag === 'restriction');
        const base = ext.attrs.base.replace(/^xsd?:/, '');
        const f = { kind: 'simple', type: base };
        if (baseInfo[base]?.maxLength !== undefined) f.maxLength = baseInfo[base].maxLength;
        const attrs = attrDefs(ext.children);
        if (attrs.length) f.attributes = attrs;
        return f;
      }
      return complexObject(name, ct, parentName);
    }
    // No type at all: xsd:anyType; treat as string.
    return { kind: 'simple', type: 'STRTYPE' };
  }

  /** compile complexType content into an object def; returns field type info */
  function complexObject(elName, ct, parentName) {
    const fields = [];
    const ctx = { owner: elName, choiceIdx: 0 };
    for (const c of ct.children) {
      if (['sequence', 'choice', 'group', 'all'].includes(c.tag)) {
        walkParticle(c, fields, { min: 1, max: 1, path: [] }, ctx, elName);
      }
    }
    const attributes = attrDefs(ct.children);
    const obj = { name: elName, fields };
    if (attributes.length) obj.attributes = attributes;
    // Structure-key: identical structure under same name -> one object.
    const key = JSON.stringify({ f: fields, a: attributes });
    let objName = elName;
    const existing = structKeyByName.get(elName);
    if (existing !== undefined && existing !== key) {
      const shared = nameByStruct.get(key);
      if (shared) objName = shared;
      else {
        objName = `${parentName}.${elName}`;
        let i = 2;
        while (objects[objName] && structKeyByName.get(objName) !== key)
          objName = `${parentName}.${elName}${i++}`;
        stats.collisions++;
      }
    }
    if (!objects[objName]) {
      obj.name = objName;
      objects[objName] = obj;
      structKeyByName.set(objName, key);
      if (!nameByStruct.has(key)) nameByStruct.set(key, objName);
    }
    return { kind: 'complex', type: objName, children: objName };
  }

  const elementCache = new Map(); // global element name -> resolved type

  function walkParticle(node, fields, occ0, ctx, ownerName) {
    const min = occ(node.attrs.minOccurs) * occ0.min;
    const max = mulMax(occ(node.attrs.maxOccurs), occ0.max);
    const here = { min, max, path: occ0.path };
    switch (node.tag) {
      case 'sequence':
      case 'all':
        for (const c of node.children) walkParticle(c, fields, here, ctx, ownerName);
        return;
      case 'group': {
        const g = groups.get(node.attrs.ref);
        if (!g) throw new Error(`Unknown group ${node.attrs.ref}`);
        for (const c of g.children) walkParticle(c, fields, here, ctx, ownerName);
        return;
      }
      case 'choice': {
        const id = `c${++ctx.choiceIdx}`;
        node.children.forEach((c, branch) => {
          walkParticle(
            c,
            fields,
            { min, max, path: [...occ0.path, { group: id, branch }] },
            ctx,
            ownerName,
          );
        });
        return;
      }
      case 'element': {
        let resolved;
        let name;
        if (node.attrs.ref) {
          name = node.attrs.ref;
          resolved = elementCache.get(name);
          if (!resolved) {
            const g = elements.get(name);
            if (!g) throw new Error(`Unknown element ref ${name}`);
            resolved = resolveElementType(g, name);
            elementCache.set(name, resolved);
          }
        } else {
          name = node.attrs.name;
          resolved = resolveElementType(node, ownerName);
        }
        const f = { name, ...resolved, minOccurs: min, maxOccurs: max };
        if (node.attrs.default !== undefined) f.default = node.attrs.default;
        if (here.path.length) {
          const last = here.path[here.path.length - 1];
          f.choiceGroup = last.group;
          f.choiceBranch = last.branch;
          if (here.path.length > 1) f.choicePath = here.path.map((p) => `${p.group}:${p.branch}`);
        }
        // order keys predictably
        fields.push(orderField(f));
        return;
      }
      case 'any':
        return;
      default:
        return; // annotations etc.
    }
  }

  // ---- Message sets -> requests
  /** @type {Record<string, any>} */ const requests = {};
  const responseNames = new Set();
  const msgSets = [
    ['QBXMLMsgsRq', 'QBXMLMsgsRs'],
    ['QBXMLSubscriptionMsgsRq', 'QBXMLSubscriptionMsgsRs'],
  ];
  /** @type {Record<string, any>} */ const messageSets = {};
  for (const [rqSet, rsSet] of msgSets) {
    const rqEl = elements.get(rqSet);
    const rsEl = elements.get(rsSet);
    if (!rqEl || !rsEl) continue;
    const rqCt = rqEl.children.find((c) => c.tag === 'complexType');
    const rsCt = rsEl.children.find((c) => c.tag === 'complexType');
    messageSets[rqSet] = { name: rqSet, response: rsSet, attributes: attrDefs(rqCt.children) };
    const rsChoice = rsCt.children.find((c) => c.tag === 'choice');
    for (const rs of rsChoice.children) {
      if (rs.tag !== 'element') continue;
      resolveElementType(rs, rsSet);
      responseNames.add(rs.attrs.name);
    }
    const rqChoice = rqCt.children.find((c) => c.tag === 'choice');
    for (const rq of rqChoice.children) {
      if (rq.tag !== 'element') continue;
      const name = rq.attrs.name;
      resolveElementType(rq, rqSet);
      const rsName = name.replace(/Rq$/, 'Rs');
      requests[name] = { name, response: responseNames.has(rsName) ? rsName : '', msgSet: rqSet };
    }
  }

  // ---- Request metadata
  for (const rq of Object.values(requests)) {
    const obj = objects[rq.name];
    const rsObj = rq.response ? objects[rq.response] : undefined;
    const m = /(Add|Mod|Query|Del|Void)Rq$/.exec(rq.name);
    rq.op = m ? m[1] : 'Other';
    const attrs = obj.attributes ?? [];
    rq.supportsIterator = attrs.some((a) => a.name === 'iterator');
    rq.supportsMetaData = attrs.some((a) => a.name === 'metaData');
    const retFields = (rsObj?.fields ?? []).filter(
      (f) => f.kind === 'complex' && /Ret$/.test(f.name),
    );
    const retNames = [...new Set(retFields.map((f) => f.name))];
    if (retNames.length === 1) rq.retElement = retNames[0];
    if (retNames.length) rq.retElements = retNames;
    if (rq.op === 'Add' || rq.op === 'Mod') {
      const first = obj.fields[0];
      if (first && first.kind === 'complex') rq.bodyElement = first.name;
    }
    if (rq.retElement && !/Report/.test(rq.name)) {
      const ent = rq.retElement.replace(/Ret$/, '');
      if (rq.op === 'Add' || rq.op === 'Mod' || rq.op === 'Query') rq.entity = ent;
    }
    rq.filters =
      rq.op === 'Query'
        ? [...new Set(obj.fields.map((f) => f.name))].filter(
            (n) => !['IncludeRetElement', 'OwnerID', 'MaxReturned'].includes(n),
          )
        : [];
  }

  // ---- Entities
  const enumOf = (el) =>
    elementCache.get(el)?.enum ??
    (() => {
      const g = elements.get(el);
      return g ? resolveElementType(g, el).enum : undefined;
    })();
  const listDel = new Set(enumOf('ListDelType') ?? []);
  const txnDel = new Set(enumOf('TxnDelType') ?? []);
  const txnVoid = new Set(enumOf('TxnVoidType') ?? []);
  /** @type {Record<string, any>} */ const entities = {};
  const nonEntityRets = new Set(['ListDeletedRet', 'TxnDeletedRet', 'ReportRet', 'TransactionRet']);
  for (const rq of Object.values(requests)) {
    if (!rq.entity) continue;
    const name = rq.entity;
    const ret = `${name}Ret`;
    if (nonEntityRets.has(ret) || !objects[ret]) continue;
    if (!entities[name]) {
      const retObj = objects[ret];
      const top = retObj.fields.map((f) => f.name);
      const idField =
        top.includes('TxnID') &&
        (!top.includes('ListID') || top.indexOf('TxnID') < top.indexOf('ListID'))
          ? 'TxnID'
          : top.includes('ListID')
            ? 'ListID'
            : null;
      entities[name] = {
        name,
        category: idField === 'ListID' ? 'list' : idField === 'TxnID' ? 'txn' : 'other',
        idField,
        ops: {},
        retElement: ret,
        supportsModifiedFilter: false,
      };
    }
    const e = entities[name];
    // Several requests can return the same Ret (AccountAddRq and
    // SpecialAccountAddRq both answer AccountRet): the entity's own
    // <Entity><Op>Rq wins, whatever order the schema lists them in.
    const key = rq.op.toLowerCase();
    if (!e.ops[key] || rq.name === `${name}${rq.op}Rq`) e.ops[key] = rq.name;
  }
  // Entities returned by a union query (ItemQueryRq, TermsQueryRq, EntityQueryRq,
  // PayrollItemQueryRq) record it, so consumers can sync types that lack their own query.
  for (const rq of Object.values(requests)) {
    if (rq.op !== 'Query' || !rq.retElements || rq.retElements.length < 2) continue;
    for (const ret of rq.retElements) {
      const e = entities[ret.replace(/Ret$/, '')];
      if (e) e.unionQuery = rq.name;
    }
  }
  for (const e of Object.values(entities)) {
    if (e.ops.query) {
      const q = objects[e.ops.query];
      const names = q.fields.map((f) => f.name);
      if (names.includes('FromModifiedDate')) e.modifiedFilter = 'FromModifiedDate';
      else if (names.includes('ModifiedDateRangeFilter'))
        e.modifiedFilter = 'ModifiedDateRangeFilter';
      e.supportsModifiedFilter = Boolean(e.modifiedFilter);
      e.supportsIterator = requests[e.ops.query].supportsIterator;
    }
    if (e.category === 'list' && listDel.has(e.name)) {
      e.ops.del = 'ListDelRq';
      e.delType = e.name;
    } else if (e.category === 'txn' && txnDel.has(e.name)) {
      e.ops.del = 'TxnDelRq';
      e.delType = e.name;
    }
    if (e.category === 'txn' && txnVoid.has(e.name)) {
      e.ops.void = 'TxnVoidRq';
      e.voidType = e.name;
    }
    const retObj = objects[e.retElement];
    const top = new Set(retObj.fields.map((f) => f.name));
    if (top.has('EditSequence')) e.hasEditSequence = true;
    for (const k of [
      'Name',
      'FullName',
      'RefNumber',
      'TxnDate',
      'IsActive',
      'TimeCreated',
      'TimeModified',
    ]) {
      if (top.has(k)) (e.keyFields ??= []).push(k);
    }
  }

  return {
    version: SCHEMA_VERSION,
    messageSets,
    requests: sortObj(requests, orderRequest),
    objects: sortObj(objects),
    entities: sortObj(entities, orderEntity),
    stats: { ...stats },
  };
}

const FIELD_KEY_ORDER = [
  'name',
  'kind',
  'type',
  'minOccurs',
  'maxOccurs',
  'maxLength',
  'enum',
  'minInclusive',
  'maxInclusive',
  'default',
  'choiceGroup',
  'choiceBranch',
  'choicePath',
  'children',
  'attributes',
];
function orderField(f) {
  const out = {};
  for (const k of FIELD_KEY_ORDER) if (f[k] !== undefined) out[k] = f[k];
  return out;
}
const RQ_KEY_ORDER = [
  'name',
  'response',
  'op',
  'entity',
  'bodyElement',
  'retElement',
  'retElements',
  'supportsIterator',
  'supportsMetaData',
  'filters',
  'msgSet',
];
function orderRequest(r) {
  const out = {};
  for (const k of RQ_KEY_ORDER) if (r[k] !== undefined) out[k] = r[k];
  return out;
}
const ENT_KEY_ORDER = [
  'name',
  'category',
  'idField',
  'ops',
  'retElement',
  'supportsModifiedFilter',
  'modifiedFilter',
  'supportsIterator',
  'unionQuery',
  'delType',
  'voidType',
  'hasEditSequence',
  'keyFields',
];
function orderEntity(e) {
  const out = {};
  for (const k of ENT_KEY_ORDER) if (e[k] !== undefined) out[k] = e[k];
  return out;
}
function sortObj(o, map = (x) => x) {
  const out = {};
  for (const k of Object.keys(o).sort()) out[k] = map(o[k]);
  return out;
}

// ---------------------------------------------------------------------------
// types.ts

function tsIdent(name) {
  return name.replace(/[^A-Za-z0-9_$]/g, '_');
}
function tsString(s) {
  return JSON.stringify(s);
}

export function renderTypes(cat) {
  const L = [];
  L.push('// Generated by scripts/codegen.mjs from the qbXML XSD. Do not edit; do not commit.');
  L.push('/* eslint-disable */');
  L.push('');
  L.push('/** A simple qbXML value with attributes (xsd:simpleContent). */');
  L.push(
    "export type QbText = string | { '#text': string; [attr: `@${string}`]: string | undefined };",
  );
  L.push('');
  for (const obj of Object.values(cat.objects)) {
    const id = tsIdent(obj.name);
    L.push(`/** qbXML <${obj.name.split('.').pop()}> */`);
    L.push(`export interface ${id} {`);
    if (obj.attributes) {
      for (const a of obj.attributes) {
        const t = a.enum ? a.enum.map(tsString).join(' | ') : 'string';
        L.push(`  ${tsString('@' + a.name)}${a.required ? '' : '?'}: ${t};`);
      }
    }
    const seen = new Map();
    for (const f of obj.fields) {
      const prev = seen.get(f.name);
      const optional = f.minOccurs === 0 || f.choiceGroup !== undefined;
      const many = f.maxOccurs === 'unbounded' || f.maxOccurs > 1;
      let t;
      if (f.kind === 'complex') t = tsIdent(f.children);
      else if (f.enum) t = f.enum.map(tsString).join(' | ');
      else t = f.attributes ? 'QbText' : 'string';
      if (many) t = t.includes('|') ? `Array<${t}>` : `${t}[]`;
      if (prev) {
        // duplicate element name in different choice branches: merge
        if (!prev.types.includes(t)) prev.types.push(t);
        prev.optional = prev.optional || optional;
        continue;
      }
      seen.set(f.name, { types: [t], optional, maxLength: f.maxLength, type: f.type });
    }
    for (const [name, s] of seen) {
      const doc =
        s.maxLength !== undefined ? ` /** ${s.type}, max ${s.maxLength} */` : ` /** ${s.type} */`;
      L.push(`  ${doc.trim()}`);
      L.push(`  ${tsString(name)}${s.optional ? '?' : ''}: ${s.types.join(' | ')};`);
    }
    L.push('}');
    L.push('');
  }
  const rqNames = Object.keys(cat.requests);
  L.push(`export type RequestName = ${rqNames.map(tsString).join(' | ')};`);
  L.push('');
  const rsNames = [
    ...new Set(
      Object.values(cat.requests)
        .map((r) => r.response)
        .filter(Boolean),
    ),
  ];
  L.push(`export type ResponseName = ${rsNames.map(tsString).join(' | ')};`);
  L.push('');
  L.push(`export type EntityName = ${Object.keys(cat.entities).map(tsString).join(' | ')};`);
  L.push('');
  L.push('/** Request element name -> body (content of the Rq element). */');
  L.push('export interface RequestBodies {');
  for (const r of rqNames) L.push(`  ${tsString(r)}: ${tsIdent(r)};`);
  L.push('}');
  L.push('');
  L.push('/** Entity name -> Ret object type. */');
  L.push('export interface EntityRets {');
  for (const e of Object.values(cat.entities))
    L.push(`  ${tsString(e.name)}: ${tsIdent(e.retElement)};`);
  L.push('}');
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// CLI

function quickHash(dir) {
  // Hash of the raw files without parsing (for staleness checks).
  const h = createHash('sha256');
  h.update(readFileSync(fileURLToPath(import.meta.url)));
  for (const f of ['qbxmltypes170.xsd', 'QBUqbxml170.xsd', 'QBUqbxmlso170.xsd', ENTRY_XSD].sort()) {
    const p = path.join(dir, f);
    if (existsSync(p)) h.update(f).update(readFileSync(p));
  }
  return h.digest('hex');
}

export function generate({ dir = defaultSchemaDir(), out = outDir, log = console.log } = {}) {
  const t0 = Date.now();
  const files = readSchemaFiles(dir);
  const cat = compile(files);
  const { stats, ...catalog } = cat;
  const hash = quickHash(dir);
  catalog.sourceHash = hash;
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'catalog.json'), JSON.stringify(catalog, null, 1) + '\n');
  writeFileSync(path.join(out, 'types.ts'), renderTypes(catalog));
  writeFileSync(path.join(out, '.stamp'), hash + '\n');
  const counts = {
    requests: Object.keys(catalog.requests).length,
    objects: Object.keys(catalog.objects).length,
    entities: Object.keys(catalog.entities).length,
    listEntities: Object.values(catalog.entities).filter((e) => e.category === 'list').length,
    txnEntities: Object.values(catalog.entities).filter((e) => e.category === 'txn').length,
    queryRequests: Object.values(catalog.requests).filter((r) => r.op === 'Query').length,
    nameCollisions: stats.collisions,
  };
  log(
    `qbxml codegen: ${JSON.stringify(counts)} in ${Date.now() - t0}ms -> ${path.relative(process.cwd(), out) || out}`,
  );
  return { catalog, counts };
}

function isStale(dir) {
  const stamp = path.join(outDir, '.stamp');
  if (
    !existsSync(stamp) ||
    !existsSync(path.join(outDir, 'catalog.json')) ||
    !existsSync(path.join(outDir, 'types.ts'))
  )
    return true;
  return readFileSync(stamp, 'utf8').trim() !== quickHash(dir);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = new Set(process.argv.slice(2));
  const dir = defaultSchemaDir();
  try {
    if (args.has('--if-schemas') && !existsSync(path.join(dir, ENTRY_XSD))) {
      console.warn(
        `qbxml codegen skipped: ${path.join(dir, ENTRY_XSD)} not found. ` +
          'Copy the Intuit qbXML XSDs there (see docs/DESIGN.md §4) and run `npm run codegen`.',
      );
      process.exit(0);
    }
    const haveGenerated =
      existsSync(path.join(outDir, 'catalog.json')) && existsSync(path.join(outDir, 'types.ts'));
    if (args.has('--if-stale') && !existsSync(path.join(dir, ENTRY_XSD)) && haveGenerated) {
      console.warn(
        `qbxml codegen: ${path.join(dir, ENTRY_XSD)} not found; keeping existing generated/ output.`,
      );
      process.exit(0);
    }
    if ((args.has('--if-stale') || args.has('--if-schemas')) && !isStale(dir)) process.exit(0);
    generate({ dir });
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
