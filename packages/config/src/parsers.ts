import { z } from 'zod';

const DURATION_RE = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/i;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Parse a duration such as `500ms`, `60s`, `5m`, `1h`, `1d` into milliseconds.
 * A bare number uses `defaultUnit` (milliseconds unless told otherwise).
 */
export function parseDuration(
  input: string | number,
  defaultUnit: keyof typeof UNIT_MS = 'ms',
): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw new Error(`Invalid duration: ${input}`);
    return Math.round(input * UNIT_MS[defaultUnit]!);
  }
  const m = DURATION_RE.exec(input);
  if (!m) throw new Error(`Invalid duration "${input}" (use e.g. 500ms, 60s, 5m, 1h)`);
  const unit = (m[2] ?? defaultUnit).toLowerCase();
  return Math.round(Number(m[1]) * UNIT_MS[unit]!);
}

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const FALSE = new Set(['0', 'false', 'no', 'off', '']);

/** Parse a boolean env value (`true/false/1/0/yes/no/on/off`). */
export function parseBool(input: string | boolean): boolean {
  if (typeof input === 'boolean') return input;
  const v = input.trim().toLowerCase();
  if (TRUE.has(v)) return true;
  if (FALSE.has(v)) return false;
  throw new Error(`Invalid boolean "${input}"`);
}

/** Zod: duration in ms. A bare number is read in `defaultUnit`. */
export const zDuration = (def: string, defaultUnit: keyof typeof UNIT_MS = 'ms') =>
  z
    .union([z.string(), z.number()])
    .default(def)
    .transform((v, ctx) => {
      try {
        return parseDuration(v, defaultUnit);
      } catch (err) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: (err as Error).message });
        return z.NEVER;
      }
    });

/** Zod: boolean from env text. */
export const zBool = (def: boolean) =>
  z
    .union([z.string(), z.boolean()])
    .default(def)
    .transform((v, ctx) => {
      try {
        return parseBool(v);
      } catch (err) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: (err as Error).message });
        return z.NEVER;
      }
    });

/** Zod: integer from env text. */
export const zInt = (def: number, opts: { min?: number; max?: number } = {}) => {
  let s = z.coerce.number().int();
  if (opts.min !== undefined) s = s.min(opts.min);
  if (opts.max !== undefined) s = s.max(opts.max);
  return s.default(def);
};

/** Zod: comma separated list, trimmed, empties dropped. */
export const zList = (def = '') =>
  z
    .string()
    .default(def)
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );

/** Zod: URL restricted to the given protocols. */
export const zUrl = (protocols: string[]) =>
  z
    .string()
    .trim()
    .url()
    .refine((v) => protocols.includes(new URL(v).protocol.replace(/:$/, '')), {
      message: `must use one of: ${protocols.join(', ')}`,
    });
