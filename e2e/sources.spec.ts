import { expect, test, type Page } from '@playwright/test';

/**
 * Data-sources dialog (Settings → Data sources). Covers the redesigned row and
 * add-form behaviour: adding a source appends a row with its type mini-chip,
 * duplicate names are rejected inline (no toast), a source renames in place and
 * persists, an unused source removes via an inline two-step confirm, and a
 * source attributed to a measurement shows the "N measurements" meta with no
 * remove affordance. The built-in manual source carries no chip and no actions.
 */

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

async function clearDb(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (const db of (await indexedDB.databases?.()) ?? []) {
      if (db.name) indexedDB.deleteDatabase(db.name);
    }
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await clearDb(page);
  await page.goto('/');
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();
});

/** Open Settings → the Data sources dialog. Returns the dialog locator. */
async function openSourcesDialog(page: Page) {
  await page.locator('.app-nav').getByRole('button', { name: /^Settings$/ }).click();
  await expect(page.locator('.settings-view h1')).toBeVisible();
  await page.getByRole('button', { name: /sources · manage/ }).click();
  const dialog = page.locator('dialog.modal');
  await expect(dialog.getByRole('heading', { name: 'Data sources' })).toBeVisible();
  return dialog;
}

async function addSource(page: Page, name: string): Promise<void> {
  const dialog = page.locator('dialog.modal');
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Add source' }).click();
}

test('adding a source appends a row with its type mini-chip', async ({ page }) => {
  const errors = trackErrors(page);
  const dialog = await openSourcesDialog(page);

  await dialog.getByLabel('Type', { exact: true }).selectOption({ label: 'Laboratory' });
  await addSource(page, 'Synlab');

  const row = dialog.locator('.sources-row').filter({ hasText: 'Synlab' });
  await expect(row).toHaveCount(1);
  await expect(row.locator('.tag-chip--mini')).toHaveText('Laboratory');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('a duplicate name shows an inline error and adds no second row', async ({ page }) => {
  const errors = trackErrors(page);
  const dialog = await openSourcesDialog(page);

  await addSource(page, 'Synlab');
  await expect(dialog.locator('.sources-row')).toHaveCount(1);

  // Same name, different case → inline error, no toast, no new row.
  await addSource(page, 'synlab');
  await expect(dialog.getByText('A source with this name already exists.')).toBeVisible();
  await expect(dialog.locator('.sources-row')).toHaveCount(1);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('renaming a source inline persists across re-open', async ({ page }) => {
  const errors = trackErrors(page);
  let dialog = await openSourcesDialog(page);

  await addSource(page, 'Old name');
  // Click the name → inline editor; type a new name and confirm with Enter.
  await dialog.locator('.sources-name', { hasText: 'Old name' }).click();
  const input = dialog.locator('.sources-name-input');
  await input.fill('New name');
  await input.press('Enter');
  await expect(dialog.locator('.sources-row').filter({ hasText: 'New name' })).toHaveCount(1);

  // Re-open the dialog: the rename persisted.
  await dialog.getByRole('button', { name: 'Close' }).click();
  dialog = await openSourcesDialog(page);
  await expect(dialog.locator('.sources-row').filter({ hasText: 'New name' })).toHaveCount(1);
  await expect(dialog.locator('.sources-row').filter({ hasText: 'Old name' })).toHaveCount(0);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('an unused source shows × and removes after the inline confirm', async ({ page }) => {
  const errors = trackErrors(page);
  const dialog = await openSourcesDialog(page);

  await addSource(page, 'Temp');
  const row = dialog.locator('.sources-row').filter({ hasText: 'Temp' });
  await expect(row.locator('.sources-remove')).toBeVisible();

  // × → inline confirm text + Confirm(danger).
  await row.locator('.sources-remove').click();
  await expect(dialog.getByText('Remove this source?')).toBeVisible();
  await dialog.getByRole('button', { name: 'Confirm' }).click();

  await expect(dialog.locator('.sources-row').filter({ hasText: 'Temp' })).toHaveCount(0);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('a source attributed to a measurement shows the count meta and no ×', async ({ page }) => {
  const errors = trackErrors(page);

  // Create a non-manual source, then attribute a measurement to it via entry.
  let dialog = await openSourcesDialog(page);
  await dialog.getByLabel('Type', { exact: true }).selectOption({ label: 'Laboratory' });
  await addSource(page, 'Lab X');
  await dialog.getByRole('button', { name: 'Close' }).click();

  await page.evaluate(() => { window.location.hash = '#/entry'; });
  const metricInput = page.getByLabel('Metric', { exact: true }).first();
  await metricInput.fill('Glucose');
  await metricInput.press('Enter');
  await page.getByLabel('Value', { exact: true }).first().fill('5.4');
  await page.locator('#entry-source').selectOption({ label: 'Lab X' });
  await page.getByRole('button', { name: /^Add$/ }).click();

  // Re-open the dialog: "Lab X" is now in use → count meta, no remove ×.
  dialog = await openSourcesDialog(page);
  const row = dialog.locator('.sources-row').filter({ hasText: 'Lab X' });
  await expect(row.locator('.sources-row-meta')).toHaveText('1 measurements');
  await expect(row.locator('.sources-remove')).toHaveCount(0);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the built-in manual source has no type chip and no actions', async ({ page }) => {
  const errors = trackErrors(page);

  // A plain manual entry (default source picker) creates the built-in manual source.
  await page.evaluate(() => { window.location.hash = '#/entry'; });
  const metricInput = page.getByLabel('Metric', { exact: true }).first();
  await metricInput.fill('Glucose');
  await metricInput.press('Enter');
  await page.getByLabel('Value', { exact: true }).first().fill('5.4');
  await page.getByRole('button', { name: /^Add$/ }).click();

  const dialog = await openSourcesDialog(page);
  const row = dialog.locator('.sources-row').filter({ hasText: 'Manual entry' });
  await expect(row).toHaveCount(1);
  await expect(row.locator('.tag-chip--mini')).toHaveCount(0);
  await expect(row.locator('.sources-remove')).toHaveCount(0);
  await expect(row.locator('.sources-name')).toHaveCount(0);

  expect(errors, errors.join('\n')).toEqual([]);
});
