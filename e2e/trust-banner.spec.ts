import { expect, test, type Page } from '@playwright/test';

/**
 * The Settings trust banner must be truthful about encryption: it may claim the
 * data is "encrypted with a passphrase" only for a profile that actually has a
 * password. A plaintext profile gets the on-device/no-server copy without the
 * encryption claim.
 */

async function resetAndBoot(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(async () => {
    for (const db of (await indexedDB.databases?.()) ?? []) {
      if (db.name) indexedDB.deleteDatabase(db.name);
    }
    localStorage.clear();
  });
  await page.goto('/');
}

test('plaintext profile: banner omits the encryption claim', async ({ page }) => {
  await resetAndBoot(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await page.locator('.app-nav').getByRole('button', { name: 'Settings' }).click();

  const banner = page.locator('.settings-trust-text');
  await expect(banner).toHaveText('Your data stays on your device, no account and no server.');
  await expect(banner).not.toContainText('Encrypted');
});

test('encrypted profile: banner states it is encrypted', async ({ page }) => {
  await resetAndBoot(page);
  await page.getByLabel('Set a password (optional)').fill('correct horse');
  await page.getByLabel('Repeat passphrase').fill('correct horse');
  await page.getByRole('button', { name: /Create profile/ }).click();
  await page.locator('.app-nav').getByRole('button', { name: 'Settings' }).click();

  await expect(page.locator('.settings-trust-text')).toHaveText(
    'Your data stays on your device. Encrypted with a passphrase, no account and no server.',
  );
});
