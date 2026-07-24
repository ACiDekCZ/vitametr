import { expect, test, type Page } from '@playwright/test';

/**
 * End-to-end flow across the wired views: onboarding → add a value →
 * overview → metric detail (chart) → timeline. Runs in English (Playwright's
 * default locale), so built-in metric names render in English.
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

test('add a measurement and see it across overview, detail and timeline', async ({ page }) => {
  const errors = trackErrors(page);

  // Onboard without encryption.
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  // Go to the entry screen and add a glucose value.
  await page.evaluate(() => { window.location.hash = '#/entry'; });
  const metricInput = page.getByLabel('Metric', { exact: true }).first();
  await metricInput.fill('Glucose');
  await metricInput.press('Enter');
  const valueInput = page.getByLabel('Value', { exact: true }).first();
  await valueInput.fill('5.4');
  await page.getByRole('button', { name: /^Add$/ }).click();

  // Overview shows a card with the metric (value shown in the locale's unit).
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
  const card = page.locator('.app-content button').filter({ hasText: 'Glucose' }).first();
  await expect(card).toBeVisible();

  // Open the metric detail: a chart (SVG) renders.
  await card.click();
  await expect(page).toHaveURL(/#\/metric\//);
  await expect(page.locator('svg[role="img"]')).toBeVisible();

  // Timeline lists the event.
  await page.locator('.app-nav').getByRole('button', { name: 'Timeline' }).click();
  await expect(page.locator('.app-content')).toContainText('Glucose');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('data survives a lock/unlock cycle when encrypted', async ({ page }) => {
  const errors = trackErrors(page);

  const passInputs = page.locator('.center-screen input[type="password"]');
  await passInputs.nth(0).fill('secret-pass');
  await passInputs.nth(1).fill('secret-pass');
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  // Add a value.
  await page.evaluate(() => { window.location.hash = '#/entry'; });
  const metricInput = page.getByLabel('Metric', { exact: true }).first();
  await metricInput.fill('Glucose');
  await metricInput.press('Enter');
  await page.getByLabel('Value', { exact: true }).first().fill('6.1');
  await page.getByRole('button', { name: /^Add$/ }).click();

  // Lock via Settings, then unlock with the passphrase.
  await page.locator('.app-nav').getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /^Lock$/ }).click();
  await expect(page.locator('.center-screen')).toBeVisible();
  await page.locator('.center-screen input[type="password"]').fill('secret-pass');
  await page.getByRole('button', { name: /Unlock/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  // The measurement round-tripped through encryption and is still there.
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
  await expect(
    page.locator('.app-content button').filter({ hasText: 'Glucose' }).first(),
  ).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});
