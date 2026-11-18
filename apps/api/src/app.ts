import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { QueryError } from '@qbv/db';
import { loadSchema, QbxmlValidationError } from '@qbv/qbxml';
import { QbxmlRejectedError } from '@qbv/queue';
import type { RouteContext } from './context.js';
import { authenticate, authorize, checkCsrf } from './lib/auth.js';
import { errorBody, HttpError, unauthorized } from './lib/errors.js';
import { RateLimiter } from './lib/rate-limit.js';
import {
  RequestValidationError,
  serializerCompiler,
  swaggerTransform,
  validatorCompiler,
} from './lib/zod.js';
import { actionRoutes } from './routes/actions.js';
import { adminRoutes } from './routes/admin.js';
import { adminSyncRoutes } from './routes/admin-sync.js';
import { authRoutes } from './routes/auth.js';
import { commandRoutes } from './routes/commands.js';
import { eventRoutes } from './routes/events.js';
import { healthRoutes } from './routes/health.js';
import { metaRoutes } from './routes/meta.js';
import { objectRoutes } from './routes/objects.js';
import { qbxmlRoutes } from './routes/qbxml.js';
import { loadReportsModule, reportRoutes } from './routes/reports.js';
import type { AppDeps, AppOptions } from './types.js';

export const API_PREFIX = '/api';
export const DOCS_PREFIX = '/api/docs';
/** Login attempts per client IP per minute. */
export const LOGIN_RATE_LIMIT = 10;

/** Routes registered by plugins, which cannot declare an access rule themselves. */
const UNGUARDED = [DOCS_PREFIX, `${API_PREFIX}/reports`];

/** Map any thrown error onto `{ error: { code, message, details? } }`. */
function toErrorResponse(err: unknown): { status: number; body: ReturnType<typeof errorBody> } {
  if (err instanceof HttpError) {
    return { status: err.statusCode, body: errorBody(err.code, err.message, err.details) };
  }
  if (err instanceof RequestValidationError) {
    return {
      status: 400,
      body: errorBody('validation_error', err.message, {
        in: err.validationContext ?? null,
        issues: err.issues,
      }),
    };
  }
  if (err instanceof QbxmlValidationError) {
    return {
      status: 400,
      body: errorBody('qbxml_invalid', err.message, { errors: err.errors }),
    };
  }
  if (err instanceof QbxmlRejectedError) {
    return { status: 400, body: errorBody('qbxml_invalid', err.message, { errors: err.errors }) };
  }
  if (err instanceof QueryError) {
    return { status: 400, body: errorBody('invalid_query', err.message) };
  }
  const e = err as FastifyError & { status?: number; details?: unknown };
  if (e?.validation) {
    return {
      status: 400,
      body: errorBody('validation_error', e.message, { in: e.validationContext ?? null }),
    };
  }
  const status = e?.statusCode ?? e?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    const code =
      typeof e.code === 'string' && !e.code.startsWith('FST_')
        ? e.code
        : status === 413
          ? 'payload_too_large'
          : status === 415
            ? 'unsupported_media_type'
            : 'bad_request';
    return { status, body: errorBody(code, e.message, e.details) };
  }
  if (
    typeof status === 'number' &&
    status >= 500 &&
    status < 600 &&
    typeof e.code === 'string' &&
    !e.code.startsWith('FST_')
  ) {
    return { status, body: errorBody(e.code, e.message, e.details) };
  }
  return { status: 500, body: errorBody('internal_error', 'Internal server error') };
}

/**
 * Build the Fastify app. The caller owns `deps` (database, Redis, queue,
 * event bus) and closes them after `app.close()`.
 */
export async function buildApp(deps: AppDeps, options: AppOptions = {}): Promise<FastifyInstance> {
  const { config } = deps;
  const ctx: RouteContext = {
    deps,
    opts: {
      sseHeartbeatMs: options.sseHeartbeatMs ?? 15_000,
      reports: options.reports ?? 'auto',
    },
    limiter: new RateLimiter(deps.redis, {
      limits: {
        write: config.RATE_LIMIT_WRITES_PER_MIN,
        qbxml: config.RATE_LIMIT_QBXML_PER_MIN,
        login: LOGIN_RATE_LIMIT,
      },
      windowMs: 60_000,
      prefix: `${config.QUEUE_PREFIX}:ratelimit:`,
    }),
    relayState: { connected: null, at: null, error: null },
  };

  // Fail fast when the XSDs are missing: nothing can be validated without them.
  await loadSchema();

  const app = Fastify({
    ...(deps.logger && options.logger !== false
      ? { loggerInstance: deps.logger }
      : { logger: false }),
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
    genReqId: () => randomUUID(),
    routerOptions: { ignoreTrailingSlash: true },
  }) as unknown as FastifyInstance;

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('principal', null);

  app.addContentTypeParser(
    ['application/xml', 'text/xml'],
    { parseAs: 'string' },
    (_req, body, done) => done(null, body),
  );
  // Many HTTP clients send `Content-Type: application/json` on DELETE or on a
  // bodiless POST (void); treat an empty JSON body as no body instead of a 400.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(text) as unknown);
    } catch {
      const err = new Error('Body is not valid JSON') as Error & { statusCode?: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  await app.register(cookie, { secret: config.SESSION_SECRET, hook: 'onRequest' });
  if (config.CORS_ORIGINS.length) {
    const allowed = new Set([...config.CORS_ORIGINS, new URL(config.PUBLIC_URL).origin]);
    await app.register(cors, {
      origin: (origin, cb) => cb(null, !origin || allowed.has(origin)),
      credentials: true,
      exposedHeaders: ['x-command-id', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'retry-after'],
    });
  }

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'QuickBooks Vue API',
        version: '0.1.0',
        description:
          'Reads come from the Postgres read model; writes are queued as commands and sent to QuickBooks one at a time. ' +
          'Every qbXML document is validated against the Intuit XSD before it is queued.',
      },
      components: {
        securitySchemes: {
          bearer: {
            type: 'http',
            scheme: 'bearer',
            description: 'API token (Authorization: Bearer qbv_...)',
          },
          session: { type: 'apiKey', in: 'cookie', name: 'qbv_session' },
        },
      },
      security: [{ bearer: [] }, { session: [] }],
    },
    transform: swaggerTransform,
  });
  await app.register(swaggerUi, { routePrefix: DOCS_PREFIX });

  app.setErrorHandler((err, req, reply) => {
    const { status, body } = toErrorResponse(err);
    if (status >= 500) req.log.error({ err }, 'request failed');
    void reply.code(status).send(body);
  });
  app.setNotFoundHandler((req, reply) => {
    void reply.code(404).send(errorBody('not_found', `Route ${req.method} ${req.url} not found`));
  });

  // Every API route must say who may call it.
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith(`${API_PREFIX}/`)) return;
    if (UNGUARDED.some((p) => route.url.startsWith(p))) return;
    const c = route.config ?? {};
    if (!c.public && !c.permission && !c.authenticated) {
      throw new Error(`Route ${String(route.method)} ${route.url} declares no access rule`);
    }
  });

  app.addHook('onRequest', async (req, reply) => {
    const url = req.routeOptions.url;
    if (!url) return;
    if (url.startsWith(DOCS_PREFIX)) {
      // The OpenAPI spec and UI describe the whole API surface: signed-in
      // users and API tokens only. The docs plugin keeps Fastify's default
      // error format, so answer in ours directly.
      try {
        req.principal = await authenticate(deps, req);
        if (!req.principal) throw unauthorized();
      } catch (err) {
        const { status, body } = toErrorResponse(err);
        return reply.code(status).send(body);
      }
      return;
    }
    const cfg = req.routeOptions.config;
    if (cfg.public) return;
    req.principal = await authenticate(deps, req);
    if (!req.principal) throw unauthorized();
    checkCsrf(req, req.principal);
    if (cfg.permission) {
      authorize(req, typeof cfg.permission === 'function' ? cfg.permission(req) : cfg.permission);
    }
  });

  app.addHook('preHandler', async (req, reply) => {
    const bucket = req.routeOptions.config?.rateLimit;
    if (bucket) await ctx.limiter.hit(bucket, req, reply);
  });

  // Without a relay client, /health reports the last relay.health event the worker published.
  if (!deps.relay) {
    let unsub: (() => void) | undefined;
    app.addHook('onReady', async () => {
      unsub = await deps.events
        .subscribe((e) => {
          if (e.type !== 'relay.health') return;
          ctx.relayState.connected = e.connected;
          ctx.relayState.at = new Date();
          ctx.relayState.error = e.error ?? null;
        })
        .catch((err: Error) => {
          app.log.warn({ err }, 'could not subscribe to relay health events');
          return undefined;
        });
    });
    app.addHook('onClose', async () => unsub?.());
  }

  const register = ctx.opts.reports === 'auto' ? await loadReportsModule(app.log) : undefined;

  await app.register(
    async (api) => {
      await healthRoutes(api, ctx);
      await authRoutes(api, ctx);
      await metaRoutes(api, ctx);
      await objectRoutes(api, ctx);
      await actionRoutes(api, ctx);
      await commandRoutes(api, ctx);
      await qbxmlRoutes(api, ctx);
      await eventRoutes(api, ctx);
      await adminRoutes(api, ctx);
      await adminSyncRoutes(api, ctx);
      await api.register(async (scope) => {
        const state = await reportRoutes(scope, ctx, register);
        app.log.info({ reports: state }, 'reports');
      });
    },
    { prefix: API_PREFIX },
  );

  return app;
}
