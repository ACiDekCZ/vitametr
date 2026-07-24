import { expect, test, type Page } from '@playwright/test';

/**
 * Import page (redesign IA, screen 1): the first-class Import route with a
 * dropzone (auto-detect) and a per-format card grid behind the segmented
 * control. A format card opens a hidden file picker and runs the same import
 * logic that used to live in Settings.
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

test('Import page: dropzone, format grid and a CSV card route to mapping', async ({ page }) => {
  const errors = trackErrors(page);

  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  // Import is a first-class nav destination.
  await page.evaluate(() => { window.location.hash = '#/import'; });
  await expect(page).toHaveURL(/#\/import$/);

  // Automatic mode shows only the dropzone; the format grid is hidden.
  await expect(page.locator('.import-dropzone')).toBeVisible();
  await expect(page.locator('.import-format-grid')).toBeHidden();

  // The "Known metrics only" switch toggles in place (no re-render/navigation).
  const knownSwitch = page.locator('.import-known-row .switch');
  await expect(knownSwitch).toHaveAttribute('aria-checked', 'false');
  await knownSwitch.click();
  await expect(knownSwitch).toHaveAttribute('aria-checked', 'true');

  // Specific format reveals the card grid.
  await page.getByRole('button', { name: 'Specific format' }).click();
  await expect(page.locator('.import-format-grid')).toBeVisible();

  // The CSV card opens a hidden file picker and routes to the mapping screen.
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.format-card', { hasText: 'CSV table' }).click(),
  ]);
  await chooser.setFiles('test/fixtures/labs/cz/lab-cs-semicolon.csv');
  await expect(page).toHaveURL(/#\/import-csv$/, { timeout: 20000 });

  expect(errors, errors.join('\n')).toEqual([]);
});
