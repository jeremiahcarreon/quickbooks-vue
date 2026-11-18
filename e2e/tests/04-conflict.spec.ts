import { expect, test } from '@playwright/test';
import { RUN_ID } from './env.js';
import { Api } from './helpers.js';

test.describe('conflicting edits', () => {
  test('a stale edit becomes a conflict with a field diff, and reapply saves it', async ({
    page,
  }) => {
    const api = await Api.create();
    const name = `E2E Conflict ${RUN_ID}`;
    const add = await api.add('Customer', {
      Name: name,
      CompanyName: 'Original Co',
      Phone: '555-0100',
    });
    const id = add.objectId!;

    // Open the edit form on the current version...
    await page.goto(`/objects/Customer/${encodeURIComponent(id)}/edit`);
    await expect(page.locator('#fld-CompanyName')).toHaveValue('Original Co');

    // ...someone else changes the customer in QuickBooks meanwhile...
    const current = await api.get('Customer', id);
    const other = await api.mod('Customer', id, {
      EditSequence: current!.editSequence,
      CompanyName: 'Changed Elsewhere Co',
    });
    expect(other.status).toBe('succeeded');

    // ...and our save, carrying the old EditSequence, is refused by QuickBooks (3200).
    await page.locator('#fld-Phone').fill('555-0199');
    await page.getByRole('button', { name: 'Save changes' }).click();
    const diff = page.locator('.conflict-diff');
    await expect(diff).toBeVisible({ timeout: 30_000 });
    await expect(diff.getByText(/changed this .* in QuickBooks/i)).toBeVisible();
    await expect(diff.locator('tr[data-path="Phone"]')).toContainText('555-0199');

    // Reload and reapply: the form now carries the latest version plus our change.
    await diff.getByRole('button', { name: 'Reload and reapply' }).click();
    await expect(page.locator('#fld-Phone')).toHaveValue('555-0199');
    await expect(page.locator('#fld-CompanyName')).toHaveValue('Changed Elsewhere Co');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page).toHaveURL(new RegExp(`/objects/Customer/${encodeURIComponent(id)}$`), {
      timeout: 30_000,
    });
    await expect
      .poll(async () => {
        const o = await api.get('Customer', id);
        return [o?.data.Phone, o?.data.CompanyName];
      })
      .toEqual(['555-0199', 'Changed Elsewhere Co']);

    // The conflict is recorded on the command.
    const cmds = await api.ctx.get('/api/commands', {
      params: { status: 'conflict', pageSize: '5' },
    });
    const list = (await cmds.json()) as {
      items: { objectId: string | null; statusCode: number }[];
    };
    expect(list.items.some((c) => c.objectId === id && c.statusCode === 3200)).toBe(true);
    await api.dispose();
  });
});
