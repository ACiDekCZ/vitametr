import { expect, test, type Page } from '@playwright/test';

/**
 * Compare over time: pick a metric, see its chart. The compare route/view stays
 * intact; it is out of the bottom nav (which now holds Import) and is reached by
 * its hash until a later stage gives it a dedicated entry point.
 */

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

async function addValue(page: Page, name: string, value: string): Promise<void> {
  await page.evaluate(() => { window.location.hash = '#/entry'; });
  const m = page.getByLabel('Metric', { exact: true }).first();
  await m.fill(name);
  await m.press('Enter');
  await page.getByLabel('Value', { exact: true }).first().fill(value);
  await page.getByRole('button', { name: /^Add$/ }).click();
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

test('compare view charts a selected metric and is reachable from the overview', async ({ page }) => {
  const errors = trackErrors(page);

  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await addValue(page, 'Glucose', '5.4');
  await addValue(page, 'Body weight', '82');

  await page.evaluate(() => {
    location.hash = '#/compare';
  });
  await expect(page).toHaveURL(/#\/compare$/);

  // Select the two metrics; small-multiple charts appear.
  await page.getByText('Glucose', { exact: true }).click();
  await page.getByText('Body weight', { exact: true }).click();
  await expect(page.locator('svg[role="img"]').first()).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});
