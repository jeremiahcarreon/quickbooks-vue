import { expect, test } from '@playwright/test';
import { RUN_ID } from './env.js';
import { Api } from './helpers.js';

/** Generic, metadata-driven screens on a list entity: list, add, detail, edit, delete. */
test.describe('customer (generic list entity screens)', () => {
  const name = `E2E Customer ${RUN_ID}`;

  test('list, add, view, edit and delete a customer', async ({ page }) => {
    const api = await Api.create();

    // List: synced rows, server-side search.
    await page.goto('/objects/Customer');
    await expect(page.getByText(/\d+ in the read model/)).toBeVisible();
    await expect(page.locator('main tbody tr').first()).toBeVisible();

    // Add through the generated form.
    await page.getByRole('button', { name: 'New' }).click();
    await expect(page).toHaveURL(/\/objects\/Customer\/new$/);
    await page.locator('#fld-Name').fill(name);
    await page.locator('#fld-CompanyName').fill('E2E & Sons');
    await page.locator('#fld-FirstName').fill('Erin');
    await page.locator('#fld-LastName').fill('Endtoend');
    await page.getByRole('button', { name: 'Create' }).click();

    // QuickBooks confirms; the app lands on the new record.
    await expect(page).toHaveURL(/\/objects\/Customer\/[^/]+$/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name })).toBeVisible();
    await expect(page.getByText('E2E & Sons').first()).toBeVisible();
    const created = await api.findByName('Customer', name);
    expect(created?.data.CompanyName).toBe('E2E & Sons');
    const id = created!.id;
    expect(page.url()).toContain(encodeURIComponent(id));

    // Edit.
    await page.getByRole('button', { name: 'Edit' }).click();
    await expect(page).toHaveURL(/\/edit$/);
    await page.locator('#fld-CompanyName').fill('E2E Holdings');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page).toHaveURL(new RegExp(`/objects/Customer/${encodeURIComponent(id)}$`), {
      timeout: 30_000,
    });
    await expect(page.getByText('E2E Holdings').first()).toBeVisible();
    await expect
      .poll(async () => (await api.get('Customer', id))?.data.CompanyName)
      .toBe('E2E Holdings');

    // The search box finds it.
    await page.goto('/objects/Customer');
    await page
      .getByPlaceholder(/search/i)
      .first()
      .fill(RUN_ID);
    await expect(page.locator('main tbody tr', { hasText: name })).toBeVisible();

    // Delete (with confirmation).
    await page.goto(`/objects/Customer/${encodeURIComponent(id)}`);
    await page.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
    await expect
      .poll(async () => (await api.get('Customer', id))?.deletedAt ?? null, { timeout: 30_000 })
      .not.toBeNull();
    await page.goto('/objects/Customer');
    await page
      .getByPlaceholder(/search/i)
      .first()
      .fill(RUN_ID);
    await expect(page.locator('main tbody tr', { hasText: name })).toHaveCount(0);

    await api.dispose();
  });
});
