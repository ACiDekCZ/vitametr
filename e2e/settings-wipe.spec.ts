import { expect, test, type Page } from '@playwright/test';

/**
 * Danger-zone "delete all data" is gated behind re-authentication: when the
 * profile is encrypted, the final wipe step requires the current password; a
 * wrong password is rejected and the data survives. A plaintext profile has no
 * password, so the plain two-step confirm still applies.
 */

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

async function clearDb(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (const db of (await indexedDB.databases?.()) ?? []) {
      if (db.name) indexedDB.deleteDatabase(db.name);
    }
  });
}

const CREATE = /Create profile|Vytvořit profil/;
const WIPE = /Delete all data|Smazat všechna data/;
const CONFIRM = /^Confirm$|^Potvrdit$/;
const SETTINGS = /^Settings$|^Nastavení$/;

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await clearDb(page);
  await page.goto('/');
});

test('encrypted profile: wipe requires the password; wrong password is rejected', async ({
  page,
}) => {
  const errors = trackErrors(page);

  // Create an encrypted profile (a password turns on encryption).
  const passInputs = page.locator('.center-screen input[type="password"]');
  await passInputs.nth(0).fill('secret-pass');
  await expect(passInputs.nth(1)).toBeVisible();
  await passInputs.nth(1).fill('secret-pass');
  await page.getByRole('button', { name: CREATE }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  // Open Settings → Danger zone.
  await page.locator('.app-nav').getByRole('button', { name: SETTINGS }).click();
  await expect(page.locator('.settings-view h1')).toBeVisible();

  // Step 1 → step 2 reveals a password field (encrypted profile).
  await page.getByRole('button', { name: WIPE }).click();
  await page.locator('.settings-danger-card').getByRole('button', { name: CONFIRM }).click();
  const pw = page.locator('.settings-danger-card input[type="password"]');
  await expect(pw).toBeVisible();

  // A wrong password is rejected and nothing is wiped (still on Settings).
  await pw.fill('wrong-pass');
  await page.locator('.settings-danger-card').getByRole('button', { name: CONFIRM }).click();
  await expect(page.getByText(/Wrong password\.|Nesprávné heslo\./)).toBeVisible();
  await expect(page.locator('.settings-view h1')).toBeVisible();
  await expect(page.getByRole('button', { name: CREATE })).toHaveCount(0);

  // The correct password goes through to the wipe → back to a fresh onboarding.
  await pw.fill('secret-pass');
  await page.locator('.settings-danger-card').getByRole('button', { name: CONFIRM }).click();
  await expect(page.getByRole('button', { name: CREATE })).toBeVisible();
  await expect(page.locator('.app-nav')).toHaveCount(0);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('plaintext profile: wipe has no password step (two-step confirm only)', async ({ page }) => {
  const errors = trackErrors(page);

  // Create a plaintext profile (no password).
  await page.getByRole('button', { name: CREATE }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await page.locator('.app-nav').getByRole('button', { name: SETTINGS }).click();
  await expect(page.locator('.settings-view h1')).toBeVisible();

  await page.getByRole('button', { name: WIPE }).click();
  await page.locator('.settings-danger-card').getByRole('button', { name: CONFIRM }).click();

  // No password field for a plaintext profile.
  await expect(page.locator('.settings-danger-card input[type="password"]')).toHaveCount(0);

  // The second confirm wipes straight away → fresh onboarding.
  await page.locator('.settings-danger-card').getByRole('button', { name: CONFIRM }).click();
  await expect(page.getByRole('button', { name: CREATE })).toBeVisible();
  await expect(page.locator('.app-nav')).toHaveCount(0);

  expect(errors, errors.join('\n')).toEqual([]);
});
