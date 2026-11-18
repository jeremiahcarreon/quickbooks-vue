import type { FastifyRequest } from 'fastify';
import type { ApiConfig, Logger } from '@qbv/config';
import type { Db } from '@qbv/db';
import type { EventBus, RelayQueue } from '@qbv/queue';
import type { RelayClient } from '@qbv/relay-client';
import type { Redis } from 'ioredis';

/** Who is calling: a browser session user or an API token. */
export type Principal =
  | {
      type: 'user';
      id: string;
      email: string;
      displayName: string;
      permissions: string[];
      sessionId: string;
      csrfToken: string | null;
      expiresAt: Date;
    }
  | {
      type: 'token';
      id: string;
      name: string;
      permissions: string[];
      createdBy: string | null;
    };

/** A permission string, or one computed from the request (e.g. from `:type`). */
export type PermissionSpec = string | ((req: FastifyRequest) => string);

export type RateBucket = 'write' | 'qbxml' | 'login';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
  interface FastifyContextConfig {
    /** No authentication required (login, health). */
    public?: boolean;
    /** Required permission. Routes without `public`, `permission` or `authenticated` refuse to register. */
    permission?: PermissionSpec;
    /** Any authenticated principal may call it (the handler narrows further). */
    authenticated?: boolean;
    /** Rate-limit bucket applied before the handler. */
    rateLimit?: RateBucket;
  }
}

export interface AppDeps {
  config: ApiConfig;
  db: Db;
  /** General-purpose connection (rate limits, pub/sub publish). */
  redis: Redis;
  queue: RelayQueue;
  events: EventBus;
  /** Present when RELAY_URL is configured; used for /health only. */
  relay?: RelayClient;
  logger?: Logger;
}

export interface AppOptions {
  /** SSE heartbeat interval (ms). Default 15000. */
  sseHeartbeatMs?: number;
  /** Skip mounting @qbv/reports (tests). */
  reports?: 'auto' | 'disabled';
  /** Fastify logger (default: deps.logger or disabled). */
  logger?: boolean;
}
