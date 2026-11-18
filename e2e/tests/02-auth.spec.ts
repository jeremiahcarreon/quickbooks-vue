import { expect, test } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD } from './env.js';

test.describe('login', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('rejects a wrong password and signs in with the right one', async ({ page }) => {
    await page.goto('/objects/Customer');
    await expect(page).toHaveURL(/\/login\?redirect=/);

    await page.locator('#login-email').fill(ADMIN_EMAIL);
    await page.locator('#login-password').fill('definitely-not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText(/wrong email or password/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);

    await page.locator('#login-password').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    // Lands on the page it was sent from, with the shell and synced data.
    await expect(page).toHaveURL(/\/objects\/Customer$/);
    await expect(
      page.getByRole('heading', { name: 'Customers', exact: true }).first(),
    ).toBeVisible();
    await expect(page.locator('main tbody tr').first()).toBeVisible();

    // The session survives a reload (GET /auth/me).
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Customers', exact: true }).first(),
    ).toBeVisible();
  });
});
