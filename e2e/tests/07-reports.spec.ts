import { expect, test } from '@playwright/test';
import { Api } from './helpers.js';

test.describe('reports', () => {
  test('catalog lists both kinds of report', async ({ page }) => {
    await page.goto('/reports');
    await expect(page.getByRole('link', { name: /A\/R Aging Summary/ }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /Profit & Loss Standard/ }).first()).toBeVisible();
  });

  test('an instant (SQL) report renders from the read model', async ({ page }) => {
    await page.goto('/reports/ar-aging-summary');
    const table = page.locator('table.report-table');
    await expect(table).toBeVisible();
    await expect(table.locator('tbody tr').first()).toBeVisible();
    await expect(table).toContainText('TOTAL');
  });

  test('a QuickBooks report (P&L) is fetched through the queue and renders', async ({ page }) => {
    await page.goto('/reports/GeneralSummary.ProfitAndLossStandard');
    // Whole seeded year, so there are figures to show.
    await page.getByLabel('From', { exact: true }).fill('2025-11-01');
    await page.getByLabel('To', { exact: true }).fill('2026-10-31');
    await page.getByRole('button', { name: 'Run report' }).click();
    const table = page.locator('table.report-table');
    await expect(table).toBeVisible({ timeout: 45_000 });
    await expect(table).toContainText('Income');
    await expect(table).toContainText(/Net Income/i);

    // Refresh skips the cache and asks QuickBooks again.
    await page.getByRole('button', { name: 'Refresh from QuickBooks' }).click();
    await expect(table).toBeVisible({ timeout: 45_000 });
    await expect(table).toContainText(/Net Income/i);

    // The API agrees, and a second identical request is served from the cache.
    const api = await Api.create();
    const params = { from: '2025-11-01', to: '2026-10-31' };
    const res = await api.ctx.get('/api/reports/GeneralSummary.ProfitAndLossStandard', { params });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      status: string;
      rows: unknown[];
      meta: { cached?: boolean; fromCache?: boolean };
    };
    expect(body.status).toBe('ready');
    expect(body.rows.length).toBeGreaterThan(5);
    expect(body.meta.cached ?? body.meta.fromCache).toBe(true);
    await api.dispose();
  });
});
