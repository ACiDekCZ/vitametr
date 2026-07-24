import { expect, test, type Page } from '@playwright/test';
import { reachReview } from './support/pass-import-filter';

/**
 * Mobile add-data bottom sheet (device-aware "Data" nav). Below the sidebar
 * breakpoint the center FAB opens a sheet with DIRECT actions: manual entry and
 * export navigate to their pages, while "Import file" opens the file picker
 * straight from the sheet (a chosen file runs the same auto-detect pipeline; a
 * cancelled picker leaves the user where they were). A ghost link opens the full
 * Data page. Covers opening, the direct actions, the straight-to-picker import,
 * Escape / click-outside closing with focus returning to the FAB.
 *
 * The desktop (sidebar) behaviour — the "Data" item navigating directly with no
 * popover — lives in data-nav.spec.ts.
 */

// A genuinely mobile viewport (below the 500px sidebar breakpoint) so the FAB
// opens the bottom sheet rather than acting as a plain sidebar nav row.
test.use({ viewport: { width: 390, height: 800 } });

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

const fab = (page: Page) =>
  page.locator('.app-nav').getByRole('button', { name: 'Data', exact: true });

test('nav has exactly 5 slots with the add-data FAB and no import item', async ({ page }) => {
  await expect(page.locator('.app-nav').getByRole('button')).toHaveCount(5);
  await expect(
    page.locator('.app-nav').getByRole('button', { name: 'Import', exact: true }),
  ).toHaveCount(0);
  await expect(fab(page)).toBeVisible();
});

test('the FAB opens the sheet; manual entry and export navigate directly', async ({ page }) => {
  const errors = trackErrors(page);

  // Manual entry.
  await fab(page).click();
  await expect(page.locator('dialog.fab-menu')).toBeVisible();
  await expect(fab(page)).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: /Enter manually/ }).click();
  await expect(page).toHaveURL(/#\/entry$/);
  await expect(page.locator('dialog.fab-menu')).toHaveCount(0);

  // Export.
  await fab(page).click();
  await page.getByRole('button', { name: /Export data/ }).click();
  await expect(page).toHaveURL(/#\/export$/);

  // Ghost link opens the full Data page (Import).
  await fab(page).click();
  await page.getByRole('button', { name: /Open the Data page/ }).click();
  await expect(page).toHaveURL(/#\/import$/);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the sheet Import action opens the picker straight away and a chosen file reaches review', async ({
  page,
}) => {
  const errors = trackErrors(page);

  await fab(page).click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: /Import file/ }).click(),
  ]);
  // The sheet closes once the picker is up; the file runs the auto-detect path.
  await expect(page.locator('dialog.fab-menu')).toHaveCount(0);
  await chooser.setFiles('test/fixtures/fhir-bundle.json');
  await reachReview(page);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('cancelling the sheet Import picker does not navigate', async ({ page }) => {
  const before = page.url();
  await fab(page).click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: /Import file/ }).click(),
  ]);
  // No file chosen == cancelled: the user stays exactly where they were.
  await chooser.setFiles([]);
  await expect(page).not.toHaveURL(/#\/review$/);
  await expect(page).not.toHaveURL(/#\/import$/);
  expect(page.url()).toBe(before);
});

test('Escape closes the sheet and returns focus to the FAB', async ({ page }) => {
  await fab(page).click();
  await expect(page.locator('dialog.fab-menu')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.fab-menu')).toHaveCount(0);
  await expect(fab(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(fab(page)).toBeFocused();
});

test('click-outside (backdrop) closes the sheet and returns focus to the FAB', async ({ page }) => {
  await fab(page).click();
  const dialog = page.locator('dialog.fab-menu');
  await expect(dialog).toBeVisible();

  // Click the backdrop area (top-left corner is outside the panel).
  await page.mouse.click(5, 5);
  await expect(dialog).toHaveCount(0);
  await expect(fab(page)).toBeFocused();
});
