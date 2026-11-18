import type { FastifyInstance } from 'fastify';
import type { RateLimiter } from './lib/rate-limit.js';
import type { ZodTypeProvider } from './lib/zod.js';
import type { AppDeps, AppOptions } from './types.js';

export interface RouteContext {
  deps: AppDeps;
  opts: Required<Omit<AppOptions, 'logger'>>;
  limiter: RateLimiter;
  /** Last relay.health event seen on the bus (when no relay client is configured). */
  relayState: { connected: boolean | null; at: Date | null; error: string | null };
}

export type App = FastifyInstance;

export function typed(app: FastifyInstance) {
  return app.withTypeProvider<ZodTypeProvider>();
}
