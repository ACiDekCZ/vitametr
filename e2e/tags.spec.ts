import { expect, test, type Page } from '@playwright/test';

/**
 * Metric tags (phase 1): the overview groups cards under tag section headings,
 * the Metrics ("Veličiny") page filters by a tag, a metric's tags can be edited
 * inline and survive a reload, and the Settings "Use tags" switch falls the
 * overview back to a single flat list. Runs in English (Playwright default).
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
  await page.evaluate(() => { window.location.hash = '#/entry'; });
  const metricInput = page.getByLabel('Metric', { exact: true }).first();
  await metricInput.fill(metric);
  await metricInput.press('Enter');
  await page.getByLabel('Value', { exact: true }).first().fill(value);
  await page.getByRole('button', { name: /^Add$/ }).click();
}

/** Add a custom tag to a metric via the Metrics page inline editor. */
async function addCustomTag(page: Page, metricName: string, tag: string): Promise<void> {
  await page.locator('.app-nav').getByRole('button', { name: 'Metrics' }).click();
  await page.locator('.metrics-segment-btn', { hasText: 'All' }).click();
  await page.getByPlaceholder('Search metrics…').fill(metricName);
  const row = page
    .locator('.metric-row-wrap')
    .filter({ has: page.locator('.metric-row-name', { hasText: new RegExp(`^${metricName}$`) }) });
  await row.getByRole('button', { name: /Details: / }).click();
  await row.getByRole('button', { name: '+ tag' }).click();
  await row.getByPlaceholder('Tag name').fill(tag);
  await row.getByRole('button', { name: '+ tag' }).click(); // confirm ✓
  await expect(row.locator('.metric-chip-text', { hasText: tag })).toBeVisible();
  await page.waitForTimeout(700); // let the debounced write persist
}

test('overview can group each metric under every one of its tags', async ({ page }) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await addValue(page, 'Glucose', '5.4'); // tags: blood, diabetes
  await addValue(page, 'Hemoglobin', '140'); // tags: blood, cbc

  // Give both a shared custom tag; each already carries a panel tag.
  await addCustomTag(page, 'Glucose', 'sport');
  await addCustomTag(page, 'Hemoglobin', 'sport');

  // With the setting OFF (default) each metric sits under its primary panel tag,
  // so the custom "sport" tag is NOT its own overview section.
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
  await expect(page.locator('.overview-group-title', { hasText: 'Diabetes' })).toBeVisible();
  await expect(page.locator('.overview-group-title', { hasText: /^sport$/ })).toHaveCount(0);

  // Turn on "Show under every tag".
  await page.locator('.app-nav').getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('switch', { name: 'Show under every tag' }).click();

  // The overview now shows a "sport" section containing BOTH metrics.
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
  const sport = page
    .locator('.overview-group')
    .filter({ has: page.locator('.overview-group-title', { hasText: /^sport$/ }) });
  await expect(sport).toHaveCount(1);
  await expect(sport.locator('button').filter({ hasText: 'Glucose' })).toBeVisible();
  await expect(sport.locator('button').filter({ hasText: 'Hemoglobin' })).toBeVisible();

  // The panel sections still exist too (each metric appears in several sections).
  await expect(page.locator('.overview-group-title', { hasText: 'Diabetes' })).toBeVisible();
  await expect(page.locator('.overview-group-title', { hasText: 'Blood count' })).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('overview groups metric cards under tag section headings', async ({ page }) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await addValue(page, 'Glucose', '5.4'); // → Diabetes
  await addValue(page, 'Hemoglobin', '140'); // → Blood count (CBC)

  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
  await expect(page.locator('.overview-group')).toHaveCount(2);
  await expect(page.locator('.overview-group-title', { hasText: 'Diabetes' })).toBeVisible();
  await expect(page.locator('.overview-group-title', { hasText: 'Blood count' })).toBeVisible();

  // Glucose sits inside the Diabetes section.
  const diabetes = page
    .locator('.overview-group')
    .filter({ has: page.locator('.overview-group-title', { hasText: 'Diabetes' }) });
  await expect(diabetes.locator('button').filter({ hasText: 'Glucose' })).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the Metrics page filters the list by a tag', async ({ page }) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await page.locator('.app-nav').getByRole('button', { name: 'Metrics' }).click();
  await page.locator('.metrics-segment-btn', { hasText: 'All' }).click();

  // The tag filter chip row is present.
  await expect(page.locator('.metrics-tag-filter')).toBeVisible();

  // Filtering by "Kidney" keeps kidney metrics and drops Glucose (a diabetes metric).
  await page.locator('.metrics-tag-filter .tag-chip', { hasText: 'Kidney' }).click();
  await expect(page.locator('.metric-row-name', { hasText: /^Creatinine$/ })).toBeVisible();
  await expect(page.locator('.metric-row-name', { hasText: /^Glucose$/ })).toHaveCount(0);

  // Clearing the tag ("All tags") brings Glucose back.
  await page.locator('.metrics-tag-filter .tag-chip', { hasText: 'All tags' }).click();
  await page.getByPlaceholder('Search metrics…').fill('Glucose');
  await expect(page.locator('.metric-row-name', { hasText: /^Glucose$/ })).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('a metric tag can be added inline, persists across a reload, and removed', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await page.locator('.app-nav').getByRole('button', { name: 'Metrics' }).click();
  await page.locator('.metrics-segment-btn', { hasText: 'All' }).click();
  await page.getByPlaceholder('Search metrics…').fill('Waist');

  const row = page
    .locator('.metric-row-wrap')
    .filter({ has: page.locator('.metric-row-name', { hasText: /^Waist circumference$/ }) });
  await expect(row).toHaveCount(1);

  // Expand and add a custom "sport" tag.
  await row.getByRole('button', { name: /Details: / }).click();
  await row.getByRole('button', { name: '+ tag' }).click();
  await row.getByPlaceholder('Tag name').fill('sport');
  await row.getByRole('button', { name: '+ tag' }).click(); // confirm ✓ (aria-label reuses "+ tag")
  await expect(row.locator('.metric-chip-text', { hasText: 'sport' })).toBeVisible();

  // Give the debounced write time to persist, then reload.
  await page.waitForTimeout(700);
  await page.reload();

  await page.locator('.app-nav').getByRole('button', { name: 'Metrics' }).click();
  await page.locator('.metrics-segment-btn', { hasText: 'All' }).click();
  await page.getByPlaceholder('Search metrics…').fill('Waist');
  const row2 = page
    .locator('.metric-row-wrap')
    .filter({ has: page.locator('.metric-row-name', { hasText: /^Waist circumference$/ }) });
  await row2.getByRole('button', { name: /Details: / }).click();
  // The tag survived the reload.
  await expect(row2.locator('.metric-chip-text', { hasText: 'sport' })).toBeVisible();

  // Remove it via the chip's × and it disappears.
  const sportChip = row2
    .locator('.metric-chip')
    .filter({ has: page.locator('.metric-chip-text', { hasText: 'sport' }) });
  await sportChip.getByRole('button', { name: 'Remove' }).click();
  await expect(row2.locator('.metric-chip-text', { hasText: 'sport' })).toHaveCount(0);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the metric detail header shows tag mini-chips, hidden when tags are off', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await addValue(page, 'Glucose', '5.4'); // tags: blood, diabetes

  // Open the Glucose detail from the overview.
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
  await page.locator('.app-content button').filter({ hasText: 'Glucose' }).first().click();

  // The header carries non-interactive tag mini-chips (e.g. "Diabetes").
  const tagRow = page.locator('.metric-header-tags');
  await expect(tagRow).toBeVisible();
  await expect(tagRow.locator('.tag-chip--mini', { hasText: 'Diabetes' })).toBeVisible();

  // Turn tags off in Settings → the detail header no longer renders the row.
  await page.locator('.app-nav').getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('switch', { name: 'Use tags' }).click();
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
  await page.locator('.app-content button').filter({ hasText: 'Glucose' }).first().click();
  await expect(page.locator('.metric-header-tags')).toHaveCount(0);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the Settings "Use tags" switch falls back to a flat overview', async ({ page }) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await addValue(page, 'Glucose', '5.4');
  await addValue(page, 'Hemoglobin', '140');

  // Grouped by default.
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
  await expect(page.locator('.overview-group')).toHaveCount(2);

  // Turn tags off in Settings.
  await page.locator('.app-nav').getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('switch', { name: 'Use tags' }).click();

  // Overview is now a single flat list — no tag sections.
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
  await expect(page.locator('.overview-group')).toHaveCount(0);
  await expect(
    page.locator('.overview-content button').filter({ hasText: 'Glucose' }).first(),
  ).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});
