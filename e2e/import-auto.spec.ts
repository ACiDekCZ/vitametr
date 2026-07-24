import { expect, test, type Page } from '@playwright/test';
import { reachReview } from './support/pass-import-filter';

/** Auto-detect: the single "Import a file" entry routes by detected format. */

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

test('auto-detect routes a FHIR bundle to review without picking a format', async ({ page }) => {
  const errors = trackErrors(page);

  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();
  await page.evaluate(() => { window.location.hash = '#/import'; });
  await expect(page).toHaveURL(/#\/import$/);

  // Use the auto-detect dropzone (not a specific-format card).
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.import-dropzone').click(),
  ]);
  await chooser.setFiles('test/fixtures/fhir-bundle.json');

  await reachReview(page);
  await page.getByRole('button', { name: /Import selected/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('auto-detect routes a CSV to the column-mapping screen', async ({ page }) => {
  const errors = trackErrors(page);

  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();
  await page.evaluate(() => { window.location.hash = '#/import'; });
  await expect(page).toHaveURL(/#\/import$/);

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.import-dropzone').click(),
  ]);
  await chooser.setFiles('test/fixtures/labs/cz/lab-cs-semicolon.csv');

  // CSV goes to the mapping screen, not straight to review.
  await expect(page).toHaveURL(/#\/import-csv$/, { timeout: 20000 });

  expect(errors, errors.join('\n')).toEqual([]);
});
