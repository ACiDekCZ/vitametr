import { expect, test, type Page } from '@playwright/test';

/**
 * Blood pressure is reached through the metric search — selecting it turns the
 * row into the linked sys/dia/pulse group. There is no standing BP shortcut.
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

test('searching blood pressure builds the sys/dia/pulse group; no standing shortcut', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();
  await page.evaluate(() => { window.location.hash = '#/entry'; });

  // The old standing "Blood pressure and pulse" link is gone.
  await expect(
    page.getByRole('button', { name: 'Blood pressure and pulse' }),
  ).toHaveCount(0);

  // Search for it and pick the suggestion → the group row appears.
  await page.getByLabel('Metric', { exact: true }).first().fill('Krevní tlak');
  await page.locator('.metric-suggestions button').first().click();

  await expect(page.locator('.entry-bp-title')).toBeVisible();
  await expect(page.locator('.entry-bp-grid')).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});
