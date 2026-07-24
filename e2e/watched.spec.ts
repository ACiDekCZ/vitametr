import { expect, test, type Page } from '@playwright/test';

/**
 * The "Watched" (favorites) tag: a star quick-toggle on overview tiles + list
 * rows and in the metric-detail header. Watching a metric surfaces a "Watched"
 * group first (the metric also stays in its category group) and a "Watched"
 * filter chip; clicking a star never navigates to the detail; with tags off the
 * stars and the chip disappear. Runs in English (Playwright default).
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

async function seedTwoMetrics(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();
  await addValue(page, 'Glucose', '5.4'); // → Diabetes
  await addValue(page, 'Hemoglobin', '140'); // → Blood count
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
}

test('a tile star watches a metric: first "Watched" group + chip, still in its category', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await seedTwoMetrics(page);

  // The Glucose tile carries a star; clicking it must NOT open the detail.
  const glucoseCard = page
    .locator('.metric-card-wrap')
    .filter({ has: page.locator('.metric-name', { hasText: 'Glucose' }) });
  await glucoseCard.locator('.watch-star').click();
  await expect(page.locator('.metric-back')).toHaveCount(0); // no navigation

  // A "Watched" group appears FIRST, holding Glucose.
  const groups = page.locator('.overview-group-title');
  await expect(groups.first()).toHaveText(/Watched/);
  const watched = page
    .locator('.overview-group')
    .filter({ has: page.locator('.overview-group-title', { hasText: 'Watched' }) });
  await expect(watched.locator('button').filter({ hasText: 'Glucose' })).toBeVisible();

  // Glucose STILL appears under its category (Diabetes).
  const diabetes = page
    .locator('.overview-group')
    .filter({ has: page.locator('.overview-group-title', { hasText: 'Diabetes' }) });
  await expect(diabetes.locator('button').filter({ hasText: 'Glucose' })).toBeVisible();

  // A "Watched" filter chip exists (right after "All tags").
  await expect(page.locator('.overview-tag-filter .tag-chip--star')).toHaveText(/Watched/);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('a list-row star watches a metric', async ({ page }) => {
  const errors = trackErrors(page);
  await seedTwoMetrics(page);

  // Switch to the list layout.
  await page.getByRole('button', { name: 'List view' }).click();

  const glucoseRow = page
    .locator('.overview-row')
    .filter({ has: page.locator('.overview-row-name', { hasText: 'Glucose' }) });
  await glucoseRow.locator('.watch-star').click();
  await expect(page.locator('.metric-back')).toHaveCount(0); // no navigation

  await expect(page.locator('.overview-group-title').first()).toHaveText(/Watched/);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('the metric-detail header star toggles watched', async ({ page }) => {
  const errors = trackErrors(page);
  await seedTwoMetrics(page);

  // Open the Glucose detail.
  await page.locator('.app-content button').filter({ hasText: 'Glucose' }).first().click();
  await expect(page.locator('.metric-title')).toHaveText('Glucose');

  const star = page.locator('.metric-title-row .watch-star');
  await expect(star).toHaveAttribute('aria-pressed', 'false');
  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'true');
  // The "Watched" mini-chip now shows in the header.
  await expect(page.locator('.metric-header-tags .tag-chip--mini', { hasText: 'Watched' })).toBeVisible();

  // Back on the overview it leads with the "Watched" group.
  await page.locator('.metric-back').click();
  await expect(page.locator('.overview-group-title').first()).toHaveText(/Watched/);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('stars and the watched chip hide when tags are off', async ({ page }) => {
  const errors = trackErrors(page);
  await seedTwoMetrics(page);

  // Watch a metric first so a chip would otherwise exist.
  const glucoseCard = page
    .locator('.metric-card-wrap')
    .filter({ has: page.locator('.metric-name', { hasText: 'Glucose' }) });
  await glucoseCard.locator('.watch-star').click();
  await expect(page.locator('.watch-star').first()).toBeVisible();

  // Turn tags off in Settings.
  await page.locator('.app-nav').getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('switch', { name: 'Use tags' }).click();

  // The overview no longer renders any star or the watched chip.
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
  await expect(page.locator('.watch-star')).toHaveCount(0);
  await expect(page.locator('.tag-chip--star')).toHaveCount(0);

  expect(errors, errors.join('\n')).toEqual([]);
});
