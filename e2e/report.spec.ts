import { expect, test, type Page } from '@playwright/test';

/** Health summary: add a value, open the summary from the overview, see it listed. */

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

test('summary report shows tracked values and can be reached from the overview', async ({ page }) => {
  const errors = trackErrors(page);

  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  // Add a glucose value.
  await page.evaluate(() => { window.location.hash = '#/entry'; });
  const metric = page.getByLabel('Metric', { exact: true }).first();
  await metric.fill('Glucose');
  await metric.press('Enter');
  await page.getByLabel('Value', { exact: true }).first().fill('5.4');
  await page.getByRole('button', { name: /^Add$/ }).click();

  // Overview → open the summary.
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
  await page.locator('.overview-header').getByRole('button', { name: /Summary/ }).click();

  await expect(page).toHaveURL(/#\/report$/);
  await expect(page.locator('.report h1')).toHaveText('Health summary');
  await expect(page.locator('.report-section')).toContainText('Glucose');
  await expect(page.getByRole('button', { name: /Print/ })).toBeVisible();

  // The Range | As-of-date switch flips the report into the "State as of" layout.
  await page.locator('.report-mode-segment').getByRole('button', { name: 'As of date' }).click();
  await expect(page.locator('.report h1')).toContainText('State as of');
  await expect(page.locator('.report-asof-date')).toBeVisible();
  // The snapshot table carries a Source column and still lists the metric.
  await expect(page.locator('.report-section')).toContainText('Glucose');
  await expect(page.locator('.report-scroll table')).toContainText('Source');

  // Switching back returns to the range summary title.
  await page.locator('.report-mode-segment').getByRole('button', { name: 'Period' }).click();
  await expect(page.locator('.report h1')).toHaveText('Health summary');

  // The back link returns to the Overview.
  await page.locator('.report-back').click();
  await expect(page).toHaveURL(/#\/overview$/);
  await expect(page.locator('.overview-header')).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});
