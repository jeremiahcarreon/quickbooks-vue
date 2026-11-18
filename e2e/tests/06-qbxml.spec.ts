import { expect, test } from '@playwright/test';
import { Api } from './helpers.js';

const doc = (body: string) => `<?xml version="1.0" encoding="utf-8"?>
<?qbxml version="16.0"?>
<QBXML>
  <QBXMLMsgsRq onError="stopOnError">
${body}
  </QBXMLMsgsRq>
</QBXML>`;

// Out of schema order: MaxReturned must come before ActiveStatus.
const INVALID = doc(`    <CustomerQueryRq requestID="1">
      <ActiveStatus>All</ActiveStatus>
      <MaxReturned>2</MaxReturned>
    </CustomerQueryRq>`);
const VALID = doc(`    <CustomerQueryRq requestID="1">
      <MaxReturned>2</MaxReturned>
      <ActiveStatus>All</ActiveStatus>
    </CustomerQueryRq>`);

test.describe('raw qbXML', () => {
  test('POST /api/qbxml: 400 with libxml2 errors for invalid XML, QuickBooks response for valid XML', async () => {
    const api = await Api.create();
    const before = (await (
      await api.ctx.get('/api/commands', { params: { kind: 'raw', pageSize: '1' } })
    ).json()) as {
      items: { id: string }[];
    };

    const bad = await api.ctx.post('/api/qbxml', {
      data: INVALID,
      headers: { ...api.headers, 'content-type': 'application/xml' },
    });
    expect(bad.status()).toBe(400);
    const err = (
      (await bad.json()) as {
        error: { code: string; details: { errors: { line: number; message: string }[] } };
      }
    ).error;
    expect(err.code).toBe('qbxml_invalid');
    expect(err.details.errors[0]!.line).toBe(7);
    expect(err.details.errors[0]!.message).toMatch(
      /Element 'MaxReturned': This element is not expected/,
    );
    // Nothing was queued for the rejected document.
    const after = (await (
      await api.ctx.get('/api/commands', { params: { kind: 'raw', pageSize: '1' } })
    ).json()) as {
      items: { id: string }[];
    };
    expect(after.items[0]?.id).toBe(before.items[0]?.id);

    const malformed = await api.ctx.post('/api/qbxml', {
      data: VALID.replace('</CustomerQueryRq>', ''),
      headers: { ...api.headers, 'content-type': 'application/xml' },
    });
    expect(malformed.status()).toBe(400);

    const ok = await api.ctx.post('/api/qbxml', {
      data: VALID,
      headers: { ...api.headers, 'content-type': 'application/xml', accept: 'application/xml' },
    });
    expect(ok.status()).toBe(200);
    expect(ok.headers()['x-command-id']).toBeTruthy();
    const xml = await ok.text();
    expect(xml).toContain('<QBXMLMsgsRs>');
    expect(xml).toMatch(
      /<CustomerQueryRs requestID="1" statusCode="0"|<CustomerQueryRs[^>]*statusCode="0"/,
    );
    expect(xml.match(/<CustomerRet>/g)).toHaveLength(2);

    // JSON variant with parsed responses.
    const json = await api.ctx.post('/api/qbxml', {
      data: { qbxml: VALID },
      headers: { ...api.headers, accept: 'application/json' },
    });
    expect(json.status()).toBe(200);
    const body = (await json.json()) as {
      responses: { name: string; statusCode: number; rets: unknown[] }[];
    };
    expect(body.responses[0]).toMatchObject({ name: 'CustomerQueryRs', statusCode: 0 });
    expect(body.responses[0]!.rets).toHaveLength(2);
    await api.dispose();
  });

  test('console: live XSD check marks the bad line, and a valid request shows the response', async ({
    page,
  }) => {
    await page.goto('/admin/qbxml');
    const editor = page.getByLabel('qbXML request');
    await editor.fill(INVALID);
    await expect(page.getByTestId('xsd-status')).toHaveText('XSD errors');
    await expect(page.getByTestId('issues')).toContainText('Line 7');
    await expect(page.getByTestId('issues')).toContainText('MaxReturned');
    await expect(page.locator('.xml-editor__err')).toHaveText('7');

    await editor.fill(VALID);
    await expect(page.getByTestId('xsd-status')).toHaveText('Valid against XSD');
    await page.getByTestId('send').click();
    await expect(page.getByText(/Command .* · succeeded/)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.console__grid')).toContainText('CustomerQueryRs');
  });
});
