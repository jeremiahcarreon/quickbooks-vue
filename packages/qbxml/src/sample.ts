// Minimal schema-valid sample values, derived from the catalog. Useful for
// tests and test doubles that need a valid object of any qbXML type.
import { getObject, getRequest, type FieldDef } from './catalog.js';

const GUID = '{6B063959-81B0-4B9A-8E9B-1234567890AB}';

/** A schema-valid sample value for a simple field. */
export function sampleValue(
  field: Pick<FieldDef, 'type' | 'enum' | 'maxLength' | 'minInclusive' | 'maxInclusive' | 'name'>,
): string {
  if (field.enum && field.enum.length) return field.enum[0]!;
  switch (field.type) {
    case 'IDTYPE':
      return '80000001-1234567890';
    case 'BOOLTYPE':
      return 'true';
    case 'DATETYPE':
      return '2024-01-15';
    case 'DATETIMETYPE':
      return '2024-01-15T10:20:30-08:00';
    case 'TIMEINTERVALTYPE':
      return 'PT1H30M';
    case 'AMTTYPE':
      return '10.00';
    case 'PRICETYPE':
    case 'QUANTYPE':
    case 'PERCENTTYPE':
      return '1';
    case 'FLOATTYPE':
      return '1.5';
    case 'INTTYPE': {
      let n = 1;
      if (field.minInclusive !== undefined && n < field.minInclusive) n = field.minInclusive;
      if (field.maxInclusive !== undefined && n > field.maxInclusive) n = field.maxInclusive;
      return String(n);
    }
    case 'GUIDTYPE':
    case 'UUIDTYPE':
      return GUID;
    case 'MACROTYPE':
      return 'TxnID:1';
    default: {
      const s = `Sample ${field.name}`;
      return field.maxLength !== undefined ? s.slice(0, Math.max(1, field.maxLength)) : s;
    }
  }
}

function inFirstBranches(f: FieldDef): boolean {
  if (f.choicePath) return f.choicePath.every((p) => p.endsWith(':0'));
  return f.choiceGroup === undefined || f.choiceBranch === 0;
}

/**
 * The smallest valid content for an object: every required field (taking the
 * first branch of each required choice), recursively.
 */
export function minimalObject(objectName: string, depth = 0): Record<string, unknown> {
  if (depth > 25) throw new Error(`minimalObject: recursion too deep at ${objectName}`);
  const obj = getObject(objectName);
  const out: Record<string, unknown> = {};
  for (const f of obj.fields) {
    if (f.minOccurs < 1 || !inFirstBranches(f) || f.name in out) continue;
    const one = (): unknown =>
      f.kind === 'complex' ? minimalObject(f.children ?? f.type, depth + 1) : sampleValue(f);
    out[f.name] = f.minOccurs > 1 ? Array.from({ length: f.minOccurs }, one) : one();
  }
  for (const a of obj.attributes ?? []) {
    if (a.required && depth > 0) out[`@${a.name}`] = sampleValue({ ...a, name: a.name });
  }
  return out;
}

/** Minimal valid content of a request element (e.g. CustomerQueryRq -> {}). */
export function minimalRequestBody(rq: string): Record<string, unknown> {
  return minimalObject(getRequest(rq).name);
}
