import { expect, test, type Page } from '@playwright/test';

/**
 * A metric pack (data-driven) defines metrics of every value kind and brings
 * sample values. Importing it auto-detects the format, registers the metrics
 * and lands the number/text/enum/multi values in the overview.
 */

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

test('a metric pack registers metrics and shows all value types', async ({ page }) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();
  await page.evaluate(() => { window.location.hash = '#/import'; });
  await expect(page).toHaveURL(/#\/import$/);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.import-dropzone').click(),
  ]);
  await chooser.setFiles('test/fixtures/demo-pack.json');

  await expect(page).toHaveURL(/#\/review$/, { timeout: 20000 });
  await page.getByRole('button', { name: /Import selected/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);

  // Every value kind shows: number card, free text, enum, multi (joined).
  await expect(page.getByText('Demo glukóza').first()).toBeVisible();
  await expect(page.getByText('cítím se dobře').first()).toBeVisible();
  await expect(page.getByText('negativní').first()).toBeVisible();
  await expect(page.getByText('únava, bolest hlavy').first()).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});
