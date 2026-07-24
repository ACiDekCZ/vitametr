import { expect, test, type Page } from '@playwright/test';

/**
 * Appearance toggle (Auto / Light / Dark). The stylesheet is driven by the
 * `data-theme` attribute on <html>; this suite verifies the Settings segment
 * writes that attribute (and swaps the actual tokens), that Auto follows the
 * emulated system scheme live, and that the boot path — which paints from a
 * non-sensitive localStorage cache before an encrypted profile is unlocked —
 * renders the lock screen in the right theme with no errors.
 */

// --bg tokens per theme (styles.css): light #f4f7f7, dark #131b1d.
const LIGHT_BG = 'rgb(244, 247, 247)';
const DARK_BG = 'rgb(19, 27, 29)';

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
    localStorage.clear();
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
});

test('Appearance segment forces Dark / Light and Auto follows the system', async ({ page }) => {
  const errors = trackErrors(page);

  // Boot paints a resolved theme onto <html> before anything else renders.
  await expect(page.locator('html')).toHaveAttribute('data-theme', /^(light|dark)$/);

  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await page.locator('.app-nav').getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('.app-content')).toContainText('Appearance');

  // Force Dark: attribute flips and the dark --bg token is actually in effect.
  // toHaveCSS retries past the brief theme-anim colour transition.
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('body')).toHaveCSS('background-color', DARK_BG);

  // Force Light.
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('body')).toHaveCSS('background-color', LIGHT_BG);

  // Auto follows the emulated system scheme, live.
  await page.getByRole('button', { name: 'Auto', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('body')).toHaveCSS('background-color', DARK_BG);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('boot paints the lock screen from cache before the profile is unlocked', async ({ page }) => {
  const errors = trackErrors(page);

  // Create an ENCRYPTED profile (a password), then force Dark.
  await page.getByLabel('Set a password (optional)').fill('correct horse');
  await page.getByLabel('Repeat passphrase').fill('correct horse');
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await page.locator('.app-nav').getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // Let the debounced store flush (500ms) persist settings.theme before reload.
  await page.waitForTimeout(700);

  // Reload: the encrypted profile gates on the lock screen (settings are NOT yet
  // available), yet the boot cache must paint it dark with no crash.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Unlock' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('body')).toHaveCSS('background-color', DARK_BG);

  // Unlocking keeps the persisted preference in effect.
  await page.getByLabel('Passphrase').fill('correct horse');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.locator('.app-nav')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  expect(errors, errors.join('\n')).toEqual([]);
});
