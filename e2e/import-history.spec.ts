import { expect, test, type Page } from '@playwright/test';
import { reachReview } from './support/pass-import-filter';

/**
 * Import history: a committed file import appears as a "Recent imports" row on
 * the Import page with the right measurement count and the file name. Undo
 * removes the imported values (overview goes back to empty) and the row goes.
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

/**
 * Import the Czech CSV fixture whose "PDW - distr. křivka trombo" row is
 * unresolved, create a new custom metric from it, and commit — leaving one
 * recorded import that created exactly one custom metric. Returns to the Import
 * page ready to undo.
 */
async function importCreatingCustomMetric(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await page.evaluate(() => { window.location.hash = '#/import'; });
  await page.getByRole('button', { name: 'Specific format' }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.format-card', { hasText: 'CSV table' }).click(),
  ]);
  await chooser.setFiles('test/fixtures/labs/cz/lab-cs-unresolved-fl.csv');
  await expect(page).toHaveURL(/#\/import-csv$/);
  await page.getByRole('button', { name: /Continue to review/ }).click();
  await expect(page).toHaveURL(/#\/review$/);

  // Create a brand-new custom metric from the unresolved row's raw name.
  const card = page.locator('.review-item--unresolved');
  await card.locator('.review-create-direct').click();
  await expect(card.locator('.review-create-name')).toHaveValue('PDW - distr. křivka trombo');
  await card.getByRole('button', { name: /^Add$/ }).click();
  await expect(page.locator('.review-item--unresolved')).toHaveCount(0);

  await page.getByRole('button', { name: /Import selected/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);

  await page.evaluate(() => { window.location.hash = '#/import'; });
  await expect(page.locator('.import-history-row')).toHaveCount(1);
}

/** Whether the custom metric created above is present under the Custom filter. */
async function customMetricPresent(page: Page): Promise<boolean> {
  await page.evaluate(() => { window.location.hash = '#/metrics-manage'; });
  await expect(page).toHaveURL(/#\/metrics-manage$/);
  await page.getByRole('button', { name: 'Custom' }).click();
  const row = page.locator('.metric-row-wrap').filter({ hasText: 'PDW - distr. křivka trombo' });
  return (await row.count()) > 0;
}

test('undo with "also remove metrics" checked removes the values AND the created metric', async ({ page }) => {
  const errors = trackErrors(page);
  await importCreatingCustomMetric(page);

  const row = page.locator('.import-history-row');
  await row.getByRole('button', { name: 'Undo' }).click();

  // The opt-in appears because the import created a now-unused custom metric.
  const alsoMetrics = row.locator('.import-history-also-metrics');
  await expect(alsoMetrics).toBeVisible();
  await alsoMetrics.locator('input[type="checkbox"]').check();

  await row.getByRole('button', { name: 'Undo' }).click();

  // Values gone (empty history) and the created metric is gone too.
  await expect(page.locator('.import-history-empty')).toBeVisible();
  expect(await customMetricPresent(page)).toBe(false);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('undo leaving the box unchecked removes the values but keeps the created metric', async ({ page }) => {
  const errors = trackErrors(page);
  await importCreatingCustomMetric(page);

  const row = page.locator('.import-history-row');
  await row.getByRole('button', { name: 'Undo' }).click();
  // Leave the checkbox unchecked (default) and confirm.
  await expect(row.locator('.import-history-also-metrics')).toBeVisible();
  await row.getByRole('button', { name: 'Undo' }).click();

  // Values gone, but the custom metric remains in the catalog.
  await expect(page.locator('.import-history-empty')).toBeVisible();
  expect(await customMetricPresent(page)).toBe(true);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('a file import is recorded and can be undone from the Import page', async ({ page }) => {
  const errors = trackErrors(page);

  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();
  await page.evaluate(() => { window.location.hash = '#/import'; });
  await expect(page).toHaveURL(/#\/import$/);

  // Empty state before any import.
  await expect(page.locator('.import-history-empty')).toBeVisible();

  // Auto-detect a FHIR bundle → review.
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.import-dropzone').click(),
  ]);
  await chooser.setFiles('test/fixtures/fhir-bundle.json');
  await reachReview(page);

  // How many rows will actually be committed (resolved + accepted).
  const committable = Number(await page.locator('.review-count').textContent());
  expect(committable).toBeGreaterThan(0);

  await page.getByRole('button', { name: /Import selected/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);

  // Overview now shows metric entries (grid card or list row, per layout).
  await expect(page.locator('.metric-card, .overview-row').first()).toBeVisible();

  // Import page shows exactly one recent-import row with the right count + file.
  await page.evaluate(() => { window.location.hash = '#/import'; });
  const rows = page.locator('.import-history-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('fhir-bundle.json');
  await expect(rows.first()).toContainText(`${committable} values`);

  // Undo: inline double-confirm, then the values and the row are gone.
  await rows.first().getByRole('button', { name: 'Undo' }).click();
  await rows.first().getByRole('button', { name: 'Undo' }).click();

  await expect(page.locator('.import-history-empty')).toBeVisible();
  await expect(page.locator('.import-history-row')).toHaveCount(0);

  // Overview no longer has any measurement-backed metric entries.
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
  await expect(page.locator('.metric-card, .overview-row')).toHaveCount(0);

  expect(errors, errors.join('\n')).toEqual([]);
});
