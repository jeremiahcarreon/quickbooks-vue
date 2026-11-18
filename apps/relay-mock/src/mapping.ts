// Turn Add/Mod request objects into Ret objects using the catalog, and fill
// any element the Ret schema requires.
import { minimalObject, sampleValue, type FieldDef, type ObjectDef } from '@qbv/qbxml';
import { childDef, choiceOf, field, isMany } from './qb.js';
import { arr, isObj, text, type Json } from './util.js';

/** Name of the Ret-side field for an Add/Mod-side element (InvoiceLineAdd -> InvoiceLineRet). */
export function retFieldFor(dst: ObjectDef, name: string): FieldDef | undefined {
  return (
    field(dst, name) ??
    field(dst, name.replace(/(Add|Mod)$/, 'Ret')) ??
    field(dst, name.replace(/(Add|Mod)$/, ''))
  );
}

/**
 * Copy every element of `input` (shaped by `src`) that has a counterpart in
 * `dst`. Elements without one (SetCredit, IsAutoApply, ...) are dropped;
 * request-only attributes (defMacro, useMacro) are removed.
 */
export function mapToRet(input: Json, src: ObjectDef | undefined, dst: ObjectDef): Json {
  const out: Json = {};
  for (const [key, v] of Object.entries(input)) {
    if (key.startsWith('@') || key === '#text' || v === undefined || v === null) continue;
    const df = retFieldFor(dst, key);
    if (!df) continue;
    const sf = src ? field(src, key) : undefined;
    if (df.kind === 'simple') {
      const vals = arr(v)
        .map(text)
        .filter((s): s is string => s !== undefined);
      if (vals.length === 0) continue;
      out[df.name] = isMany(df) ? vals : vals[0];
      continue;
    }
    const sdef = sf?.kind === 'complex' ? childDef(sf) : undefined;
    const ddef = childDef(df);
    const items = arr(v)
      .filter(isObj)
      .map((item) => mapToRet(item, sdef, ddef));
    if (items.length === 0) continue;
    out[df.name] = isMany(df) ? items : items[0];
  }
  return out;
}

/** Generator for required values; return undefined to fall back to a schema sample. */
export type RequiredValue = (f: FieldDef, owner: ObjectDef, o: Json) => unknown;

/**
 * Add every element the schema requires but `o` lacks (choosing, for an
 * unresolved choice, its first branch), recursively.
 */
export function fillRequired(o: Json, def: ObjectDef, gen: RequiredValue): Json {
  const chosen = new Map<string, string>();
  for (const f of def.fields) {
    if (f.name in o) for (const [g, b] of choiceOf(f)) chosen.set(g, b);
  }
  for (const f of def.fields) {
    if (f.minOccurs < 1 || f.name in o) continue;
    const path = choiceOf(f);
    if (path.some(([g, b]) => (chosen.has(g) ? chosen.get(g) !== b : b !== '0'))) continue;
    const one = (): unknown => {
      const v = gen(f, def, o);
      if (v !== undefined) return v;
      return f.kind === 'complex' ? minimalObject(f.children ?? f.type) : sampleValue(f);
    };
    o[f.name] = f.minOccurs > 1 ? Array.from({ length: f.minOccurs }, one) : one();
    for (const [g, b] of path) chosen.set(g, b);
  }
  for (const f of def.fields) {
    if (f.kind !== 'complex' || !(f.name in o)) continue;
    for (const item of arr(o[f.name])) if (isObj(item)) fillRequired(item, childDef(f), gen);
  }
  return o;
}

/** Truncate a string to a field's maxLength. */
export function fit(def: ObjectDef, name: string, value: string): string {
  const f = field(def, name);
  return f?.maxLength !== undefined ? value.slice(0, f.maxLength) : value;
}
