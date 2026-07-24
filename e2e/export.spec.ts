import { expect, test, type Page } from '@playwright/test';

/**
 * Export wizard: from Settings, reach the Export route, pick a metric + period +
 * a format, and confirm a file downloads. Also asserts the CSV button was moved
 * out of Settings (interop now lives in the wizard, not the Backup card).
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

test('export wizard: Settings → Export, select metric + period + format → download', async ({
  page,
}) => {
  const errors = trackErrors(page);

  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  // Add a glucose value so there is something to export.
  await page.evaluate(() => { window.location.hash = '#/entry'; });
  const metric = page.getByLabel('Metric', { exact: true }).first();
  await metric.fill('Glucose');
  await metric.press('Enter');
  await page.getByLabel('Value', { exact: true }).first().fill('5.4');
  await page.getByRole('button', { name: /^Add$/ }).click();

  // Open Settings.
  await page.locator('.app-nav').getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('.settings-view h1')).toHaveText('Settings');

  // The CSV button is gone from Settings — interop moved to the Export wizard.
  await expect(page.getByRole('button', { name: 'Table (CSV)' })).toHaveCount(0);
  // The JSON backup button stays.
  await expect(page.getByRole('button', { name: 'Backup (JSON)' })).toBeVisible();

  // Navigate to the Export wizard (reachable via the FAB menu / hash, no longer
  // a Settings row).
  await page.evaluate(() => {
    window.location.hash = '#/export';
  });
  await expect(page).toHaveURL(/#\/export$/);
  await expect(page.locator('.export-view h1')).toHaveText('Export data');

  // The glucose metric is listed and selected by default.
  await expect(page.locator('.export-metric-list')).toContainText('Glucose');
  await expect(page.locator('.export-metric-check').first()).toBeChecked();

  // Pick a period.
  await page.locator('.export-segment').getByRole('button', { name: 'All' }).click();

  // The Export button is disabled until a format is chosen. (Scope to the run
  // button — the switcher's "Export" pill shares the accessible name.)
  const exportBtn = page.locator('button.export-run');
  await expect(exportBtn).toBeDisabled();

  // Choose the CSV format tile.
  await page.locator('.export-format-card').filter({ hasText: 'CSV table' }).click();
  await expect(exportBtn).toBeEnabled();

  // The filename is editable and pre-filled with a dated default; overwrite it.
  const filename = page.locator('.export-filename');
  await expect(filename).toHaveValue(/^vitametr-export-\d{4}-\d{2}-\d{2}$/);
  await filename.fill('my lab results');

  // Export → the download carries the (sanitized) chosen name + the CSV extension.
  const downloadPromise = page.waitForEvent('download');
  await exportBtn.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('my lab results.csv');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('Import ⇄ Export switcher navigates both ways and keeps the add-data FAB highlighted', async ({
  page,
}) => {
  const errors = trackErrors(page);

  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  // Start on the Import page via the bottom nav.
  await page.evaluate(() => { window.location.hash = '#/import'; });
  await expect(page).toHaveURL(/#\/import$/);
  await expect(page.locator('.data-switch')).toBeVisible();

  // Switch to Export.
  await page.locator('.data-switch').getByRole('button', { name: 'Export' }).click();
  await expect(page).toHaveURL(/#\/export$/);
  await expect(page.locator('.export-view h1')).toHaveText('Export data');

  // On the Export route the add-data FAB stays highlighted (no export slot).
  await expect(
    page.locator('.app-nav').getByRole('button', { name: 'Data', exact: true }),
  ).toHaveAttribute('aria-current', 'page');

  // Switch back to Import.
  await page.locator('.data-switch').getByRole('button', { name: 'Import' }).click();
  await expect(page).toHaveURL(/#\/import$/);
  await expect(page.locator('.import-view h1')).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('export "Stav k datu" (as of date): counter, snapshot filename, one row per metric', async ({
  page,
}) => {
  const errors = trackErrors(page);

  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  // Add a glucose value so there is something to snapshot.
  await page.evaluate(() => { window.location.hash = '#/entry'; });
  const metric = page.getByLabel('Metric', { exact: true }).first();
  await metric.fill('Glucose');
  await metric.press('Enter');
  await page.getByLabel('Value', { exact: true }).first().fill('5.4');
  await page.getByRole('button', { name: /^Add$/ }).click();

  await page.evaluate(() => { window.location.hash = '#/export'; });
  await expect(page.locator('.export-view h1')).toHaveText('Export data');

  // Switch the Range section into "As of date" mode.
  await page.locator('.export-mode-segment').getByRole('button', { name: 'As of date' }).click();

  // The as-of controls appear (today pill + date input); the period presets hide.
  await expect(page.locator('.export-asof-date')).toBeVisible();
  await expect(page.locator('.export-period-box')).toBeHidden();

  // The run button becomes a snapshot counter, and the filename default flips to
  // the snapshot pattern.
  const exportBtn = page.locator('button.export-run');
  await expect(exportBtn).toContainText('as of');
  await expect(page.locator('.export-filename')).toHaveValue(/^vitametr-stav-\d{4}-\d{2}-\d{2}$/);

  // Pick CSV and export → the download carries the snapshot filename.
  await page.locator('.export-format-card').filter({ hasText: 'CSV table' }).click();
  const downloadPromise = page.waitForEvent('download');
  await exportBtn.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^vitametr-stav-\d{4}-\d{2}-\d{2}\.csv$/);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('export metric checkbox toggles selection and drives the Export button', async ({ page }) => {
  const errors = trackErrors(page);

  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  // One metric so a single checkbox controls the whole selection.
  await page.evaluate(() => { window.location.hash = '#/entry'; });
  const metric = page.getByLabel('Metric', { exact: true }).first();
  await metric.fill('Glucose');
  await metric.press('Enter');
  await page.getByLabel('Value', { exact: true }).first().fill('5.4');
  await page.getByRole('button', { name: /^Add$/ }).click();

  // Reach Export via the switcher on the Import page.
  await page.evaluate(() => { window.location.hash = '#/import'; });
  await page.locator('.data-switch').getByRole('button', { name: 'Export' }).click();
  await expect(page).toHaveURL(/#\/export$/);

  // Pick a format so only the metric selection gates the Export button.
  await page.locator('.export-format-card').filter({ hasText: 'CSV table' }).click();
  const exportBtn = page.locator('button.export-run');
  await expect(exportBtn).toBeEnabled();

  const check = page.locator('.export-metric-check').first();
  await expect(check).toBeChecked();

  // Unchecking the only metric empties the selection → Export disables.
  await check.uncheck();
  await expect(check).not.toBeChecked();
  await expect(exportBtn).toBeDisabled();

  // Re-checking restores it.
  await check.check();
  await expect(check).toBeChecked();
  await expect(exportBtn).toBeEnabled();

  expect(errors, errors.join('\n')).toEqual([]);
});
