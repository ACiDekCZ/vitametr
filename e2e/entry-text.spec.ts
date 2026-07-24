import { expect, test, type Page } from '@playwright/test';

/**
 * Manual entry of a qualitative (text) value: typing a non-numeric value for a
 * new metric creates a text metric and stores the string — no "valid number"
 * error. The value then shows across the app.
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

test('a non-numeric value creates a text metric and is stored', async ({ page }) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();
  await page.evaluate(() => { window.location.hash = '#/entry'; });

  // New metric "Výsledek": open the create form from the suggestions.
  await page.getByLabel('Metric', { exact: true }).first().fill('Výsledek');
  await page.getByRole('button', { name: /Create new metric —/ }).click();

  // Enter a qualitative value, then create — the non-numeric value makes it a
  // text metric.
  await page.getByLabel('Value', { exact: true }).first().fill('Negativní');
  await page.getByRole('button', { name: 'Create new metric', exact: true }).click();

  // No "enter a valid number" error for the text metric; submit is possible.
  await expect(page.getByText('Enter a valid number.')).toHaveCount(0);
  await page.getByRole('button', { name: /^Add$/ }).click();
  // Saving a value for a just-quick-created metric surfaces the "Add details"
  // toast (which jumps to its detail on the Metrics page).
  await expect(page.getByRole('button', { name: 'Add details' })).toBeVisible();

  // The qualitative value shows on the overview.
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
  await expect(page.getByText('Negativní').first()).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});
