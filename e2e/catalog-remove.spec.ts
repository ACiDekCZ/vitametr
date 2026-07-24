import { expect, test, type Page } from '@playwright/test';

/**
 * Per-metric removal lives in the metric's detail on the Metrics page, guarded
 * by usage: a metric with zero measurements can be removed (inline two-step
 * confirm); a metric that is referenced by measurements shows a disabled,
 * blocked action instead. The pack toolbox is export-only — it no longer offers
 * "Remove selected".
 */

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

async function importDemoPack(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/import';
  });
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.import-dropzone').click(),
  ]);
  await chooser.setFiles('test/fixtures/demo-pack.json');
  await expect(page).toHaveURL(/#\/review$/, { timeout: 20000 });
  await page.getByRole('button', { name: /Import selected/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);
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

test('removes a metric with no measurements from its detail', async ({ page }) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await page.locator('.app-nav').getByRole('button', { name: 'Metrics' }).click();

  // Add a fresh custom metric — it has no measurements, so it is removable.
  await page.getByRole('button', { name: 'Add metric' }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Test veličina');
  await page.getByRole('button', { name: 'Create new metric' }).click();

  // Creating jumps to the "Custom" filter with the new metric's detail open.
  await expect(page.getByText('Test veličina').first()).toBeVisible();
  const remove = page.locator('.metric-detail-remove');
  await expect(remove.getByRole('button', { name: 'Remove metric' })).toBeEnabled();

  await remove.getByRole('button', { name: 'Remove metric' }).click();
  await remove.getByRole('button', { name: 'Remove', exact: true }).click();

  // The metric is gone from the catalog.
  await expect(page.getByText('Test veličina')).toHaveCount(0);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('a metric with measurements shows a blocked (disabled) remove', async ({ page }) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await importDemoPack(page);

  // Metrics → open "Demo glukóza" (2 measurements) → remove is disabled + hint.
  await page.locator('.app-nav').getByRole('button', { name: 'Metrics' }).click();
  await page.getByRole('button', { name: 'Details: Demo glukóza' }).click();

  const remove = page.locator('.metric-detail-remove');
  await expect(remove.getByRole('button', { name: 'Remove metric' })).toBeDisabled();
  await expect(
    page.getByText("Can't remove — 2 measurements. Delete them first."),
  ).toBeVisible();

  // Its measurements are untouched.
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
  await expect(page.getByText('Demo glukóza').first()).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the pack toolbox no longer offers "Remove selected"', async ({ page }) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await page.locator('.app-nav').getByRole('button', { name: 'Metrics' }).click();
  await page.getByRole('button', { name: 'Export pack' }).click();

  // Export-only: no remove-selected action, and the catalog reset is gone too.
  await expect(page.getByRole('button', { name: 'Remove selected' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Export as pack' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reset to default' })).toHaveCount(0);

  expect(errors, errors.join('\n')).toEqual([]);
});
