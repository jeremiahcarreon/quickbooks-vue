import { expect, test } from '@playwright/test';
import { BASE_URL, RUN_ID } from './env.js';
import { Api } from './helpers.js';

/**
 * Raw qbXML envelope and permission checks, live queries for entities sync
 * cannot load, SDK actions, the authenticated API docs and the "use
 * QuickBooks Desktop" screens, against the running dev stack.
 */
const doc = (pi: string) => `<?xml version="1.0" encoding="utf-8"?>
${pi}
<QBXML>
  <QBXMLMsgsRq onError="stopOnError">
    <CustomerQueryRq requestID="1"><MaxReturned>1</MaxReturned></CustomerQueryRq>
  </QBXMLMsgsRq>
</QBXML>`;

test.describe('SDK coverage and access', () => {
  test('API docs need a session or token', async ({ playwright }) => {
    const anon = await playwright.request.newContext({
      baseURL: BASE_URL,
      storageState: { cookies: [], origins: [] },
    });
    expect((await anon.get('/api/docs/json')).status()).toBe(401);
    await anon.dispose();
    const api = await Api.create();
    const res = await api.ctx.get('/api/docs/json');
    expect(res.status()).toBe(200);
    expect(
      ((await res.json()) as { paths: Record<string, unknown> }).paths['/api/actions/{request}'],
    ).toBeTruthy();
    await api.dispose();
  });

  test('raw qbXML needs a supported <?qbxml version?> and per-request permissions', async ({
    playwright,
  }) => {
    const api = await Api.create();
    const xml = { ...api.headers, 'content-type': 'application/xml' };
    for (const pi of ['', '<?qbxml version="99.0"?>']) {
      const v = await api.ctx.post('/api/qbxml/validate', { data: doc(pi), headers: xml });
      const body = (await v.json()) as { valid: boolean; errors: { message: string }[] };
      expect(body.valid).toBe(false);
      expect(body.errors.map((e) => e.message).join(' ')).toMatch(/qbxml/i);
      const sent = await api.ctx.post('/api/qbxml?wait=false', { data: doc(pi), headers: xml });
      expect(sent.status()).toBe(400);
    }

    const created = await api.ctx.post('/api/admin/tokens', {
      data: { name: `e2e raw only ${RUN_ID}`, permissions: ['qbxml:raw'] },
      headers: api.headers,
    });
    expect(created.status(), await created.text()).toBe(201);
    const { id, token } = (await created.json()) as { id: string; token: string };
    try {
      const raw = await playwright.request.newContext({
        baseURL: BASE_URL,
        storageState: { cookies: [], origins: [] },
        extraHTTPHeaders: { authorization: `Bearer ${token}`, 'content-type': 'application/xml' },
      });
      const add = await raw.post('/api/qbxml?wait=false', {
        data: doc('<?qbxml version="16.0"?>').replace(
          '<CustomerQueryRq requestID="1"><MaxReturned>1</MaxReturned></CustomerQueryRq>',
          `<CustomerAddRq><CustomerAdd><Name>Raw only ${RUN_ID}</Name></CustomerAdd></CustomerAddRq>`,
        ),
      });
      expect(add.status()).toBe(403);
      const query = await raw.post('/api/qbxml?wait=false', {
        data: doc('<?qbxml version="16.0"?>'),
      });
      expect(query.status()).toBe(403);
      await raw.dispose();
    } finally {
      await api.ctx.delete(`/api/admin/tokens/${id}`, { headers: api.headers });
      await api.dispose();
    }
  });

  test('live query and SDK actions go through QuickBooks', async () => {
    const api = await Api.create();
    const vendors = await api.list('Vendor', { pageSize: '1' });
    expect(vendors.items.length).toBeGreaterThan(0);
    const live = await api.ctx.post('/api/objects/BillToPay/live', {
      data: { PayeeEntityRef: { ListID: vendors.items[0]!.id } },
      headers: api.headers,
    });
    expect(live.status(), await live.text()).toBe(200);
    const lj = (await live.json()) as { items: unknown[]; responses: { name: string }[] };
    expect(lj.responses[0]!.name).toBe('BillToPayQueryRs');
    expect(Array.isArray(lj.items)).toBe(true);

    const missing = await api.ctx.post('/api/objects/BillToPay/live', {
      data: {},
      headers: api.headers,
    });
    expect(missing.status()).toBe(400);

    const action = await api.ctx.post('/api/actions/TransactionQueryRq?wait=true', {
      data: { MaxReturned: 3 },
      headers: api.headers,
    });
    expect(action.status(), await action.text()).toBe(200);
    const aj = (await action.json()) as { responses: { name: string; statusCode: number }[] };
    expect(aj.responses[0]!.name).toBe('TransactionQueryRs');
    await api.dispose();
  });

  test('screens: live query form, actions list and QuickBooks Desktop-only features', async ({
    page,
  }) => {
    await page.goto('/objects/BillToPay');
    await expect(page.getByText('live from QuickBooks')).toBeVisible();
    await expect(page.getByTestId('live-run')).toBeVisible();

    await page.goto('/company/actions');
    await expect(page.getByTestId('actions-list')).toContainText('List Merge');

    await page.goto('/desktop-only/reconcile');
    await expect(page.getByTestId('desktop-only')).toContainText(
      'only available in QuickBooks Desktop',
    );
    await expect(page.getByRole('link', { name: 'Run payroll' })).toBeVisible();
  });
});
