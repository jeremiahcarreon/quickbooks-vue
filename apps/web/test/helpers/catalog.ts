/**
 * Test helpers backed by the real catalog generated from the Intuit XSDs
 * (@qbv/qbxml). Form bodies built by the web form model are turned into
 * qbXML with buildRequest, which validates against the XSD with libxml2.
 */
import { loadCatalog } from '@qbv/qbxml';
import type { EntityDef, ObjectDef } from '@/api/types';
import {
  activeFields,
  describeObject,
  type FormContext,
  type FormField,
  type FormValue,
  type LayoutItem,
  selectBranch,
  selectedBranch,
  initialValue,
  isEmptyValue,
} from '@/forms/model';

export const catalog = loadCatalog();
export const objects = catalog.objects as unknown as Record<string, ObjectDef>;
export const entities = catalog.entities as unknown as Record<string, EntityDef>;
export const entityNames = Object.keys(entities);

export function ctxFor(owner?: string): FormContext {
  return { objects, entityNames, ...(owner ? { owner } : {}) };
}

/** Body element of an Add/Mod request (follows the request definition). */
export function bodyElementOf(rq: string): string {
  const r = catalog.requests[rq];
  if (!r?.bodyElement) throw new Error(`No body element for ${rq}`);
  return r.bodyElement;
}

function sampleSimple(f: FormField): string {
  const d = f.def;
  if (d.enum?.length) return d.enum[0]!;
  switch (f.kind) {
    case 'money':
      return f.numberKind === 'amount' ? '10.00' : '2.5';
    case 'number':
      if (f.numberKind === 'integer') {
        const lo = d.minInclusive ?? 1;
        return String(Math.max(lo, Math.min(d.maxInclusive ?? 1, 1)));
      }
      return '1';
    case 'date':
      return '2026-01-15';
    case 'datetime':
      return '2026-01-15T10:00:00';
    case 'bool':
      return 'true';
    case 'id':
      return '80000001-1700000000';
    case 'guid':
      return '{12345678-1234-1234-1234-123456789012}';
    case 'duration':
      return 'PT1H30M';
    default: {
      const s = 'Sample';
      return d.maxLength !== undefined ? s.slice(0, Math.max(1, d.maxLength)) : s;
    }
  }
}

/**
 * Fill every required field of a form value the way a user would through the
 * generated form: text inputs typed, refs picked, required choices chosen,
 * one line added to required line editors.
 */
export function fillRequired(
  name: string,
  value: FormValue,
  ctx: FormContext,
  depth = 0,
): FormValue {
  const form = describeObject(name, ctx);
  const walk = (items: LayoutItem[]) => {
    for (const it of items) {
      if (it.type === 'choice') {
        let b = selectedBranch(it, value);
        if (b < 0 && it.required) {
          b = it.branches[0]!.index;
          selectBranch(value, it.id, b);
        }
        const br = it.branches.find((x) => x.index === b);
        if (br) walk(br.items);
        continue;
      }
      const f = it.field;
      if (!f.required || f.hidden) continue;
      fillField(f, value, ctx, depth);
    }
  };
  walk(form.layout);
  for (const g of form.anyOf) {
    if (g.required && g.fields.every((n) => !((value[n] as unknown[]) ?? []).length)) {
      const f = form.fields.find((x) => x.name === g.fields[0])!;
      fillField(f, value, ctx, depth);
    }
  }
  if (isEmptyValue(value)) fillSomething(name, value, ctx, depth);
  return value;
}

/** A user never submits an empty object: type into the first plain input. */
function fillSomething(name: string, value: FormValue, ctx: FormContext, depth: number) {
  const fields = activeFields(describeObject(name, ctx), value).filter((f) => !f.hidden);
  const simple = fields.find((f) => !['object', 'lines', 'list'].includes(f.kind));
  if (simple) return fillField(simple, value, ctx, depth);
  const nested = fields.find((f) => f.kind === 'object' || f.kind === 'lines');
  if (nested && depth < 6) fillField(nested, value, ctx, depth);
}

function fillField(f: FormField, value: FormValue, ctx: FormContext, depth: number) {
  switch (f.kind) {
    case 'ref':
      value[f.name] = { FullName: 'Sample' };
      break;
    case 'object':
      value[f.name] = fillRequired(
        f.child!,
        (value[f.name] as FormValue) ?? initialValue(f.child!, ctx),
        ctx,
        depth + 1,
      );
      break;
    case 'lines':
      value[f.name] = [fillRequired(f.child!, initialValue(f.child!, ctx), ctx, depth + 1)];
      break;
    case 'list':
      value[f.name] = [sampleSimple(f)];
      break;
    default:
      value[f.name] = sampleSimple(f);
  }
}

export { activeFields };
