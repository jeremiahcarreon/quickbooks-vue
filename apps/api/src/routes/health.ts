import type { FastifyInstance } from 'fastify';
import { sql } from '@qbv/db';
import { typed, type RouteContext } from '../context.js';

async function timed<T>(fn: () => Promise<T>, timeoutMs = 3000) {
  const started = performance.now();
  try {
    await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs).unref()),
    ]);
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      error: (err as Error).message,
    };
  }
}

const RELAY_CACHE_MS = 10_000;

export async function healthRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const r = typed(app);
  const { deps } = ctx;
  let relayCache: { at: number; value: unknown } | undefined;

  async function relayStatus() {
    if (deps.relay) {
      if (relayCache && Date.now() - relayCache.at < RELAY_CACHE_MS) return relayCache.value;
      const ping = await deps.relay.ping();
      const value = { source: 'relay', ...ping };
      relayCache = { at: Date.now(), value };
      return value;
    }
    const s = ctx.relayState;
    return {
      source: 'events',
      connected: s.connected,
      at: s.at ? s.at.toISOString() : null,
      error: s.error,
    };
  }

  r.get(
    '/health',
    {
      config: { public: true },
      schema: {
        tags: ['health'],
        summary: 'api, database, Redis and relay status (503 when the database or Redis is down)',
      },
    },
    async (_req, reply) => {
      const [db, redis, relay] = await Promise.all([
        timed(() => sql`select 1`.execute(deps.db)),
        timed(() => deps.redis.ping()),
        relayStatus().catch((err: Error) => ({ connected: false, error: err.message })),
      ]);
      const ok = db.ok && redis.ok;
      return reply.code(ok ? 200 : 503).send({
        status: ok ? 'ok' : 'degraded',
        api: { ok: true, uptimeSec: Math.round(process.uptime()) },
        db,
        redis,
        relay,
      });
    },
  );
}
