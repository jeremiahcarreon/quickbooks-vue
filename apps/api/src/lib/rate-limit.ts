import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import type { RateBucket } from '../types.js';
import { HttpError } from './errors.js';

export interface RateLimitSettings {
  /** Requests per window for each bucket. */
  limits: Record<RateBucket, number>;
  windowMs: number;
  prefix: string;
}

// INCR and set the expiry on first hit; returns [count, ttl ms].
const SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {n, ttl}`;

/**
 * Fixed-window limiter in Redis, shared by every api instance. Writes and raw
 * qbXML are limited per user/token (one bucket across all write routes);
 * login is limited per client IP.
 */
export class RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly settings: RateLimitSettings,
  ) {}

  keyFor(bucket: RateBucket, req: FastifyRequest): string {
    const who =
      bucket === 'login' || !req.principal
        ? `ip:${req.ip}`
        : `${req.principal.type}:${req.principal.id}`;
    return `${this.settings.prefix}${bucket}:${who}`;
  }

  async hit(bucket: RateBucket, req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const max = this.settings.limits[bucket];
    const key = this.keyFor(bucket, req);
    const res = (await this.redis.eval(SCRIPT, 1, key, String(this.settings.windowMs))) as [
      number,
      number,
    ];
    const [count, ttl] = res;
    const resetSec = Math.max(1, Math.ceil(ttl / 1000));
    reply.header('x-ratelimit-limit', max);
    reply.header('x-ratelimit-remaining', Math.max(0, max - count));
    reply.header('x-ratelimit-reset', resetSec);
    if (count > max) {
      reply.header('retry-after', resetSec);
      throw new HttpError(429, 'rate_limited', `Rate limit exceeded; retry in ${resetSec}s`, {
        bucket,
        limit: max,
        retryAfter: resetSec,
      });
    }
  }
}
