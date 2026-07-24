import { expect, test, type Page } from '@playwright/test';

/**
 * Declarative import mappings — the "external plugin" path. A user imports a
 * JSON pack that carries a data-only text/line parser (regex, no code), then a
 * matching synthetic .txt is auto-detected and its analytes land in review.
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

test('an imported declarative mapping recognises a matching text file', async ({ page }) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();
  await page.evaluate(() => { window.location.hash = '#/import'; });
  await expect(page).toHaveURL(/#\/import$/);

  // 1. Import the mapping-only pack — it registers the parser and toasts.
  const [packChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.import-dropzone').click(),
  ]);
  await packChooser.setFiles('packs/example-import-mapping.json');
  await expect(page.locator('.toast')).toContainText(/import mappings added/i);

  // 2. Import a synthetic text sheet — auto-detected via the mapping, not CSV.
  const [txtChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.import-dropzone').click(),
  ]);
  await txtChooser.setFiles('test/fixtures/example-lab-text.txt');

  await expect(page).toHaveURL(/#\/review$/, { timeout: 20000 });
  await page.getByRole('button', { name: /Import selected/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);

  // The mapped analytes are now stored.
  await expect(page.getByText('Glucose').first()).toBeVisible();
  await expect(page.getByText('Creatinine').first()).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});
