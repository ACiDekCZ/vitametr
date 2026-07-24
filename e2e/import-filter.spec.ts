import { expect, test, type Page } from '@playwright/test';

/**
 * Generic pre-import filter ("What to import"): a large import (here a 60-row CSV
 * spanning 2021–2024, three metrics) is routed through the filter step between
 * parse and review, where the period and the per-metric selection narrow the
 * batch before review. A small import skips the step entirely (covered by
 * csv-import.spec, re-asserted here).
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

/** Onboard, import a CSV fixture, land on the column-mapping screen and Continue. */
async function importCsvToMapping(page: Page, fixture: string): Promise<void> {
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();
  await page.evaluate(() => {
    window.location.hash = '#/import';
  });
  await page.getByRole('button', { name: 'Specific format' }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.format-card', { hasText: 'CSV table' }).click(),
  ]);
  await chooser.setFiles(fixture);
  await expect(page).toHaveURL(/#\/import-csv$/);
  await expect(page.locator('.csv-mapping')).toBeVisible();
  await page.getByRole('button', { name: /Continue to review/ }).click();
}

test('large import: filter by period + metric, then review only the kept items', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await importCsvToMapping(page, 'test/fixtures/labs/cz/lab-cs-large.csv');

  // A large batch routes to the "What to import" step (not straight to review).
  await expect(page).toHaveURL(/#\/import-filter$/);
  await expect(page.getByRole('heading', { name: 'What to import' })).toBeVisible();

  const cta = page.locator('.import-filter-continue');
  await expect(cta).toHaveText(/Continue to review \(60\)/);

  // Narrowing the period lowers the count (all data predates last year → 0).
  await page.locator('.import-filter-segment-btn', { hasText: 'Last year' }).click();
  await expect(cta).toHaveText(/Continue to review \(0\)/);
  await expect(cta).toBeDisabled();
  // Back to All.
  await page.locator('.import-filter-segment-btn', { hasText: 'All' }).click();
  await expect(cta).toHaveText(/Continue to review \(60\)/);

  // Unchecking a metric (20 Creatinine rows) drops the count to 40.
  await page
    .locator('.import-filter-row', { hasText: 'Creatinine' })
    .getByRole('checkbox')
    .uncheck();
  await expect(cta).toHaveText(/Continue to review \(40\)/);

  // Continue → review shows only the kept 40 items, no Creatinine.
  await cta.click();
  await expect(page).toHaveURL(/#\/review$/);
  await expect(page.locator('.review-item')).toHaveCount(40);
  await expect(page.locator('.review-item', { hasText: 'Creatinine' })).toHaveCount(0);
  await expect(page.locator('.review-item', { hasText: 'Glucose' }).first()).toBeVisible();

  // Import and confirm the narrowed set lands.
  await page.getByRole('button', { name: /Import selected/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('cancelling the filter imports nothing', async ({ page }) => {
  const errors = trackErrors(page);
  await importCsvToMapping(page, 'test/fixtures/labs/cz/lab-cs-large.csv');
  await expect(page).toHaveURL(/#\/import-filter$/);

  await page.getByRole('button', { name: 'Cancel import' }).click();
  await expect(page).toHaveURL(/#\/import$/);

  // Nothing was stored: the overview shows no imported metric.
  await page.evaluate(() => {
    window.location.hash = '#/overview';
  });
  await expect(page).toHaveURL(/#\/overview$/);
  await expect(
    page.locator('.app-content button').filter({ hasText: 'Glucose' }),
  ).toHaveCount(0);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('small import skips the filter and goes straight to review', async ({ page }) => {
  const errors = trackErrors(page);
  await importCsvToMapping(page, 'test/fixtures/labs/cz/lab-cs-small.csv');

  // A small batch is not worth filtering — straight to review.
  await expect(page).toHaveURL(/#\/review$/);

  expect(errors, errors.join('\n')).toEqual([]);
});
