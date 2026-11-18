import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Base simple types declared in qbxmltypes170.xsd. */
export type QbBaseType =
  | 'IDTYPE'
  | 'STRTYPE'
  | 'BOOLTYPE'
  | 'DATETYPE'
  | 'DATETIMETYPE'
  | 'TIMEINTERVALTYPE'
  | 'AMTTYPE'
  | 'PRICETYPE'
  | 'QUANTYPE'
  | 'PERCENTTYPE'
  | 'ENUMTYPE'
  | 'INTTYPE'
  | 'GUIDTYPE'
  | 'UUIDTYPE'
  | 'MACROTYPE'
  | 'FLOATTYPE';

export interface AttributeDef {
  name: string;
  type: string;
  required: boolean;
  maxLength?: number;
  enum?: string[];
  default?: string;
}

export interface FieldDef {
  name: string;
  kind: 'simple' | 'complex';
  /** Base XSD type (STRTYPE, AMTTYPE, ...) for simple fields; the ObjectDef name for complex ones. */
  type: string;
  minOccurs: number;
  maxOccurs: number | 'unbounded';
  maxLength?: number;
  enum?: string[];
  minInclusive?: number;
  maxInclusive?: number;
  default?: string;
  /** Id of the innermost xsd:choice this field belongs to (unique within the object). */
  choiceGroup?: string;
  /** Index of the choice branch this field belongs to. */
  choiceBranch?: number;
  /** Full choice path ("c1:0", "c2:1", ...) when choices are nested. */
  choicePath?: string[];
  /** ObjectDef name for complex fields. */
  children?: string;
  /** XML attributes of a simple field with attributes (xsd:simpleContent), e.g. useMacro. */
  attributes?: AttributeDef[];
}

export interface ObjectDef {
  name: string;
  /** Flattened content model, in schema (sequence) order. */
  fields: FieldDef[];
  attributes?: AttributeDef[];
}

export type RequestOp = 'Add' | 'Mod' | 'Query' | 'Del' | 'Void' | 'Other';

export interface RequestDef {
  name: string;
  response: string;
  op: RequestOp;
  entity?: string;
  /** For Add/Mod: the wrapped object element, e.g. CustomerAdd. */
  bodyElement?: string;
  /** The Ret element when the response returns exactly one kind. */
  retElement?: string;
  /** All Ret elements the response may contain (union queries return several). */
  retElements?: string[];
  supportsIterator: boolean;
  supportsMetaData?: boolean;
  /** Top-level query filter elements. */
  filters: string[];
  /** Message set the request belongs to. */
  msgSet: 'QBXMLMsgsRq' | 'QBXMLSubscriptionMsgsRq';
}

export interface EntityDef {
  name: string;
  category: 'list' | 'txn' | 'other';
  idField: 'ListID' | 'TxnID' | null;
  ops: { add?: string; mod?: string; query?: string; del?: string; void?: string };
  retElement: string;
  supportsModifiedFilter: boolean;
  /** How the query filters by modification time. */
  modifiedFilter?: 'FromModifiedDate' | 'ModifiedDateRangeFilter';
  supportsIterator?: boolean;
  /** Union query that also returns this entity (ItemQueryRq, TermsQueryRq, ...). */
  unionQuery?: string;
  /** ListDelType / TxnDelType value. */
  delType?: string;
  /** TxnVoidType value. */
  voidType?: string;
  hasEditSequence?: boolean;
  keyFields?: string[];
}

export interface MessageSetDef {
  name: string;
  response: string;
  attributes: AttributeDef[];
}

export interface Catalog {
  version: string;
  sourceHash?: string;
  messageSets: Record<string, MessageSetDef>;
  requests: Record<string, RequestDef>;
  objects: Record<string, ObjectDef>;
  entities: Record<string, EntityDef>;
}

/** Root directory of this package (contains package.json and generated/). */
export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pj = path.join(dir, 'package.json');
    if (existsSync(pj)) {
      try {
        const name = (JSON.parse(readFileSync(pj, 'utf8')) as { name?: string }).name;
        if (name === '@qbv/qbxml') return dir;
      } catch {
        // keep walking
      }
    }
    const up = path.dirname(dir);
    if (up === dir) throw new Error('Cannot locate the @qbv/qbxml package root');
    dir = up;
  }
}

export function catalogPath(): string {
  return path.join(packageRoot(), 'generated', 'catalog.json');
}

let loaded: Catalog | undefined;

/** Load (and cache) generated/catalog.json. Throws a clear message when codegen has not run. */
export function loadCatalog(file?: string): Catalog {
  if (loaded && !file) return loaded;
  const p = file ?? catalogPath();
  if (!existsSync(p)) {
    throw new Error(
      `qbXML catalog not found at ${p}. Copy the Intuit qbXML XSDs into schemas/qbxml/17.0 ` +
        '(or set QBXML_SCHEMA_DIR) and run `npm run codegen` (see docs/DESIGN.md §4).',
    );
  }
  const cat = JSON.parse(readFileSync(p, 'utf8')) as Catalog;
  if (!file) loaded = cat;
  return cat;
}

/**
 * The catalog generated from the XSD. Properties load lazily on first access so
 * importing this package never fails before codegen has run.
 */
export const catalog: Catalog = {
  get version() {
    return loadCatalog().version;
  },
  get sourceHash() {
    return loadCatalog().sourceHash;
  },
  get messageSets() {
    return loadCatalog().messageSets;
  },
  get requests() {
    return loadCatalog().requests;
  },
  get objects() {
    return loadCatalog().objects;
  },
  get entities() {
    return loadCatalog().entities;
  },
};

export function getRequest(name: string): RequestDef {
  const r = loadCatalog().requests[name];
  if (!r) {
    const hint = suggest(name, Object.keys(loadCatalog().requests));
    throw new Error(`Unknown qbXML request "${name}"${hint ? `; did you mean ${hint}?` : ''}`);
  }
  return r;
}

export function getObject(name: string): ObjectDef {
  const o = loadCatalog().objects[name];
  if (!o) throw new Error(`Unknown qbXML object "${name}"`);
  return o;
}

export function getEntity(name: string): EntityDef {
  const e = loadCatalog().entities[name];
  if (!e) {
    const hint = suggest(name, Object.keys(loadCatalog().entities));
    throw new Error(`Unknown qbXML entity "${name}"${hint ? `; did you mean ${hint}?` : ''}`);
  }
  return e;
}

/** Entity for a Ret element name (CustomerRet -> Customer), if it is a known entity. */
export function entityForRet(retName: string): EntityDef | undefined {
  const e = loadCatalog().entities[retName.replace(/Ret$/, '')];
  return e && e.retElement === retName ? e : undefined;
}

/** Up to three close matches, formatted for an error message. */
export function suggest(name: string, candidates: string[]): string {
  const lower = name.toLowerCase();
  const scored = candidates
    .map((c) => ({ c, d: c.toLowerCase() === lower ? 0 : distance(lower, c.toLowerCase()) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(name.length / 4)))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3);
  return scored.map((x) => `"${x.c}"`).join(' or ');
}

function distance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n] ?? 0;
}
