import { expect, test, type Page } from '@playwright/test';

/**
 * Overview "time-travel" — view the state as of a past date. Picking an earlier
 * as-of date shows a prominent banner, resolves each card/row to the latest value
 * at/before that date (not the current one), and renders a muted "no value at that
 * date" placeholder for metrics measured only later. The × clears the snapshot
 * back to live. The bound actions carry the date: "Export this state" opens Export
 * preselected to As-of-date mode, and Summary opens the report at that date.
 * English default locale.
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

async function addValueOn(
  page: Page,
  metric: string,
  value: string,
  date: string,
): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/entry';
  });
  const metricInput = page.getByLabel('Metric', { exact: true }).first();
  await metricInput.fill(metric);
  await metricInput.press('Enter');
  await page.locator('#entry-date').fill(date);
  await page.getByLabel('Value', { exact: true }).first().fill(value);
  await page.getByRole('button', { name: /^Add$/ }).click();
}

async function seed(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();
  // Glucose measured in Jan 2025 (early) and Jun 2026 (current). Integer mg/dL
  // values (the English default unit, 0 decimals) so they survive formatting.
  await addValueOn(page, 'Glucose', '90', '2025-01-01');
  await addValueOn(page, 'Glucose', '200', '2026-06-01');
  // Hemoglobin measured only in Jun 2026 (later than the as-of date below).
  await addValueOn(page, 'Hemoglobin', '140', '2026-06-01');
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'List view' }).click();
}

/** Open the as-of picker and choose a date, entering snapshot mode. */
async function pickAsOf(page: Page, date: string): Promise<void> {
  await page.getByRole('button', { name: 'As of date' }).click();
  await page.getByLabel('As-of date').fill(date);
}

test('an earlier as-of date shows the state then, with empty placeholders', async ({ page }) => {
  const errors = trackErrors(page);
  await seed(page);

  await pickAsOf(page, '2025-06-01');

  // The banner is unmissable.
  await expect(page.locator('.overview-asof-banner')).toBeVisible();
  await expect(page.locator('.overview-asof-banner')).toContainText('Showing state as of');

  // Glucose resolves to its Jan 2025 value (90), not the later 200.
  const glucoseRow = page.locator('.overview-row').filter({ hasText: 'Glucose' });
  await expect(glucoseRow).toContainText('90');
  await expect(glucoseRow).not.toContainText('200');

  // Hemoglobin has no value yet at that date → muted placeholder (still listed).
  const hemoglobinRow = page.locator('.overview-row').filter({ hasText: 'Hemoglobin' });
  await expect(hemoglobinRow).toContainText('no value at that date');

  // The × returns to live: banner gone, latest values back.
  await page.locator('.overview-asof-close').click();
  await expect(page.locator('.overview-asof-banner')).toHaveCount(0);
  await expect(page.locator('.overview-row').filter({ hasText: 'Glucose' })).toContainText('200');
  await expect(page.locator('.overview-row').filter({ hasText: 'Hemoglobin' })).toContainText('140');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('bound actions carry the as-of date to Export and the report', async ({ page }) => {
  const errors = trackErrors(page);
  await seed(page);

  await pickAsOf(page, '2025-06-01');

  // "Export this state" → Export preselected to As-of-date mode at that date.
  await page.getByRole('button', { name: 'Export this state' }).click();
  await expect(page).toHaveURL(/#\/export\/2025-06-01$/);
  await expect(
    page.locator('.export-mode-segment .is-active'),
  ).toHaveText('As of date');
  await expect(page.locator('.export-asof-date')).toHaveValue('2025-06-01');

  // Back to the overview snapshot → Summary opens the report at that date.
  await page.evaluate(() => {
    window.location.hash = '#/overview';
  });
  await pickAsOf(page, '2025-06-01');
  await page.locator('.overview-header').getByRole('button', { name: /Summary/ }).click();
  await expect(page).toHaveURL(/#\/report\/2025-06-01$/);
  await expect(page.locator('.report h1')).toContainText('State as of');

  expect(errors, errors.join('\n')).toEqual([]);
});
