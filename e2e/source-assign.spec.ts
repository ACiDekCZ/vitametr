import { expect, test, type Page } from '@playwright/test';

/**
 * Data-source assignment: change the source of a single measurement in the
 * metric-detail edit row, and bulk-change the source of a whole timeline batch
 * (including the retroactive path — a batch that currently has no source). Both
 * go through the shared source picker; both persist across a reload.
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
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();
});

async function addValue(page: Page, metric: string, value: string): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/entry';
  });
  const metricInput = page.getByLabel('Metric', { exact: true }).first();
  await metricInput.fill(metric);
  await metricInput.press('Enter');
  await page.getByLabel('Value', { exact: true }).first().fill(value);
  await page.getByRole('button', { name: /^Add$/ }).click();
  await expect(page.getByText('Saved')).toBeVisible();
}

/** Open the Glucose metric detail from the overview list. */
async function openGlucoseDetail(page: Page): Promise<void> {
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'List view' }).click();
  await page.locator('.overview-row').filter({ hasText: 'Glucose' }).click();
  await expect(page.locator('.metric-title', { hasText: 'Glucose' })).toBeVisible();
}

test('a single measurement gets a new source that persists across reload', async ({ page }) => {
  const errors = trackErrors(page);

  await addValue(page, 'Glucose', '5.4'); // stored with the built-in Manual entry source
  await openGlucoseDetail(page);

  // Before: the row is attributed to Manual entry.
  const row = page.locator('.metric-row').first();
  await expect(row.locator('.metric-row-source')).toHaveText('Manual entry');

  // Edit → set a brand-new source via the shared picker → Save.
  await page.getByRole('button', { name: 'Edit measurement' }).click();
  const picker = page.locator('.metric-edit .source-picker');
  await picker.locator('select').first().selectOption('__new__');
  await picker.locator('.source-picker-name').fill('Dr Smith');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  // The row now shows the new source.
  await expect(page.locator('.metric-row').first().locator('.metric-row-source')).toHaveText(
    'Dr Smith',
  );

  // Persisted: reload, reopen the detail — still Dr Smith.
  await page.waitForTimeout(600);
  await page.reload();
  await openGlucoseDetail(page);
  await expect(page.locator('.metric-row').first().locator('.metric-row-source')).toHaveText(
    'Dr Smith',
  );

  expect(errors, errors.join('\n')).toEqual([]);
});

test('a source-less timeline batch is retroactively assigned a source', async ({ page }) => {
  const errors = trackErrors(page);

  // Add a value, then clear its source to None via the metric-edit picker so the
  // timeline batch is source-less (the retroactive-assignment path).
  await addValue(page, 'Glucose', '5.4');
  await openGlucoseDetail(page);
  await page.getByRole('button', { name: 'Edit measurement' }).click();
  await page.locator('.metric-edit .source-picker select').first().selectOption('__none__');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.metric-row').first().locator('.metric-row-source')).toHaveCount(0);

  // Timeline: the batch shows no source and offers the change action.
  await page.locator('.app-nav').getByRole('button', { name: 'Timeline' }).click();
  const group = page.locator('.timeline-entry').first();
  await expect(group.locator('.timeline-source')).toHaveText('None');

  await group.getByRole('button', { name: 'Change source' }).click();
  const dialog = page.locator('dialog.modal');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.timeline-change-count')).toHaveText(
    'Changes the source of 1 measurements',
  );

  // Assign a brand-new source and apply.
  await dialog.locator('.source-picker select').first().selectOption('__new__');
  await dialog.locator('.source-picker-name').fill('Lab Y');
  await dialog.getByRole('button', { name: 'Confirm' }).click();

  // The batch header now names the new source.
  await expect(page.locator('.timeline-entry').first().locator('.timeline-source')).toHaveText(
    'Lab Y',
  );

  // Persisted across a reload.
  await page.waitForTimeout(600);
  await page.reload();
  await page.locator('.app-nav').getByRole('button', { name: 'Timeline' }).click();
  await expect(page.locator('.timeline-entry').first().locator('.timeline-source')).toHaveText(
    'Lab Y',
  );

  expect(errors, errors.join('\n')).toEqual([]);
});
