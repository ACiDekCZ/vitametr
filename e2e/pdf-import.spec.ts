import { expect, test, type Page } from '@playwright/test';
import { reachReview } from './support/pass-import-filter';

/**
 * Phase 3: import a lab-result PDF (synthetic) through Settings. Exercises the
 * lazy-loaded pdf.js plugin end to end: worker spawn, text extraction under the
 * strict script-src CSP, line parsing, review, and landing in the overview.
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

test('PDF import: lab sheet is parsed and lands in overview', async ({ page }) => {
  const errors = trackErrors(page);

  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await page.evaluate(() => { window.location.hash = '#/import'; });
  await page.getByRole('button', { name: 'Specific format' }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.format-card', { hasText: 'Lab PDF' }).click(),
  ]);
  await chooser.setFiles('test/fixtures/labs/cz/lab-cs-result.pdf');

  // pdf.js loads lazily and extracts text, then we reach the review screen.
  await reachReview(page);
  await page.getByRole('button', { name: /Import selected/ }).click();

  await expect(page).toHaveURL(/#\/overview$/);
  await expect(
    page.locator('.app-content button').filter({ hasText: 'Glucose' }).first(),
  ).toBeVisible();

  // No CSP / eval / worker errors leaked to the console.
  expect(errors, errors.join('\n')).toEqual([]);
});
