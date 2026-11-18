import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { useCommandsStore } from '@/stores/commands';
import {
  RECONNECT_DELAYS,
  setEventSourceFactory,
  useEventsStore,
  type EventSourceLike,
} from '@/stores/events';
import { useMetaStore } from '@/stores/meta';
import { ADMIN, CLERK, mockApi } from './helpers/api';
import { entityMeta } from './helpers/meta';

class FakeES implements EventSourceLike {
  static all: FakeES[] = [];
  readyState = 0;
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  listeners = new Map<string, ((ev: MessageEvent) => void)[]>();
  closed = false;
  constructor(public url: string) {
    FakeES.all.push(this);
  }
  addEventListener(type: string, l: (ev: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  fail() {
    this.onerror?.(new Event('error'));
  }
  send(data: unknown, event?: string) {
    const ev = new MessageEvent(event ?? 'message', { data: JSON.stringify(data) });
    if (event) this.listeners.get(event)?.forEach((l) => l(ev));
    else this.onmessage?.(ev);
  }
}

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  FakeES.all = [];
  setEventSourceFactory((url) => new FakeES(url));
});
afterEach(() => {
  setCsrfToken(null);
  vi.useRealTimers();
});

describe('auth store', () => {
  it('loads the session once and checks permissions with the shared grammar', async () => {
    const api = mockApi({ 'GET /auth/me': () => CLERK });
    const auth = useAuthStore();
    await Promise.all([auth.fetchMe(), auth.fetchMe()]);
    expect(api.calls).toHaveLength(1);
    expect(auth.user?.displayName).toBe('Clerk');
    expect(auth.canRead('Invoice')).toBe(true);
    expect(auth.canWrite('Invoice')).toBe(false);
    expect(auth.canWrite('Customer')).toBe(true);
    expect(auth.canRead('Customer')).toBe(true); // write implies read
    expect(auth.can('admin')).toBe(false);
    expect(auth.can(undefined)).toBe(true);
  });

  it('treats 401 as signed out, logs in (sending the CSRF token afterwards) and out', async () => {
    let loggedIn = false;
    const api = mockApi({
      'GET /auth/me': () =>
        loggedIn
          ? ADMIN
          : { status: 401, body: { error: { code: 'unauthenticated', message: 'no' } } },
      'POST /auth/login': (r) => {
        expect(r.body).toEqual({ email: 'admin@example.test', password: 'pw' });
        loggedIn = true;
        return ADMIN;
      },
      'POST /auth/logout': () => ({ status: 204 }),
    });
    const auth = useAuthStore();
    expect(await auth.fetchMe()).toBeNull();
    expect(auth.loaded).toBe(true);
    await auth.login('admin@example.test', 'pw');
    expect(auth.isAdmin).toBe(true);
    expect(auth.can('qbxml:raw')).toBe(true);
    await auth.logout();
    expect(api.calls.at(-1)!.headers['X-CSRF-Token']).toBe('csrf-1');
    expect(auth.isAuthenticated).toBe(false);
  });
});

describe('events store (SSE)', () => {
  it('dispatches named and default events, tracks relay health and revisions', async () => {
    mockApi({ 'GET /health': () => ({ status: 'ok', checks: { relay: { connected: true } } }) });
    const ev = useEventsStore();
    const seen: string[] = [];
    ev.on('*', (e) => seen.push(e.type));
    ev.connect();
    await vi.waitFor(() => expect(ev.relayConnected).toBe(true));
    const es = FakeES.all[0]!;
    expect(es.url).toBe('/api/events');
    es.open();
    expect(ev.status).toBe('open');
    es.send({ type: 'object.changed', objectType: 'Customer', qbId: '1', op: 'mod' });
    es.send({ objectType: 'Customer', qbId: '2', op: 'add' }, 'object.changed');
    es.send({ type: 'relay.health', connected: false, error: 'timeout' });
    es.send({ type: 'sync.progress', objectType: 'Invoice', status: 'running', count: 500 });
    es.send({ type: 'bogus' });
    expect(seen).toEqual(['object.changed', 'object.changed', 'relay.health', 'sync.progress']);
    expect(ev.revisions.Customer).toBe(2);
    expect(ev.lastChange['Customer:2']?.op).toBe('add');
    expect(ev.relayConnected).toBe(false);
    expect(ev.relayError).toBe('timeout');
    expect(ev.sync.Invoice).toMatchObject({ status: 'running', count: 500 });
    ev.disconnect();
    expect(es.closed).toBe(true);
  });

  it('reconnects with backoff and notifies reconnect listeners', async () => {
    vi.useFakeTimers();
    mockApi({ 'GET /health': () => ({}) });
    const ev = useEventsStore();
    const reconnected = vi.fn();
    ev.onReconnect(reconnected);
    ev.connect();
    FakeES.all[0]!.open();
    FakeES.all[0]!.fail();
    expect(ev.status).toBe('reconnecting');
    expect(FakeES.all[0]!.closed).toBe(true);
    vi.advanceTimersByTime(RECONNECT_DELAYS[0]! - 1);
    expect(FakeES.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeES.all).toHaveLength(2);
    FakeES.all[1]!.fail(); // second failure waits longer
    vi.advanceTimersByTime(RECONNECT_DELAYS[0]!);
    expect(FakeES.all).toHaveLength(2);
    vi.advanceTimersByTime(RECONNECT_DELAYS[1]! - RECONNECT_DELAYS[0]!);
    expect(FakeES.all).toHaveLength(3);
    FakeES.all[2]!.open();
    expect(ev.status).toBe('open');
    expect(reconnected).toHaveBeenCalledTimes(1);
    ev.disconnect();
    FakeES.all[2]!.fail();
    vi.advanceTimersByTime(60_000);
    expect(FakeES.all).toHaveLength(3); // no reconnect after disconnect
  });
});

describe('commands store', () => {
  it('submits writes, tracks them through events and settles with the final row', async () => {
    let status = 'queued';
    const api = mockApi({
      'POST /objects/Customer': () => ({ status: 202, body: { commandId: 'c-1' } }),
      'GET /commands/c-1': () => ({
        id: 'c-1',
        kind: 'add',
        status,
        object_type: 'Customer',
        object_id: status === 'succeeded' ? '80000001-1' : null,
        status_code: status === 'succeeded' ? 0 : null,
        status_message: status === 'succeeded' ? 'Status OK' : null,
      }),
    });
    const cmds = useCommandsStore();
    const ev = useEventsStore();
    cmds.start();
    const settled = vi.fn();
    cmds.onSettled(settled);
    const c = await cmds.submit({
      op: 'add',
      entity: 'Customer',
      body: { Name: 'Acme' },
      label: 'Add Acme',
    });
    expect(api.calls[0]).toMatchObject({
      method: 'POST',
      path: '/objects/Customer',
      body: { Name: 'Acme' },
    });
    expect(c).toMatchObject({ id: 'c-1', status: 'queued', label: 'Add Acme' });
    expect(cmds.pendingAdds('Customer')).toHaveLength(1);
    expect(cmds.badgeCount).toBe(1);

    const done = cmds.waitFor('c-1');
    ev.dispatch({ type: 'command.updated', id: 'c-1', status: 'sending' });
    expect(cmds.find('c-1')!.status).toBe('sending');
    status = 'succeeded';
    ev.dispatch({ type: 'command.updated', id: 'c-1', status: 'succeeded' });
    const final = await done;
    expect(final).toMatchObject({
      status: 'succeeded',
      objectId: '80000001-1',
      statusMessage: 'Status OK',
    });
    expect(settled).toHaveBeenCalledTimes(1);
    expect(cmds.pendingAdds('Customer')).toHaveLength(0);
    // persisted for the next page load
    expect(JSON.parse(localStorage.getItem('qbv.commands.v1')!)[0].id).toBe('c-1');
  });

  it('keeps conflicts (with result.current) as problems for the object until dismissed', async () => {
    mockApi({
      'PATCH /objects/Customer/80000001-1': (r) => {
        expect((r.body as Record<string, unknown>).EditSequence).toBe('1');
        return { status: 202, body: { commandId: 'c-2' } };
      },
      'GET /commands/c-2': () => ({
        id: 'c-2',
        status: 'conflict',
        statusCode: 3200,
        statusMessage: 'The provided edit sequence "1" is out-of-date.',
        result: { current: { ListID: '80000001-1', EditSequence: '2', Name: 'Acme' } },
      }),
    });
    const cmds = useCommandsStore();
    cmds.start();
    await cmds.submit({
      op: 'mod',
      entity: 'Customer',
      id: '80000001-1',
      body: { ListID: '80000001-1', EditSequence: '1', Phone: '1' },
      base: { ListID: '80000001-1', EditSequence: '1', Phone: '0' },
      formObject: 'CustomerMod',
    });
    useEventsStore().dispatch({ type: 'command.updated', id: 'c-2', status: 'conflict' });
    await vi.waitFor(() => expect(cmds.find('c-2')!.status).toBe('conflict'));
    const c = cmds.pendingFor('Customer', '80000001-1')!;
    expect(c.statusCode).toBe(3200);
    expect((c.result as { current: { EditSequence: string } }).current.EditSequence).toBe('2');
    expect(cmds.conflicts).toHaveLength(1);
    cmds.dismiss('c-2');
    expect(cmds.pendingFor('Customer', '80000001-1')).toBeUndefined();
  });

  it('polls pending commands while the event stream is down', async () => {
    vi.useFakeTimers();
    let n = 0;
    mockApi({
      'POST /objects/Vendor': () => ({ status: 202, body: { commandId: 'c-3' } }),
      'GET /commands/c-3': () => ({
        id: 'c-3',
        status: ++n >= 2 ? 'failed' : 'sending',
        status_message: 'boom',
      }),
    });
    const cmds = useCommandsStore();
    cmds.start();
    await cmds.submit({ op: 'add', entity: 'Vendor', body: { Name: 'V' } });
    await vi.advanceTimersByTimeAsync(3000);
    expect(cmds.find('c-3')!.status).toBe('sending');
    await vi.advanceTimersByTimeAsync(3000);
    expect(cmds.find('c-3')!.status).toBe('failed');
    expect(cmds.problems.map((c) => c.id)).toEqual(['c-3']);
    cmds.stop();
  });

  it('adopts commands of the current user created elsewhere', async () => {
    mockApi({
      'GET /auth/me': () => ADMIN,
      'GET /commands/c-9': () => ({ id: 'c-9', status: 'queued', objectType: 'Invoice' }),
    });
    await useAuthStore().fetchMe();
    const cmds = useCommandsStore();
    cmds.start();
    useEventsStore().dispatch({
      type: 'command.updated',
      id: 'c-9',
      status: 'queued',
      objectType: 'Invoice',
      actorId: 'u1',
    });
    useEventsStore().dispatch({
      type: 'command.updated',
      id: 'c-10',
      status: 'queued',
      objectType: 'Invoice',
      actorId: 'someone-else',
    });
    expect(cmds.items.map((c) => c.id)).toEqual(['c-9']);
  });

  it('keeps the submitted form when the live event adopted the command before the 202', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mockApi({
      'GET /auth/me': () => ADMIN,
      'PATCH /objects/Customer/80000001-1': async () => {
        await gate;
        return { status: 202, body: { commandId: 'c-11' } };
      },
      'GET /commands/c-11': () => ({ id: 'c-11', status: 'conflict', objectType: 'Customer' }),
    });
    await useAuthStore().fetchMe();
    const cmds = useCommandsStore();
    cmds.start();
    const pending = cmds.submit({
      op: 'mod',
      entity: 'Customer',
      id: '80000001-1',
      body: { ListID: '80000001-1', EditSequence: '1', Phone: '1' },
      base: { ListID: '80000001-1', EditSequence: '1', Phone: '0' },
      formObject: 'CustomerMod',
    });
    useEventsStore().dispatch({
      type: 'command.updated',
      id: 'c-11',
      status: 'conflict',
      objectType: 'Customer',
      actorId: 'u1',
    });
    expect(cmds.find('c-11')?.formObject).toBeNull();
    release();
    const c = await pending;
    expect(c).toMatchObject({ id: 'c-11', op: 'mod', formObject: 'CustomerMod' });
    expect(cmds.find('c-11')!.submitted).toMatchObject({ Phone: '1' });
    expect(cmds.find('c-11')!.base).toMatchObject({ Phone: '0' });
  });
});

describe('meta store', () => {
  it('loads entity metadata and resolves Add/Mod object names from the request definitions', async () => {
    mockApi({
      'GET /meta/entities': () => ({
        entities: [entityMeta('Invoice').entity, entityMeta('Customer').entity],
      }),
      'GET /meta/entities/Invoice': () => entityMeta('Invoice'),
    });
    const meta = useMetaStore();
    await meta.loadEntities();
    expect(meta.entityNames).toEqual(['Customer', 'Invoice']);
    await meta.loadEntity('Invoice');
    expect(meta.addObjectName('Invoice')).toBe('InvoiceAdd');
    expect(meta.modObjectName('Invoice')).toBe('InvoiceMod');
    expect(meta.objects.InvoiceLineAdd).toBeDefined();
    expect(meta.objects.BillAddress).toBeDefined();
  });

  it('fetches ObjectDefs the entity metadata left out', async () => {
    const full = entityMeta('Customer');
    const partial = {
      ...full,
      objects: {
        CustomerAdd: full.objects.CustomerAdd,
        CustomerMod: full.objects.CustomerMod,
        CustomerRet: full.objects.CustomerRet,
      },
    };
    const api = mockApi({
      'GET /meta/entities/Customer': () => partial,
      'GET /meta/objects/:name': (r) => {
        const name = r.path.split('/').pop()!;
        return (
          (full.objects as Record<string, unknown>)[name] ?? {
            status: 404,
            body: { error: { code: 'nf', message: 'nf' } },
          }
        );
      },
    });
    const meta = useMetaStore();
    await meta.loadEntity('Customer');
    expect(meta.objects.BillAddress).toBeDefined();
    expect(meta.objects.CustomerRef ?? meta.objects.ClassRef).toBeDefined();
    expect(api.calls.filter((c) => c.path.startsWith('/meta/objects/')).length).toBeGreaterThan(3);
  });
});
