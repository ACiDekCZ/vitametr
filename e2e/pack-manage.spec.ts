import { expect, test, type Page } from '@playwright/test';

/** Installed packs are listed and can be removed as a unit. */

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    for (const db of (await indexedDB.databases?.()) ?? []) {
      if (db.name) indexedDB.deleteDatabase(db.name);
    }
  });
  await page.goto('/');
});

test('an imported pack is listed and can be removed', async ({ page }) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await page.evaluate(() => { window.location.hash = '#/import'; });
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.import-dropzone').click(),
  ]);
  await chooser.setFiles('test/fixtures/demo-pack.json');
  await expect(page).toHaveURL(/#\/review$/, { timeout: 20000 });
  await page.getByRole('button', { name: /Import selected/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);

  // The pack shows under "Installed packs" on the Metrics page.
  await page.locator('.app-nav').getByRole('button', { name: 'Metrics' }).click();
  await expect(page.getByText('demo-all-types')).toBeVisible();

  // Remove it (idle button → inline confirm → confirm).
  await page.getByRole('button', { name: 'Remove pack' }).click();
  await page.getByRole('button', { name: 'Remove pack' }).click();
  await expect(page.getByText('Pack removed')).toBeVisible();

  // Its metrics and values are gone.
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
  await expect(page.getByText('Demo glukóza')).toHaveCount(0);

  expect(errors, errors.join('\n')).toEqual([]);
});
