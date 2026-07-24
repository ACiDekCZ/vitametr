import { expect, test, type Page } from '@playwright/test';

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
const LOCK = /^Lock$|^Zamknout$/;
const UNLOCK = /Unlock|Odemknout/;

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await clearDb(page);
  await page.goto('/');
});

test('onboarding without encryption reaches the shell', async ({ page }) => {
  const errors = trackErrors(page);
  await expect(page.locator('.center-screen')).toBeVisible();

  // Leave the password empty (plaintext), then create.
  await page.getByRole('button', { name: CREATE }).click();

  await expect(page.locator('.app-nav')).toBeVisible();
  await expect(page.locator('.app-header .brand')).toHaveText('Vitametr');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('navigation switches routes (plaintext profile does not lock)', async ({ page }) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: CREATE }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await page.locator('.app-nav').getByRole('button', { name: /Timeline|Časová osa/ }).click();
  await expect(page).toHaveURL(/#\/timeline$/);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('plaintext profile stays unlocked after a reload (no passphrase screen)', async ({ page }) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: CREATE }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  // Reload: a plaintext profile has no passphrase, so it must boot straight to
  // the shell rather than showing the lock screen.
  await page.reload();
  await expect(page.locator('.app-nav')).toBeVisible();
  await expect(page.locator('.center-screen')).toHaveCount(0);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('encrypted profile requires the passphrase after lock', async ({ page }) => {
  const errors = trackErrors(page);

  // Setting a password turns on encryption; fill both fields (the repeat field
  // appears once the first has a value — wait for it before filling).
  const passInputs = page.locator('.center-screen input[type="password"]');
  await passInputs.nth(0).fill('secret-pass');
  await expect(passInputs.nth(1)).toBeVisible();
  await passInputs.nth(1).fill('secret-pass');
  await page.getByRole('button', { name: CREATE }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  // Manual lock now lives in Settings (not the header).
  await page.locator('.app-nav').getByRole('button', { name: /Settings|Nastavení/ }).click();
  await page.getByRole('button', { name: LOCK }).click();
  await expect(page.locator('.center-screen')).toBeVisible();

  // Wrong passphrase is rejected. Wait for the error before retrying so the
  // rejected attempt (slow PBKDF2) has fully settled and cleared the field.
  await page.locator('.center-screen input[type="password"]').fill('wrong');
  await page.getByRole('button', { name: UNLOCK }).click();
  await expect(page.getByText(/Wrong passphrase|Nesprávné heslo/)).toBeVisible();

  // Correct passphrase unlocks.
  await page.locator('.center-screen input[type="password"]').fill('secret-pass');
  await page.getByRole('button', { name: UNLOCK }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('password can be enabled and removed from settings; reload honours the mode', async ({
  page,
}) => {
  const errors = trackErrors(page);
  const SETTINGS = /Settings|Nastavení/;
  const SAVE = /^Save$|^Uložit$/;

  // Start plaintext.
  await page.getByRole('button', { name: CREATE }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  const PASSWORD_ROW = /App password|Heslo aplikace/;

  // Settings → "App password" opens a modal → "Protect with a password" sets a
  // password (turns on encryption).
  await page.locator('.app-nav').getByRole('button', { name: SETTINGS }).click();
  await page.getByRole('button', { name: PASSWORD_ROW }).click();
  const enableSec = page
    .locator('.settings-subsection')
    .filter({ hasText: /Protect with a password|Chránit heslem/ });
  await enableSec.locator('input[type="password"]').nth(0).fill('secret-pass');
  await enableSec.locator('input[type="password"]').nth(1).fill('secret-pass');
  await enableSec.getByRole('button', { name: SAVE }).click();
  // The dialog closes and the password row flips to the "On" state; reopening it
  // now offers "Remove password".
  await expect(page.getByRole('button', { name: PASSWORD_ROW })).toContainText(/On|Zapnuto/);
  await page.getByRole('button', { name: PASSWORD_ROW }).click();
  await expect(
    page
      .locator('.settings-subsection')
      .filter({ hasText: /Remove password|Zrušit heslo/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: /^Close$|^Zavřít$/ }).click();

  // Reload: now encrypted, so the lock screen must appear and require the password.
  await page.reload();
  await expect(page.locator('.center-screen')).toBeVisible();
  await page.locator('.center-screen input[type="password"]').fill('secret-pass');
  await page.getByRole('button', { name: UNLOCK }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  // Settings → "App password" → "Remove password": verify the current password,
  // back to plaintext.
  await page.locator('.app-nav').getByRole('button', { name: SETTINGS }).click();
  await page.getByRole('button', { name: PASSWORD_ROW }).click();
  const removeSec = page
    .locator('.settings-subsection')
    .filter({ hasText: /Remove password|Zrušit heslo/ });
  await removeSec.locator('input[type="password"]').fill('secret-pass');
  await removeSec.getByRole('button', { name: SAVE }).click();
  // Back to plaintext: the password row returns to "Off".
  await expect(page.getByRole('button', { name: PASSWORD_ROW })).toContainText(/Off|Vypnuto/);

  // Reload: plaintext again → straight to the shell, no lock screen.
  await page.reload();
  await expect(page.locator('.app-nav')).toBeVisible();
  await expect(page.locator('.center-screen')).toHaveCount(0);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('passphrase mismatch blocks profile creation', async ({ page }) => {
  const passInputs = page.locator('.center-screen input[type="password"]');
  await passInputs.nth(0).fill('secret-pass');
  await expect(passInputs.nth(1)).toBeVisible();
  await passInputs.nth(1).fill('different');
  await page.getByRole('button', { name: CREATE }).click();
  // Still on onboarding with an error shown.
  await expect(page.locator('.center-screen')).toBeVisible();
  await expect(page.locator('.app-nav')).toHaveCount(0);
});
