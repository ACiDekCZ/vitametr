import { expect, test, type Page } from '@playwright/test';

/**
 * Device-aware "Data" navigation on the DESKTOP (sidebar) layout: the single
 * "Data" item is a plain nav row that jumps straight to the last-used data tab
 * (no popover), and a shared Zadat · Import · Export strip switches between the
 * three pages. Covers the tab strip (active tab inert), the session memory of
 * the last-used tab, and the aria-current mapping onto the Data item.
 *
 * The default Playwright viewport (Desktop Chrome, 1280px) is above the 500px
 * sidebar breakpoint, so these run on the sidebar layout without extra setup.
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

const dataItem = (page: Page) =>
  page.locator('.app-nav').getByRole('button', { name: 'Data', exact: true });
const tab = (page: Page, name: string) =>
  page.locator('.data-switch').getByRole('button', { name, exact: true });

test('the Zadat·Import·Export strip navigates between the three pages, active tab inert', async ({
  page,
}) => {
  const errors = trackErrors(page);

  await page.evaluate(() => {
    window.location.hash = '#/entry';
  });
  await expect(page).toHaveURL(/#\/entry$/);
  await expect(tab(page, 'Enter')).toHaveAttribute('aria-current', 'true');

  await tab(page, 'Import').click();
  await expect(page).toHaveURL(/#\/import$/);
  await expect(tab(page, 'Import')).toHaveAttribute('aria-current', 'true');

  // The active tab is inert: clicking it does not navigate away.
  await tab(page, 'Import').click();
  await expect(page).toHaveURL(/#\/import$/);

  await tab(page, 'Export').click();
  await expect(page).toHaveURL(/#\/export$/);
  await expect(tab(page, 'Export')).toHaveAttribute('aria-current', 'true');

  await tab(page, 'Enter').click();
  await expect(page).toHaveURL(/#\/entry$/);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the sidebar Data item resumes the last-used data tab (session memory)', async ({ page }) => {
  // Visit Import, then leave for a non-data route.
  await page.evaluate(() => {
    window.location.hash = '#/import';
  });
  await expect(page).toHaveURL(/#\/import$/);
  await page.evaluate(() => {
    window.location.hash = '#/overview';
  });
  await expect(page).toHaveURL(/#\/overview$/);

  // One click on the sidebar "Data" item lands back on Import (no popover).
  await expect(page.locator('dialog.fab-menu')).toHaveCount(0);
  await dataItem(page).click();
  await expect(page.locator('dialog.fab-menu')).toHaveCount(0);
  await expect(page).toHaveURL(/#\/import$/);

  // After switching to Export via the strip, memory follows it.
  await tab(page, 'Export').click();
  await expect(page).toHaveURL(/#\/export$/);
  await page.evaluate(() => {
    window.location.hash = '#/timeline';
  });
  await dataItem(page).click();
  await expect(page).toHaveURL(/#\/export$/);
});

test('the Data item reads as current on entry/import/export/import-csv/review routes', async ({
  page,
}) => {
  for (const route of ['entry', 'import', 'export', 'import-csv', 'review']) {
    await page.evaluate((r) => {
      window.location.hash = `#/${r}`;
    }, route);
    await expect(dataItem(page)).toHaveAttribute('aria-current', 'page');
  }

  await page.evaluate(() => {
    window.location.hash = '#/overview';
  });
  await expect(dataItem(page)).not.toHaveAttribute('aria-current', 'page');
});
