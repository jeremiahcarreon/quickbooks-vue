import { expect, test } from '@playwright/test';
import { Api } from './helpers.js';

/** Spotlight search: Ctrl+K overlay over menus and every record type. */
test.describe('spotlight search', () => {
  test('Ctrl+K searches records grouped by type, filters by type and opens a hit', async ({
    page,
  }) => {
    const api = await Api.create();
    const invoices = await api.list('Invoice', { pageSize: '1', sort: '-txn_date' });
    const inv = invoices.items[0]!;
    const customer = String(
      (inv.data.CustomerRef as { FullName?: string } | undefined)?.FullName ?? inv.name,
    );
    // The first word of the customer's name finds the customer and its invoices.
    const word = customer.split(/[\s:]+/)[0]!;

    await page.goto('/');
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Search' });
    await expect(dialog).toBeVisible();
    await page.getByLabel('Search text').fill(word);

    const types = dialog.getByRole('navigation', { name: 'Record types' });
    await expect(types.getByRole('button', { name: /^Customers \d+/ })).toBeVisible();
    await expect(types.getByRole('button', { name: /^Invoices \d+/ })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: /^Customers/ })).toBeVisible();

    // Narrow to invoices: other groups disappear.
    await types.getByRole('button', { name: /^Invoices \d+/ }).click();
    await expect(dialog.getByRole('heading', { name: /^Customers/ })).toHaveCount(0);
    await expect(
      dialog.getByRole('listbox', { name: 'Results' }).getByRole('option').first(),
    ).toContainText('Invoice');

    // Enter opens the highlighted invoice.
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/objects\/Invoice\/[^/]+$/);
    await api.dispose();
  });

  test('menu items are searchable and Escape closes', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Search' });
    await page.getByLabel('Search text').fill('report');
    await expect(dialog.getByRole('heading', { name: 'Menus' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('filters alone (date range) list transactions without search text', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Search (Ctrl+K)' }).click();
    const dialog = page.getByRole('dialog', { name: 'Search' });
    await dialog.getByRole('button', { name: 'Filters' }).click();
    await dialog.getByLabel('Date preset').selectOption('Last year');
    await expect(dialog.getByRole('navigation', { name: 'Record types' })).toBeVisible();
    await expect(
      dialog.getByRole('listbox', { name: 'Results' }).getByRole('option').first(),
    ).toBeVisible();
  });
});
