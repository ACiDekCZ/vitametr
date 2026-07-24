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
const UNLOCK = /Unlock|Odemknout/;
const FORGOT = /Forgot password\?|Zapomněli jste heslo\?/;
const ERASE = /Erase everything and start over|Smazat vše a začít znovu/;
const CANCEL = /^Cancel$|^Zrušit$/;

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await clearDb(page);
  await page.goto('/');
});

test('forgot password on the lock screen wipes and returns to onboarding', async ({ page }) => {
  const errors = trackErrors(page);

  // Create an encrypted profile (setting a password turns on encryption); the
  // repeat field appears once the first has a value.
  const passInputs = page.locator('.center-screen input[type="password"]');
  await passInputs.nth(0).fill('secret-pass');
  await expect(passInputs.nth(1)).toBeVisible();
  await passInputs.nth(1).fill('secret-pass');
  await page.getByRole('button', { name: CREATE }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  // Reload: encrypted profile boots to the lock screen.
  await page.reload();
  await expect(page.locator('.center-screen')).toBeVisible();
  await expect(page.getByRole('button', { name: UNLOCK })).toBeVisible();

  // Cancelling at each step keeps the profile intact.
  await page.getByRole('button', { name: FORGOT }).click();
  await expect(page.getByText(/Erase all data and start over\?|Smazat všechna data a začít znovu\?/)).toBeVisible();
  await page.getByRole('button', { name: CANCEL }).click();
  await expect(page.getByRole('button', { name: FORGOT })).toBeVisible();

  // Two-step confirm through to the wipe.
  await page.getByRole('button', { name: FORGOT }).click();
  await page.getByRole('button', { name: ERASE }).click();
  await expect(page.getByText(/This cannot be undone|Tuto akci nelze vzít zpět/)).toBeVisible();
  await page.getByRole('button', { name: ERASE }).click();

  // Back to a fresh onboarding: the wipe cleared the profile, so no lock screen
  // and the old passphrase is no longer accepted (the profile no longer exists).
  await expect(page.getByRole('button', { name: CREATE })).toBeVisible();
  await expect(page.getByRole('button', { name: UNLOCK })).toHaveCount(0);
  await expect(page.locator('.app-nav')).toHaveCount(0);

  expect(errors, errors.join('\n')).toEqual([]);
});
