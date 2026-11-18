import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import QbxmlConsoleView from '@/modules/admin/QbxmlConsoleView.vue';
import RolesView from '@/modules/admin/RolesView.vue';
import SyncView from '@/modules/admin/SyncView.vue';
import TokensView from '@/modules/admin/TokensView.vue';
import UsersView from '@/modules/admin/UsersView.vue';
import { QBXML_TEMPLATES } from '@/lib/qbxmlTemplates';
import { useAuthStore } from '@/stores/auth';
import { useEventsStore } from '@/stores/events';
import { ADMIN, mockApi, type MockRequest } from './helpers/api';
import { entityList } from './helpers/meta';
import { mountWith } from './helpers/mount';
import { xsdCheck } from './helpers/xsd';

let pinia = createPinia();
beforeEach(async () => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
  mockApi({ 'GET /auth/me': () => ADMIN });
  await useAuthStore().fetchMe();
});

const byText = (w: ReturnType<typeof mountWith>, text: string) =>
  w.findAll('button').find((b) => b.text().trim() === text)!;
const bodyButton = (text: string) =>
  [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  ) as HTMLButtonElement;

describe('API tokens', () => {
  it('creates a token with permissions and shows the secret exactly once', async () => {
    let created: MockRequest | null = null;
    const list: unknown[] = [];
    mockApi({
      'GET /meta/entities': () => entityList(),
      'GET /admin/tokens': () => list,
      'POST /admin/tokens': (r) => {
        created = r;
        list.push({
          id: 't1',
          name: 'Shop sync',
          token_prefix: 'qbv_ab',
          permissions: (r.body as { permissions: string[] }).permissions,
        });
        return { token: 'qbv_abcdef123456', apiToken: list[0] };
      },
    });
    const w = mountWith(TokensView, { pinia });
    await flushPromises();
    await byText(w, 'New token').trigger('click');
    await flushPromises();
    (document.querySelector('#t-name') as HTMLInputElement).value = 'Shop sync';
    document.querySelector('#t-name')!.dispatchEvent(new Event('input'));
    (document.querySelector('#perm-object\\:\\*\\:read') as HTMLInputElement).click();
    await flushPromises();
    bodyButton('Create token').click();
    await vi.waitFor(() => expect(created).not.toBeNull());
    expect(created!.body).toEqual({
      name: 'Shop sync',
      permissions: ['object:*:read'],
      expiresAt: null,
    });
    await flushPromises();
    const secret = document.querySelector('[data-testid="new-token"]') as HTMLInputElement;
    expect(secret.value).toBe('qbv_abcdef123456');
    bodyButton('I have stored it').click();
    await flushPromises();
    expect(document.querySelector('[data-testid="new-token"]')).toBeNull();
    expect(w.text()).toContain('Shop sync');
    expect(w.text()).not.toContain('qbv_abcdef123456');
    w.unmount();
  });
});

describe('roles', () => {
  it('edits a role with the permission editor and saves it', async () => {
    let saved: MockRequest | null = null;
    mockApi({
      'GET /meta/entities': () => entityList(),
      'GET /admin/roles': () => [
        { id: 'r1', name: 'Sales', description: 'Sales desk', permissions: ['object:*:read'] },
      ],
      'PATCH /admin/roles/r1': (r) => {
        saved = r;
        return { id: 'r1', name: 'Sales', ...(r.body as object) };
      },
    });
    const w = mountWith(RolesView, { pinia });
    await vi.waitFor(() => expect(w.text()).toContain('Sales desk'));
    await w.find('tbody tr').trigger('click');
    await flushPromises();
    const row = document.querySelector('[data-type="Invoice"]')!;
    (
      [...row.querySelectorAll('button')].find(
        (b) => b.textContent === 'Write',
      ) as HTMLButtonElement
    ).click();
    await flushPromises();
    bodyButton('Save').click();
    await vi.waitFor(() => expect(saved).not.toBeNull());
    expect(saved!.body).toEqual({
      name: 'Sales',
      description: 'Sales desk',
      permissions: ['object:*:read', 'object:Invoice:write'],
    });
    w.unmount();
  });
});

describe('users', () => {
  it('requires 12+ character passwords and creates users with roles', async () => {
    let created: MockRequest | null = null;
    mockApi({
      'GET /admin/users': () => ({
        users: [
          { id: 'u1', email: 'a@x.test', display_name: 'A', is_active: true, roles: ['Admin'] },
        ],
      }),
      'GET /admin/roles': () => [{ id: 'r1', name: 'Admin', permissions: ['admin'] }],
      'POST /admin/users': (r) => {
        created = r;
        return { id: 'u2', ...(r.body as object) };
      },
    });
    const w = mountWith(UsersView, { pinia });
    await vi.waitFor(() => expect(w.text()).toContain('a@x.test'));
    await byText(w, 'New user').trigger('click');
    await flushPromises();
    const set = (sel: string, v: string) => {
      const el = document.querySelector(sel) as HTMLInputElement;
      el.value = v;
      el.dispatchEvent(new Event('input'));
    };
    set('#u-email', 'b@x.test');
    set('#u-pass', 'short');
    await flushPromises();
    bodyButton('Save').click();
    await flushPromises();
    expect(document.body.textContent).toContain('at least 12 characters');
    set('#u-pass', 'a-long-enough-password');
    await flushPromises();
    bodyButton('Save').click();
    await vi.waitFor(() => expect(created).not.toBeNull());
    expect(created!.body).toMatchObject({
      email: 'b@x.test',
      password: 'a-long-enough-password',
      isActive: true,
      roles: [],
    });
    w.unmount();
  });
});

describe('sync status', () => {
  it('lists sync state, shows live progress and triggers a resync', async () => {
    const posts: MockRequest[] = [];
    mockApi({
      'GET /admin/sync': () => [
        { type: 'Invoice', status: 'idle', row_count: 120, last_run_at: new Date().toISOString() },
      ],
      'POST /admin/sync/Invoice': (r) => {
        posts.push(r);
        return { status: 202, body: {} };
      },
    });
    const w = mountWith(SyncView, { pinia });
    await vi.waitFor(() => expect(w.text()).toContain('120'));
    useEventsStore().dispatch({
      type: 'sync.progress',
      objectType: 'Invoice',
      status: 'running',
      count: 500,
    });
    await flushPromises();
    expect(w.text()).toContain('running');
    expect(w.text()).toContain('500 rows');
    await byText(w, 'Full').trigger('click');
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({ mode: 'full' });
    w.unmount();
  });
});

describe('qbXML console', () => {
  it('sends XSD-valid documents as application/xml and shows the response', async () => {
    const sent: MockRequest[] = [];
    mockApi({
      'POST /qbxml/validate': () => ({
        status: 404,
        body: { error: { code: 'not_found', message: 'nf' } },
      }),
      'POST /qbxml': (r) => {
        sent.push(r);
        return {
          commandId: 'c1',
          status: 'succeeded',
          response:
            '<?xml version="1.0"?><QBXML><QBXMLMsgsRs><CustomerQueryRs statusCode="0" /></QBXMLMsgsRs></QBXML>',
        };
      },
    });
    localStorage.setItem('qbv.console.xml', QBXML_TEMPLATES[2]!.xml);
    const w = mountWith(QbxmlConsoleView, { pinia });
    await vi.waitFor(
      () => expect(w.find('[data-testid="xsd-status"]').text()).toBe('Validated on send'),
      { timeout: 3000 },
    );
    await w.find('[data-testid="send"]').trigger('click');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.headers['Content-Type']).toBe('application/xml');
    expect(sent[0]!.query.get('wait')).toBe('true');
    // what the console sends is a valid qbXML document
    expect(xsdCheck({ xml: String(sent[0]!.body) }).valid).toBe(true);
    await vi.waitFor(() => expect(w.text()).toContain('CustomerQueryRs'));
    w.unmount();
  });

  it('marks libxml2 errors from the server by line and blocks malformed XML locally', async () => {
    let validations = 0;
    mockApi({
      'POST /qbxml/validate': () => {
        validations++;
        return {
          valid: false,
          errors: [{ line: 6, message: "Element 'MaxReturned': 'ten' is not a valid value" }],
        };
      },
    });
    localStorage.setItem('qbv.console.xml', QBXML_TEMPLATES[2]!.xml.replace('>10<', '>ten<'));
    const w = mountWith(QbxmlConsoleView, { pinia });
    await vi.waitFor(() => expect(w.find('[data-testid="issues"]').text()).toContain('Line 6'), {
      timeout: 3000,
    });
    expect(w.find('.xml-editor__err').text()).toBe('6');
    expect(w.find('[data-testid="xsd-status"]').text()).toBe('XSD errors');

    await w.find('textarea').setValue('<QBXML><oops></QBXML>');
    await vi.waitFor(
      () => expect(w.find('[data-testid="xsd-status"]').text()).toBe('Not well-formed'),
      { timeout: 3000 },
    );
    expect(w.find('[data-testid="send"]').attributes('disabled')).toBeDefined();
    expect(validations).toBe(1);
    w.unmount();
  });
});
