import { expect, test, type Page } from '@playwright/test';

/** Import an HL7 v2 ORU^R01 lab message → review → overview. */

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

test('HL7 v2 ORU message imports lab results', async ({ page }) => {
  const errors = trackErrors(page);

  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await page.evaluate(() => { window.location.hash = '#/import'; });
  await page.getByRole('button', { name: 'Specific format' }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.format-card', { hasText: 'HL7 v2' }).click(),
  ]);
  await chooser.setFiles('test/fixtures/sources/hl7v2/oru-sample.hl7');

  await expect(page).toHaveURL(/#\/review$/, { timeout: 20000 });
  await page.getByRole('button', { name: /Import selected/ }).click();

  await expect(page).toHaveURL(/#\/overview$/);
  await expect(
    page.locator('.app-content button').filter({ hasText: 'Glucose' }).first(),
  ).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});
