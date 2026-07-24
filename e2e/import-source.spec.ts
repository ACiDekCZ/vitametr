import { expect, test, type Page } from '@playwright/test';

/**
 * Sources in the import flow: a lab import whose parser stamps a source name is
 * attributed to a source. The review screen suggests creating it, the commit
 * persists it (visible in Settings → Data sources), and re-importing the same
 * file reuses the existing source instead of duplicating it.
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

async function importSynlab(page: Page): Promise<void> {
  await page.evaluate(() => { window.location.hash = '#/import'; });
  await page.getByRole('button', { name: 'Specific format' }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.format-card', { hasText: 'Lab PDF' }).click(),
  ]);
  await chooser.setFiles('test/fixtures/labs/cz/lab-cs-synlab.pdf');
  await expect(page).toHaveURL(/#\/review$/, { timeout: 20000 });
}

test('lab import suggests, creates and reuses a source', async ({ page }) => {
  const errors = trackErrors(page);

  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  // First import: the parser stamps SYNLAB, so review suggests a NEW source.
  await importSynlab(page);
  await expect(page.locator('.review-source-select')).toHaveValue('__new__');
  await expect(page.locator('.review-source-name')).toHaveValue('SYNLAB');
  await page.getByRole('button', { name: /Import selected/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);

  // The source now exists in Settings → Data sources (exactly one).
  await page.locator('.app-nav').getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /sources · manage/ }).click();
  const dialog = page.locator('dialog[open]');
  await expect(dialog.getByRole('heading', { name: 'Data sources' })).toBeVisible();
  await expect(dialog.locator('.settings-list-row', { hasText: 'SYNLAB' })).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Close' }).click();

  // Second import of the same file: review preselects the EXISTING source and
  // hides the new-source form; no duplicate source is created.
  await importSynlab(page);
  await expect(page.locator('.review-source-select')).toHaveValue('source-synlab');
  await expect(page.locator('.review-source-new')).toBeHidden();
  await page.getByRole('button', { name: /Import selected/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);

  await page.locator('.app-nav').getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /sources · manage/ }).click();
  await expect(
    page.locator('dialog[open]').locator('.settings-list-row', { hasText: 'SYNLAB' }),
  ).toHaveCount(1);

  expect(errors, errors.join('\n')).toEqual([]);
});
