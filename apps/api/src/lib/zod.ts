import type {
  FastifySchema,
  FastifySchemaCompiler,
  FastifySerializerCompiler,
  FastifyTypeProvider,
} from 'fastify';
import { z } from 'zod/v4';

/**
 * Fastify type provider for Zod (v4 API) schemas. Route `schema.body`,
 * `querystring`, `params` and `headers` are Zod schemas; handlers receive the
 * parsed output types.
 */
export interface ZodTypeProvider extends FastifyTypeProvider {
  validator: this['schema'] extends z.ZodType ? z.output<this['schema']> : unknown;
  serializer: this['schema'] extends z.ZodType ? z.input<this['schema']> : unknown;
}

export interface ValidationIssueView {
  path: string;
  message: string;
  code: string;
}

/** Request validation failure (400). Fastify attaches `validationContext`. */
export class RequestValidationError extends Error {
  readonly statusCode = 400;
  readonly issues: ValidationIssueView[];
  validationContext?: string;
  constructor(issues: ValidationIssueView[]) {
    super(issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; '));
    this.name = 'RequestValidationError';
    this.issues = issues;
  }
}

export function issuesOf(err: z.ZodError): ValidationIssueView[] {
  return err.issues.map((i) => ({
    path: i.path.map(String).join('.'),
    message: i.message,
    code: i.code,
  }));
}

const isZod = (s: unknown): s is z.ZodType =>
  !!s && typeof s === 'object' && typeof (s as z.ZodType).safeParse === 'function';

export const validatorCompiler: FastifySchemaCompiler<unknown> = ({ schema }) => {
  if (!isZod(schema)) return (data) => ({ value: data });
  return (data) => {
    const r = schema.safeParse(data);
    return r.success ? { value: r.data } : { error: new RequestValidationError(issuesOf(r.error)) };
  };
};

/** Responses are plain JSON; schemas there are for documentation only. */
export const serializerCompiler: FastifySerializerCompiler<unknown> = () => (data) =>
  JSON.stringify(data);

function toJson(s: unknown, io: 'input' | 'output'): unknown {
  if (!isZod(s)) return s;
  try {
    const out = z.toJSONSchema(s, { io, unrepresentable: 'any' }) as Record<string, unknown>;
    delete out.$schema;
    return out;
  } catch {
    return {};
  }
}

/** @fastify/swagger transform: convert Zod route schemas to JSON Schema. */
export function swaggerTransform({ schema, url }: { schema: FastifySchema; url: string }) {
  if (!schema) return { schema, url };
  const out: Record<string, unknown> = { ...schema };
  for (const key of ['body', 'querystring', 'params', 'headers'] as const) {
    if (schema[key]) out[key] = toJson(schema[key], 'input');
  }
  if (schema.response && typeof schema.response === 'object') {
    const res: Record<string, unknown> = {};
    for (const [code, s] of Object.entries(schema.response as Record<string, unknown>)) {
      res[code] = toJson(s, 'output');
    }
    out.response = res;
  }
  return { schema: out as FastifySchema, url };
}

export { z };
