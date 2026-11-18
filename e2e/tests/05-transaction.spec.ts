import { expect, test, type Page } from '@playwright/test';
import { RUN_ID } from './env.js';
import { Api, pickRef } from './helpers.js';

async function lineInput(page: Page, line: number, column: string) {
  return page.getByLabel(`Line ${line} ${column}`, { exact: true });
}

/** Purpose-built invoice screen, then the generic detail screen for void and delete. */
test.describe('invoice (transaction)', () => {
  test('create, edit, void and delete an invoice', async ({ page }) => {
    const api = await Api.create();
    const customer = (await api.list('Customer', { sort: 'name', pageSize: '1' })).items[0]!;
    const item = (await api.list('ItemService', { sort: 'name', pageSize: '1' })).items[0]!;
    const memo = `E2E invoice ${RUN_ID}`;

    await page.goto('/transactions/invoice/new');
    await pickRef(page, page.locator('#h-CustomerRef'), customer.name!.slice(0, 6), customer.name!);
    await pickRef(page, await lineInput(page, 1, 'Item'), item.name!.slice(0, 5), item.name!);
    await (await lineInput(page, 1, 'Qty')).fill('3');
    await (await lineInput(page, 1, 'Rate')).fill('125.50');
    await (await lineInput(page, 1, 'Rate')).press('Tab');
    await page.locator('#h-Memo').fill(memo);
    await expect(page.locator('main')).toContainText('376.50');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    // Confirmed by QuickBooks, and the form now shows the saved transaction.
    await expect(page.getByText('Confirmed.')).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/transactions\/invoice\/[^/]+$/);
    const txnId = decodeURIComponent(page.url().split('/').pop()!);
    expect(txnId).not.toBe('new');
    const saved = await api.get('Invoice', txnId);
    expect(saved?.data.Memo).toBe(memo);
    expect(saved?.data.CustomerRef).toMatchObject({ ListID: customer.id });
    const lines = saved?.data.InvoiceLineRet as {
      Quantity?: string;
      Rate?: string;
      Amount?: string;
    }[];
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ Quantity: '3', Amount: '376.50' });

    // Edit: change the quantity and memo on the same screen (InvoiceMod with TxnLineID).
    await page.reload();
    await expect(page.locator('#h-Memo')).toHaveValue(memo);
    await (await lineInput(page, 1, 'Qty')).fill('4');
    await (await lineInput(page, 1, 'Qty')).press('Tab');
    await page.locator('#h-Memo').fill(`${memo} (edited)`);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Confirmed.')).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () => {
        const o = await api.get('Invoice', txnId);
        const l = (o?.data.InvoiceLineRet as { Amount?: string }[] | undefined) ?? [];
        return [o?.data.Memo, l.length, l[0]?.Amount];
      })
      .toEqual([`${memo} (edited)`, 1, '502.00']);

    // The generic detail screen shows it; void it there.
    await page.goto(`/objects/Invoice/${encodeURIComponent(txnId)}`);
    await expect(page.getByText(`${memo} (edited)`).first()).toBeVisible();
    await page.getByRole('button', { name: 'Void' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Void' }).click();
    await expect
      .poll(async () => (await api.get('Invoice', txnId))?.data.Memo, { timeout: 30_000 })
      .toMatch(/^VOID:/);
    expect(Number((await api.get('Invoice', txnId))?.amount)).toBe(0);

    // Delete.
    await page.reload();
    await page.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
    await expect
      .poll(async () => (await api.get('Invoice', txnId))?.deletedAt ?? null, { timeout: 30_000 })
      .not.toBeNull();
    await api.dispose();
  });
});
