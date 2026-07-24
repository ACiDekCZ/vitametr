import { expect, test, type Page } from '@playwright/test';

/** The learned/custom aliases of a metric are editable in the app. */

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

test('find a metric and add a custom alias, which persists across the rerender', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  // Alias editing lives on the Metrics ("Veličiny") page as chips per metric.
  await page.locator('.app-nav').getByRole('button', { name: 'Metrics' }).click();
  await page.locator('.metrics-segment-btn', { hasText: 'All' }).click();
  await page.getByPlaceholder('Search metrics…').fill('Glucose');
  const row = page
    .locator('.metric-row-wrap')
    .filter({ has: page.locator('.metric-row-name', { hasText: /^Glucose$/ }) });
  await expect(row).toHaveCount(1);

  // Expand the metric detail and add a custom alias chip.
  await row.getByRole('button', { name: /Details: / }).click();
  await row.getByRole('button', { name: '+ add' }).click();
  await row.getByPlaceholder('Name or abbreviation').fill('Cukr v krvi');
  await row.getByPlaceholder('Name or abbreviation').press('Enter');

  // The chip shows (proves it persisted through mutate/repaint).
  await expect(row.getByText('Cukr v krvi')).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});
