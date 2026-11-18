import { describe, expect, it } from 'vitest';
import { RelayCircuit } from '../src/circuit.js';
import { sleep, until } from './helpers.js';

function setup(ping: { ok: boolean; connected: boolean; error?: string }) {
  const calls: string[] = [];
  const health: [boolean, string | null][] = [];
  const state = { ping };
  const c = new RelayCircuit({
    relay: { ping: async () => state.ping },
    cooldownMs: 60,
    healthIntervalMs: 20,
    onOpen: () => void calls.push('open'),
    onHalfOpen: () => void calls.push('half-open'),
    onHealth: (connected, error) => void health.push([connected, error]),
  });
  return { c, calls, health, state };
}

describe('RelayCircuit', () => {
  it('opens on a transient failure, waits the cooldown, half-opens when the relay answers, closes on success', async () => {
    const { c, calls, health } = setup({ ok: true, connected: true });
    await c.recordFailure('QuickBooks is not connected');
    expect(c.state).toBe('open');
    expect(calls).toEqual(['open']);
    expect(health).toEqual([[false, 'QuickBooks is not connected']]);
    await sleep(20);
    expect(c.state).toBe('open'); // still cooling down
    await until(() => c.state === 'half-open', 1000, 5);
    expect(calls).toEqual(['open', 'half-open']);
    await c.recordSuccess();
    expect(c.state).toBe('closed');
    expect(health.at(-1)).toEqual([true, null]);
    c.stop();
  });

  it('stays open while the relay is unreachable', async () => {
    const { c, calls, state } = setup({ ok: false, connected: false, error: 'ECONNREFUSED' });
    await c.recordFailure('connect ECONNREFUSED');
    await sleep(150);
    expect(c.state).toBe('open');
    expect(calls).toEqual(['open']);
    state.ping = { ok: true, connected: false };
    await until(() => c.state === 'half-open', 1000, 5);
    c.stop();
  });

  it('a failure while half-open re-opens it', async () => {
    const { c, calls } = setup({ ok: true, connected: true });
    await c.recordFailure('x');
    await until(() => c.state === 'half-open', 1000, 5);
    await c.recordFailure('y');
    expect(c.state).toBe('open');
    expect(calls).toEqual(['open', 'half-open', 'open']);
    c.stop();
  });

  it('health polling publishes changes only and opens when the relay is unreachable', async () => {
    const { c, health, state, calls } = setup({ ok: true, connected: true });
    c.start();
    await until(() => health.length === 1);
    expect(health).toEqual([[true, null]]);
    await sleep(60);
    expect(health).toHaveLength(1);
    state.ping = { ok: true, connected: false, error: 'session lost' };
    await until(() => health.length === 2);
    expect(health[1]).toEqual([false, 'session lost']);
    expect(c.state).toBe('closed'); // reachable: a request decides, not the flag
    state.ping = { ok: false, connected: false, error: 'ECONNREFUSED' };
    await until(() => c.state === 'open');
    expect(calls).toEqual(['open']);
    c.stop();
  });
});
