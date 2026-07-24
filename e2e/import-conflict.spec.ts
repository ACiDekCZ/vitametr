import { expect, test, type Page } from '@playwright/test';

/**
 * Import conflict resolution: importing a different-valued reading for a metric
 * at an instant that already has a stored value must surface a CONFLICT on the
 * review screen (not silently create a duplicate that fakes a trend). The user
 * picks which to keep.
 *
 * Two synthetic single-row CSVs share one metric (Glucose) and one date but
 * differ in value (5.4 vs 6.9 mmol/l). Scenario 1 keeps the new value → a single
 * updated reading. Scenario 2 keeps both → two readings at the same instant.
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

/** Pick a CSV on the Import page and advance through mapping to the review screen. */
async function importCsvToReview(page: Page, fixture: string): Promise<void> {
  await page.evaluate(() => { window.location.hash = '#/import'; });
  await expect(page).toHaveURL(/#\/import$/);
  await page.getByRole('button', { name: 'Specific format' }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.format-card', { hasText: 'CSV table' }).click(),
  ]);
  await chooser.setFiles(fixture);
  await expect(page).toHaveURL(/#\/import-csv$/);
  await expect(page.locator('.csv-mapping')).toBeVisible();
  await page.getByRole('button', { name: /Continue to review/ }).click();
  await expect(page).toHaveURL(/#\/review$/);
}

/** How many Glucose readings the metric-detail list shows. */
async function glucoseReadingCount(page: Page): Promise<number> {
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
  await page
    .locator('.overview-content button')
    .filter({ hasText: 'Glucose' })
    .first()
    .click();
  await expect(page).toHaveURL(/#\/metric/);
  await expect(page.locator('.metric-list-heading')).toBeVisible();
  return page.locator('.metric-row').count();
}

test('stored×import: both values + type badges; keep-new default keeps the new one', async ({ page }) => {
  const errors = trackErrors(page);

  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  // Display in SI so the detail shows the fixtures' stated unit (mmol/l); the
  // display unit is governed solely by the global system (no per-metric switch).
  await page.locator('.app-nav').getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /^SI/ }).click();

  // First import: 5.4 at 14.02.2023 — no conflict yet.
  await importCsvToReview(page, 'test/fixtures/conflict-glucose-a.csv');
  await expect(page.locator('.review-conflict')).toHaveCount(0);
  await page.getByRole('button', { name: /Import selected/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);

  // Second import: 6.9 at the SAME instant — a stored×import conflict appears.
  await importCsvToReview(page, 'test/fixtures/conflict-glucose-b.csv');
  const conflict = page.locator('.review-conflict');
  await expect(conflict).toHaveCount(1);
  // Both competing values are shown side by side, with type-aware badges.
  await expect(conflict.locator('.review-conflict-badge', { hasText: 'New from import' })).toBeVisible();
  await expect(conflict.locator('.review-conflict-badge', { hasText: 'Already stored' })).toBeVisible();
  await expect(conflict).toContainText('6.9');
  await expect(conflict).toContainText('5.4');

  // No explicit choice → the keep-new default applies at import.
  await page.getByRole('button', { name: /Import selected/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);

  // Exactly one Glucose reading remains — the updated one, not two points.
  expect(await glucoseReadingCount(page)).toBe(1);
  // The kept value is the new 6.9 (SI display ⇒ mmol/l, matching the fixtures).
  await expect(page.locator('.metric-row-value')).toContainText('6.9');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('keep-both stores both values at the same instant', async ({ page }) => {
  const errors = trackErrors(page);

  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await importCsvToReview(page, 'test/fixtures/conflict-glucose-a.csv');
  await page.getByRole('button', { name: /Import selected/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);

  await importCsvToReview(page, 'test/fixtures/conflict-glucose-b.csv');
  await expect(page.locator('.review-conflict')).toHaveCount(1);
  await page.locator('.review-conflict-keep-both').click();
  // The card collapses to a decision summary with a Change control.
  await expect(page.locator('.review-conflict-summary')).toBeVisible();
  await expect(page.locator('.review-conflict-change')).toBeVisible();
  await page.getByRole('button', { name: /Import selected/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);

  // Both readings are kept at the same instant.
  expect(await glucoseReadingCount(page)).toBe(2);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('import×import: both occurrences, no "current"; keep-this on the second stores it', async ({ page }) => {
  const errors = trackErrors(page);

  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await page.locator('.app-nav').getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /^SI/ }).click();

  // One file states the same metric+instant two ways (5.4 then 6.9): a
  // within-import conflict — nothing is stored yet, so "current"/"stored" copy
  // must never appear.
  await importCsvToReview(page, 'test/fixtures/conflict-glucose-import-import.csv');
  const conflict = page.locator('.review-conflict');
  await expect(conflict).toHaveCount(1);
  await expect(conflict.locator('.review-conflict-badge').filter({ hasText: 'occurrence' })).toHaveCount(2);
  await expect(conflict).toContainText('5.4');
  await expect(conflict).toContainText('6.9');
  // No stored value exists ⇒ never the "current"/"stored" wording.
  await expect(conflict).not.toContainText('Already stored');
  await expect(conflict).not.toContainText('Keep current');

  // "Keep this" under the SECOND occurrence keeps 6.9 (not the default first).
  await conflict.locator('.review-conflict-block--second .review-conflict-keep-this').click();
  await expect(page.locator('.review-conflict-summary')).toContainText('6.9');
  await page.getByRole('button', { name: /Import selected/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);

  expect(await glucoseReadingCount(page)).toBe(1);
  await expect(page.locator('.metric-row-value')).toContainText('6.9');

  expect(errors, errors.join('\n')).toEqual([]);
});

/** Create a profile and switch the display system to SI (fixtures state mmol/l). */
async function newProfileInSI(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();
  await page.locator('.app-nav').getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /^SI/ }).click();
}

test('N-way: one conflict with 5 values collapses to 3 + show more; keep latest stores the last', async ({ page }) => {
  const errors = trackErrors(page);
  await newProfileInSI(page);

  // One file states Glucose at one instant five ways (5.0 … 6.9): a single
  // import×import conflict with five competing occurrences.
  await importCsvToReview(page, 'test/fixtures/conflict-glucose-nway.csv');
  const conflict = page.locator('.review-conflict');
  await expect(conflict).toHaveCount(1);

  // >4 values: the first three blocks show, the rest hide behind "show more".
  await expect(conflict.locator('.review-conflict-block:visible')).toHaveCount(3);
  const showMore = conflict.locator('.review-conflict-show-more');
  await expect(showMore).toContainText('Show 2 more values');
  await showMore.click();
  await expect(conflict.locator('.review-conflict-block:visible')).toHaveCount(5);
  await expect(showMore).toHaveCount(0);

  // "Keep the last from the import" keeps the last occurrence in file order (6.9).
  await conflict.locator('.review-conflict-keep-latest').click();
  await expect(page.locator('.review-conflict-summary')).toContainText('6.9');
  await page.getByRole('button', { name: /Import selected/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);

  expect(await glucoseReadingCount(page)).toBe(1);
  await expect(page.locator('.metric-row-value')).toContainText('6.9');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('N-way: keep all stores every competing value at the instant', async ({ page }) => {
  const errors = trackErrors(page);
  await newProfileInSI(page);

  await importCsvToReview(page, 'test/fixtures/conflict-glucose-nway.csv');
  const conflict = page.locator('.review-conflict');
  await expect(conflict).toHaveCount(1);
  // "Keep all (5)" keeps every distinct value at the same instant.
  const keepAll = conflict.locator('.review-conflict-keep-both');
  await expect(keepAll).toContainText('Keep all (5)');
  await keepAll.click();
  await expect(page.locator('.review-conflict-summary')).toBeVisible();
  await page.getByRole('button', { name: /Import selected/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);

  expect(await glucoseReadingCount(page)).toBe(5);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('grouping: same metric across 2 conflicts — bulk keep-new resolves undecided, individual choice survives', async ({ page }) => {
  const errors = trackErrors(page);
  await newProfileInSI(page);

  // Glucose at two instants, each stated two ways → two conflicts for one metric.
  await importCsvToReview(page, 'test/fixtures/conflict-glucose-multi.csv');
  await expect(page.locator('.review-conflict')).toHaveCount(2);

  // The metric gets a group header with the conflict count + bulk actions.
  const header = page.locator('.review-conflict-group');
  await expect(header).toHaveCount(1);
  await expect(header.locator('.review-conflict-group-title')).toContainText('2 conflicts');

  // Decide the FIRST conflict individually: keep its second occurrence (6.9).
  const first = page.locator('.review-conflict').first();
  await first.locator('.review-conflict-block--second .review-conflict-keep-this').click();
  await expect(first.locator('.review-conflict-summary')).toContainText('6.9');

  // Bulk "keep new for all": a two-step confirm applies to the 1 undecided card.
  await header.locator('.review-bulk-keep-new').click();
  await expect(header.locator('.review-bulk-confirm-q')).toContainText('Apply to 1 conflict?');
  await header.locator('.review-bulk-confirm-yes').click();

  // Both conflicts are now decided; the individually-decided one still shows 6.9.
  await expect(page.locator('.review-conflict-summary')).toHaveCount(2);
  await expect(first.locator('.review-conflict-summary')).toContainText('6.9');

  await page.getByRole('button', { name: /Import selected/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);

  // Two readings kept: 6.9 (individual) at the first instant, 4.1 (bulk keep-new
  // = first occurrence) at the second.
  expect(await glucoseReadingCount(page)).toBe(2);
  const list = page.locator('.metric-list');
  await expect(list).toContainText('6.9');
  await expect(list).toContainText('4.1');

  expect(errors, errors.join('\n')).toEqual([]);
});
