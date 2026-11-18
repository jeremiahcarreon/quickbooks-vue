import { z } from './zod.js';

/** `true|false|1|0` query flag. */
export const zFlag = z
  .enum(['true', 'false', '1', '0', ''])
  .transform((v) => v === 'true' || v === '1')
  .optional();

export const WaitQuery = z.object({ wait: zFlag });

/** Collect `filter[Field]=value` keys from a flat query object. */
export function filterParams(query: Record<string, unknown>): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(query)) {
    const m = /^filter\[(.+)\]$/.exec(k);
    if (!m) continue;
    for (const one of Array.isArray(v) ? v : [v]) {
      if (typeof one === 'string') out.push([m[1]!, one]);
    }
  }
  return out;
}
