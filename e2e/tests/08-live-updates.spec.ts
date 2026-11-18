import { expect, test } from '@playwright/test';
import { RUN_ID } from './env.js';
import { Api } from './helpers.js';

interface Received {
  event: string;
  data: Record<string, unknown>;
}

test.describe('live updates (SSE)', () => {
  test('changes made elsewhere stream to the browser and refresh open screens', async ({
    page,
  }) => {
    const api = await Api.create();
    const name = `E2E Live Vendor ${RUN_ID}`;

    await page.goto('/objects/Vendor');
    await expect(page.locator('main tbody tr').first()).toBeVisible();
    await expect(
      page.getByRole('button', { name: /relay connected; live updates on/i }),
    ).toBeVisible();

    // Listen on the same stream the app uses.
    await page.evaluate(() => {
      const w = window as unknown as { __events: Received[] };
      w.__events = [];
      const es = new EventSource('/api/events', { withCredentials: true });
      for (const t of ['command.updated', 'object.changed', 'sync.progress', 'relay.health']) {
        es.addEventListener(t, (e) => {
          w.__events.push({
            event: t,
            data: JSON.parse((e as MessageEvent<string>).data) as Record<string, unknown>,
          });
        });
      }
    });
    // Let the stream connect before the change.
    await page.waitForTimeout(500);

    const cmd = await api.add('Vendor', { Name: name });

    // The raw stream carried the command lifecycle and the object change.
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as { __events: Received[] }).__events.map((e) => e.event),
        ),
      )
      .toEqual(expect.arrayContaining(['command.updated', 'object.changed']));
    const events = await page.evaluate(
      () => (window as unknown as { __events: Received[] }).__events,
    );
    expect(
      events
        .filter((e) => e.event === 'command.updated' && e.data.id === cmd.id)
        .map((e) => e.data.status),
    ).toContain('succeeded');
    expect(
      events.some(
        (e) =>
          e.event === 'object.changed' &&
          e.data.qbId === cmd.objectId &&
          e.data.objectType === 'Vendor',
      ),
    ).toBe(true);

    // The open list reloads by itself (no navigation).
    await page
      .getByPlaceholder(/search/i)
      .first()
      .fill(RUN_ID);
    await expect(page.locator('main tbody tr', { hasText: name })).toBeVisible();
    const url = page.url();

    // A second change (rename) shows up in place too.
    const current = await api.get('Vendor', cmd.objectId!);
    await api.mod('Vendor', cmd.objectId!, {
      EditSequence: current!.editSequence,
      Name: `${name} Renamed`,
    });
    await expect(page.locator('main tbody tr', { hasText: `${name} Renamed` })).toBeVisible();
    expect(page.url()).toBe(url);
    await api.dispose();
  });
});
