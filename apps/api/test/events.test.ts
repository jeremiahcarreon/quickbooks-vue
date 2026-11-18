import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QbvEvent } from '@qbv/queue';
import { canSeeEvent } from '../src/routes/events.js';
import type { Principal } from '../src/types.js';
import { bearer, createTestApp, createToken, userSession, type TestApp } from './helpers.js';

let t: TestApp;
let base: string;
beforeAll(async () => {
  t = await createTestApp({ app: { sseHeartbeatMs: 200 } });
  await t.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = t.app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => t?.close());

/** Read SSE frames until `until` matches or the timeout passes. */
async function readStream(
  res: Response,
  until: (frames: string[]) => boolean,
  timeoutMs = 5000,
): Promise<string[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const frames: string[] = [];
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline && !until(frames)) {
      const r = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((ok) =>
          setTimeout(() => ok({ done: true, value: undefined }), deadline - Date.now()),
        ),
      ]);
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        frames.push(buf.slice(0, i));
        buf = buf.slice(i + 2);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return frames;
}

describe('GET /events (SSE)', () => {
  it('requires authentication', async () => {
    const res = await fetch(`${base}/api/events`);
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it('streams only events the caller may see, plus heartbeats', async () => {
    const { token, id } = await createToken(t.db, ['object:Customer:read']);
    const ac = new AbortController();
    const res = await fetch(`${base}/api/events`, { headers: bearer(token), signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    let published = false;
    const frames = await readStream(res, (f) => {
      if (!published && f.some((x) => x.startsWith('event: ready'))) {
        published = true;
        const evs: QbvEvent[] = [
          { type: 'object.changed', objectType: 'Vendor', qbId: 'v1', op: 'mod' },
          {
            type: 'command.updated',
            id: 'c-other',
            status: 'succeeded',
            actorType: 'user',
            actorId: 'someone',
          },
          {
            type: 'command.updated',
            id: 'c-mine',
            status: 'succeeded',
            actorType: 'token',
            actorId: id,
          },
          { type: 'relay.health', connected: false, error: 'down' },
          { type: 'object.changed', objectType: 'Customer', qbId: 'c1', op: 'add' },
        ];
        void (async () => {
          for (const e of evs) await t.deps.events.publish(e);
        })();
      }
      return f.some((x) => x.includes('"qbId":"c1"')) && f.some((x) => x.startsWith(': ping'));
    });
    ac.abort();
    const events = frames.filter((f) => f.startsWith('event: ')).map((f) => f.split('\n')[0]);
    const data = frames.join('\n');
    expect(events).toContain('event: ready');
    expect(data).toContain('"qbId":"c1"');
    expect(data).toContain('"id":"c-mine"');
    expect(data).toContain('event: relay.health');
    expect(data).not.toContain('"objectType":"Vendor"');
    expect(data).not.toContain('c-other');
    expect(frames.some((f) => f.startsWith(': ping'))).toBe(true);
  });

  it('works with a session cookie', async () => {
    const s = await userSession(t, { roles: ['ReadOnly'] });
    const ac = new AbortController();
    const res = await fetch(`${base}/api/events`, {
      headers: { cookie: s.cookie },
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    const frames = await readStream(res, (f) => f.some((x) => x.startsWith('event: ready')));
    ac.abort();
    expect(frames.some((f) => f.startsWith('event: ready'))).toBe(true);
  });
});

describe('canSeeEvent', () => {
  const user: Principal = {
    type: 'user',
    id: 'u1',
    email: 'x',
    displayName: 'x',
    permissions: ['object:Invoice:write'],
    sessionId: 's',
    csrfToken: 'c',
    expiresAt: new Date(),
  };
  it('filters by permission', () => {
    expect(
      canSeeEvent(user, { type: 'object.changed', objectType: 'Invoice', qbId: '1', op: 'add' }),
    ).toBe(true);
    expect(
      canSeeEvent(user, {
        type: 'sync.progress',
        objectType: 'Customer',
        status: 'running',
        count: 1,
      }),
    ).toBe(false);
    expect(
      canSeeEvent(user, {
        type: 'command.updated',
        id: '1',
        status: 'queued',
        actorType: 'user',
        actorId: 'u1',
      }),
    ).toBe(true);
    expect(canSeeEvent(user, { type: 'command.updated', id: '1', status: 'queued' })).toBe(false);
    expect(
      canSeeEvent(
        { ...user, permissions: ['command:read'] },
        { type: 'command.updated', id: '1', status: 'queued' },
      ),
    ).toBe(true);
    expect(canSeeEvent(user, { type: 'relay.health', connected: true })).toBe(true);
  });
});
