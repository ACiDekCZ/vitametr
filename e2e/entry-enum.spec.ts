import { expect, test, type Page } from '@playwright/test';

/** Defining an enum (list) metric and picking a value from the dropdown. */

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

test('create an enum metric with a value list and pick a value', async ({ page }) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  // Full metric creation (value type + allowed values) lives on the Metrics
  // page's "Add metric" dialog; the entry page's quick-create is unit-only now.
  await page.locator('.app-nav').getByRole('button', { name: 'Metrics' }).click();
  await page.getByRole('button', { name: 'Add metric' }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Test výsledek');
  await page.getByRole('dialog').getByLabel('Value type').selectOption('enum');
  await page.getByRole('dialog').getByLabel('Allowed values').fill('Negativní, Pozitivní');
  await page.getByRole('dialog').getByRole('button', { name: 'Create new metric' }).click();
  await expect(page.getByText('Metric added')).toBeVisible();

  // On the entry page, pick the new enum metric and choose a value.
  await page.evaluate(() => { window.location.hash = '#/entry'; });
  await page.getByLabel('Metric', { exact: true }).first().fill('Test výsledek');
  await page.getByRole('button', { name: 'Test výsledek', exact: true }).click();

  // The value control is a dropdown of the allowed values.
  await page.getByLabel('Value', { exact: true }).selectOption({ label: 'Pozitivní' });
  await page.getByRole('button', { name: /^Add$/ }).click();
  await expect(page.getByText('Saved')).toBeVisible();

  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
  await expect(page.getByText('Pozitivní').first()).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});
