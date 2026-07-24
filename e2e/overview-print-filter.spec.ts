import { expect, test, type Page } from '@playwright/test';

/**
 * Filter-aware "Summary / print". With no overview filter the header button opens
 * the full report straight away. Under an active filter (search and/or a tag) it
 * shows the filtered count, gains an accent-soft highlight, and opens a small menu
 * offering "Only filtered (n)" vs "All metrics (total)". Choosing "only filtered"
 * carries the subset to the report (a "Summary — {tag}" title, only those metrics);
 * "all" builds the full report. A 0-result filter disables the only-filtered
 * choice. The subset composes with the as-of snapshot. English default locale.
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

async function addValue(page: Page, metric: string, value: string): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/entry';
  });
  const metricInput = page.getByLabel('Metric', { exact: true }).first();
  await metricInput.fill(metric);
  await metricInput.press('Enter');
  await page.getByLabel('Value', { exact: true }).first().fill(value);
  await page.getByRole('button', { name: /^Add$/ }).click();
}

async function seed(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();
  await addValue(page, 'Glucose', '5.4'); // tags: blood, diabetes
  await addValue(page, 'Hemoglobin', '140'); // tags: blood, cbc
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
}

const summaryBtn = (page: Page) => page.locator('.overview-summary-btn');

test('no filter → the button opens the full report directly, no menu', async ({ page }) => {
  const errors = trackErrors(page);
  await seed(page);

  await expect(summaryBtn(page)).toHaveText('Summary / print');
  await expect(summaryBtn(page)).not.toHaveClass(/is-filter/);

  await summaryBtn(page).click();
  await expect(page).toHaveURL(/#\/report$/);
  await expect(page.locator('.overview-print-menu')).toHaveCount(0);
  await expect(page.locator('.report h1')).toHaveText('Health summary');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('a tag filter → count + highlight, menu, and "only filtered" carries the subset', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await seed(page);

  // Filter by the Diabetes tag (only Glucose carries it).
  await page.locator('.overview-tag-filter .tag-chip', { hasText: 'Diabetes' }).click();
  await expect(summaryBtn(page)).toHaveText('Summary / print (1)');
  await expect(summaryBtn(page)).toHaveClass(/is-filter/);

  // The menu offers only-filtered (highlighted) and all.
  await summaryBtn(page).click();
  const menu = page.locator('.overview-print-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Only filtered (1)' })).toBeVisible();
  await expect(menu.getByRole('button', { name: 'All metrics (2)' })).toBeVisible();

  // Only filtered → the report is restricted to Glucose, titled "Summary — Diabetes".
  await menu.getByRole('button', { name: 'Only filtered (1)' }).click();
  await expect(page).toHaveURL(/#\/report$/);
  await expect(page.locator('.report h1')).toHaveText('Summary — Diabetes');
  await expect(page.locator('.report-section')).toContainText('Glucose');
  await expect(page.locator('.report-section')).not.toContainText('Hemoglobin');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('"all metrics" builds the full report despite an active filter', async ({ page }) => {
  const errors = trackErrors(page);
  await seed(page);

  await page.locator('.overview-tag-filter .tag-chip', { hasText: 'Diabetes' }).click();
  await summaryBtn(page).click();
  await page
    .locator('.overview-print-menu')
    .getByRole('button', { name: 'All metrics (2)' })
    .click();

  await expect(page.locator('.report h1')).toHaveText('Health summary');
  await expect(page.locator('.report-section')).toContainText('Glucose');
  await expect(page.locator('.report-section')).toContainText('Hemoglobin');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('a 0-result filter disables "only filtered" but "all metrics" still works', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await seed(page);

  await page.locator('.overview-search').fill('zzz-no-such-metric');
  await expect(summaryBtn(page)).toHaveText('Summary / print (0)');

  await summaryBtn(page).click();
  const menu = page.locator('.overview-print-menu');
  await expect(menu.getByRole('button', { name: 'Only filtered (0)' })).toBeDisabled();

  await menu.getByRole('button', { name: 'All metrics (2)' }).click();
  await expect(page.locator('.report h1')).toHaveText('Health summary');
  await expect(page.locator('.report-section')).toContainText('Glucose');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the subset composes with the as-of snapshot in the title', async ({ page }) => {
  const errors = trackErrors(page);
  await seed(page);

  // Enter snapshot mode at a past date, then filter by the Diabetes tag.
  await page.getByRole('button', { name: 'As of date' }).click();
  await page.getByLabel('As-of date').fill('2025-06-01');
  await page.locator('.overview-tag-filter .tag-chip', { hasText: 'Diabetes' }).click();

  await summaryBtn(page).click();
  await page
    .locator('.overview-print-menu')
    .getByRole('button', { name: 'Only filtered (1)' })
    .click();

  await expect(page).toHaveURL(/#\/report\/2025-06-01$/);
  await expect(page.locator('.report h1')).toContainText('State as of');
  await expect(page.locator('.report h1')).toContainText('— Diabetes');

  expect(errors, errors.join('\n')).toEqual([]);
});
