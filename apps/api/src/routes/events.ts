import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { hasPermission } from '@qbv/db';
import type { QbvEvent } from '@qbv/queue';
import { typed, type RouteContext } from '../context.js';
import { requirePrincipal } from '../lib/auth.js';
import type { Principal } from '../types.js';

/** Whether a principal may receive an event. */
export function canSeeEvent(p: Principal, e: QbvEvent): boolean {
  switch (e.type) {
    case 'object.changed':
    case 'sync.progress':
      return hasPermission(p.permissions, `object:${e.objectType}:read`);
    case 'command.updated':
      if (e.actorType === p.type && e.actorId === p.id) return true;
      return hasPermission(p.permissions, 'command:read');
    case 'relay.health':
      return true;
    default:
      return false;
  }
}

export async function eventRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const r = typed(app);
  const { deps, opts } = ctx;
  const open = new Set<ServerResponse>();
  // End streams on shutdown; otherwise the server waits for them to close.
  app.addHook('preClose', async () => {
    for (const res of open) res.end();
    open.clear();
  });

  r.get(
    '/events',
    {
      config: { authenticated: true },
      schema: {
        tags: ['events'],
        summary: 'Server-Sent Events: qbv:events the caller may see, with heartbeats',
        description:
          'Event names: `object.changed`, `command.updated`, `sync.progress`, `relay.health`; data is the JSON event. ' +
          'A `ready` event is sent once subscribed, and a comment line every 15s keeps proxies open.',
      },
    },
    async (req, reply) => {
      const p = requirePrincipal(req);
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 5000\n\n');
      open.add(res);

      let closed = false;
      let unsubscribe: (() => void) | undefined;
      const send = (event: string, data: unknown) => {
        if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const heartbeat = setInterval(() => {
        if (!closed) res.write(`: ping ${Date.now()}\n\n`);
      }, opts.sseHeartbeatMs);
      // Close when the session expires so a revoked login stops receiving.
      const expiry =
        p.type === 'user'
          ? setTimeout(() => res.end(), Math.max(0, p.expiresAt.getTime() - Date.now()))
          : undefined;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        open.delete(res);
        clearInterval(heartbeat);
        if (expiry) clearTimeout(expiry);
        unsubscribe?.();
      };
      res.on('close', cleanup);
      req.raw.on('close', cleanup);

      try {
        const unsub = await deps.events.subscribe((e) => {
          if (canSeeEvent(p, e)) send(e.type, e);
        });
        if (closed) unsub();
        else unsubscribe = unsub;
      } catch (err) {
        req.log.error({ err }, 'event subscription failed');
        send('error', { message: 'Event stream unavailable' });
        res.end();
        cleanup();
        return;
      }
      send('ready', { principal: { type: p.type, id: p.id } });
    },
  );
}
