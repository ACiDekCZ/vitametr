import { expect, test, type Page } from '@playwright/test';

/**
 * Global unit-system preference, decoupled from the UI language. A user in Czech
 * (whose locale unit for glucose is mmol/L) can switch the display convention to
 * US and see glucose in mg/dL, without the language changing — and switching back
 * to Automatic restores the locale unit. Only the display unit selection changes;
 * the stored value is untouched.
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

test('Units = US shows the US display unit while the language stays Czech', async ({ page }) => {
  const errors = trackErrors(page);

  // Onboard (Playwright's default locale is English) and record a glucose value.
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await page.evaluate(() => { window.location.hash = '#/entry'; });
  const metricInput = page.getByLabel('Metric', { exact: true }).first();
  await metricInput.fill('Glucose');
  await metricInput.press('Enter');
  await page.getByLabel('Value', { exact: true }).first().fill('5.4');
  await page.getByRole('button', { name: /^Add$/ }).click();

  // Switch the app language to Czech (set-once, in Settings).
  await page.locator('.app-nav').getByRole('button', { name: 'Settings' }).click();
  await page.locator('.settings-segment').getByRole('button', { name: 'CS' }).click();

  // Automatic (default) in Czech ⇒ the locale unit for glucose is mmol/l.
  const card = () => page.locator('.app-content button').filter({ hasText: 'Glukóza' }).first();
  await page.locator('.app-nav').getByRole('button', { name: 'Přehled' }).click();
  await expect(card().locator('.metric-unit')).toHaveText('mmol/l');

  // Set Units = US. The language is untouched (still Czech), but glucose now
  // displays in the US unit, mg/dl.
  await page.locator('.app-nav').getByRole('button', { name: 'Nastavení' }).click();
  await expect(page.locator('.app-content')).toContainText('Jednotky');
  await page.getByRole('button', { name: 'US', exact: true }).click();

  await page.locator('.app-nav').getByRole('button', { name: 'Přehled' }).click();
  await expect(card().locator('.metric-unit')).toHaveText('mg/dl');
  // The UI language did not change with the unit system.
  await expect(page.locator('.app-nav')).toContainText('Přehled');

  // Back to Automatic restores the locale (Czech) unit.
  await page.locator('.app-nav').getByRole('button', { name: 'Nastavení' }).click();
  await page.getByRole('button', { name: 'Automaticky', exact: true }).click();
  await page.locator('.app-nav').getByRole('button', { name: 'Přehled' }).click();
  await expect(card().locator('.metric-unit')).toHaveText('mmol/l');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('Metric detail has no unit switcher and follows the global unit system', async ({
  page,
}) => {
  const errors = trackErrors(page);

  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  // Record a glucose value in mmol/l (the SI unit).
  await page.evaluate(() => {
    window.location.hash = '#/entry';
  });
  const metricInput = page.getByLabel('Metric', { exact: true }).first();
  await metricInput.fill('Glucose');
  await metricInput.press('Enter');
  await page.getByLabel('Value', { exact: true }).first().fill('5.4');
  await page.getByRole('button', { name: /^Add$/ }).click();

  // Set Units = US ⇒ the system unit for glucose is mg/dl.
  await page.locator('.app-nav').getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'US', exact: true }).click();

  // Open the metric detail from the overview.
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
  await page.locator('.app-content button').filter({ hasText: 'Glucose' }).first().click();

  // No unit switcher of any kind — the display unit is governed solely by the
  // global system, which here is US ⇒ the value shows in mg/dl (converted).
  await expect(page.locator('.metric-unit-wrap')).toHaveCount(0);
  await expect(page.locator('.metric-unit-restore')).toHaveCount(0);
  const currentUnit = page.locator('.metric-current .metric-value-unit');
  await expect(currentUnit).toHaveText('mg/dl');

  // Switch Units → SI ⇒ the same value now shows in mmol/l, still no switcher.
  await page.locator('.app-nav').getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /^SI/ }).click();
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
  await page.locator('.app-content button').filter({ hasText: 'Glucose' }).first().click();
  await expect(page.locator('.metric-unit-wrap')).toHaveCount(0);
  await expect(page.locator('.metric-current .metric-value-unit')).toHaveText('mmol/l');

  expect(errors, errors.join('\n')).toEqual([]);
});
