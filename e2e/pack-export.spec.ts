import { expect, test, type Page } from '@playwright/test';

/**
 * Pack export dialog (Metrics → Export pack): an editable filename, the
 * tags/codes content toggles (units are always packed, so no "Include units"),
 * and a tag-filter chip row that narrows the metric checklist.
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

test('editable filename + tags/codes toggles drive a custom-named download', async ({ page }) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await page.locator('.app-nav').getByRole('button', { name: 'Metrics' }).click();
  await page.getByRole('button', { name: 'Export pack' }).click();
  const dialog = page.getByRole('dialog');

  // Filename pre-filled with a dated default; no "Include units" anymore.
  const filename = dialog.locator('.settings-pack-filename');
  await expect(filename).toHaveValue(/^vitametr-pack-\d{4}-\d{2}-\d{2}$/);
  await expect(dialog.getByText('Include units')).toHaveCount(0);

  // Tags default on, codes default off.
  await expect(dialog.getByRole('checkbox', { name: 'Include tags' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Include codes (LOINC/external)' })).not.toBeChecked();

  // Overwrite the filename and export → download carries the chosen name + .json.
  await filename.fill('my-metrics');
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export as pack' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('my-metrics.json');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('tag-filter chips narrow the metric checklist', async ({ page }) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  // Add a custom metric carrying the "Lipids" tag (built-ins are untagged).
  await page.locator('.app-nav').getByRole('button', { name: 'Metrics' }).click();
  await page.getByRole('button', { name: 'Add metric' }).click();
  const addDialog = page.getByRole('dialog');
  await addDialog.getByLabel('Name', { exact: true }).fill('Lipidová');
  await addDialog.getByRole('button', { name: '+ tag' }).click();
  await addDialog.getByLabel('Tag name').fill('Lipids');
  await addDialog.getByLabel('Tag name').press('Enter');
  await page.getByRole('button', { name: 'Create new metric' }).click();
  await expect(page.getByText('Lipidová').first()).toBeVisible();

  // Open the pack dialog: the tag filter offers "All tags" + "Lipids".
  await page.getByRole('button', { name: 'Export pack' }).click();
  const dialog = page.getByRole('dialog');
  const list = dialog.locator('.settings-catalog-list');
  const tagRow = dialog.locator('.export-tag-filter');
  await expect(tagRow.getByRole('button', { name: 'All tags' })).toBeVisible();
  await expect(tagRow.getByRole('button', { name: 'Lipids' })).toBeVisible();

  // Unfiltered: both the tagged custom and untagged built-ins show.
  await expect(list).toContainText('Lipidová');
  await expect(list).toContainText('Body weight');

  // Filtering to "Lipids" hides the untagged built-ins.
  await tagRow.getByRole('button', { name: 'Lipids' }).click();
  await expect(list).toContainText('Lipidová');
  await expect(list).not.toContainText('Body weight');

  expect(errors, errors.join('\n')).toEqual([]);
});
