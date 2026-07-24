import { expect, test, type Page } from '@playwright/test';
import { reachReview } from './support/pass-import-filter';

/**
 * Phase 2: import a CSV via the Import page → column mapping → review → overview.
 * Uses the synthetic Czech-style fixture (semicolon, decimal comma, DD.MM.YYYY).
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

test('CSV import: map columns, review, and see values in overview', async ({ page }) => {
  const errors = trackErrors(page);

  // Onboard without encryption.
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  // Import page → Specific format → the CSV card opens a file picker.
  await page.evaluate(() => { window.location.hash = '#/import'; });
  await page.getByRole('button', { name: 'Specific format' }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.format-card', { hasText: 'CSV table' }).click(),
  ]);
  await chooser.setFiles('test/fixtures/labs/cz/lab-cs-semicolon.csv');

  // Column-mapping screen: format + mapping were pre-filled.
  await expect(page).toHaveURL(/#\/import-csv$/);
  await expect(page.locator('.csv-mapping')).toBeVisible();
  await page.getByRole('button', { name: /Continue to review/ }).click();

  // Review screen → import.
  await reachReview(page);
  await page.getByRole('button', { name: /Import selected/ }).click();

  // Overview shows an imported metric.
  await expect(page).toHaveURL(/#\/overview$/);
  await expect(
    page.locator('.app-content button').filter({ hasText: 'Glucose' }).first(),
  ).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});
