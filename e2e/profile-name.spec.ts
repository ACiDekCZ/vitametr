import { expect, test, type Page } from '@playwright/test';

/**
 * The profile name moved out of onboarding into Settings → Application. It is an
 * optional free-text field: empty shows a localized default (via the placeholder
 * and everywhere it surfaces), a typed name persists across a reload, and clearing
 * it returns to the default. Runs in English (Playwright default locale).
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

test('Settings offers an optional profile name that persists and defaults when empty', async ({
  page,
}) => {
  const errors = trackErrors(page);

  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await page.locator('.app-nav').getByRole('button', { name: 'Settings' }).click();

  // A new profile has no name: the field is empty and shows the default placeholder.
  const nameInput = page.getByLabel('Profile name');
  await expect(nameInput).toHaveValue('');
  await expect(nameInput).toHaveAttribute('placeholder', 'My profile');

  // Typing a name persists it across a reload.
  await nameInput.fill('Milan');
  await nameInput.blur();
  await page.waitForTimeout(700); // let the debounced write flush

  await page.reload();
  await page.locator('.app-nav').getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByLabel('Profile name')).toHaveValue('Milan');

  // Clearing it stores an empty name; the default placeholder returns.
  const nameInput2 = page.getByLabel('Profile name');
  await nameInput2.fill('');
  await nameInput2.blur();
  await page.waitForTimeout(700);

  await page.reload();
  await page.locator('.app-nav').getByRole('button', { name: 'Settings' }).click();
  const nameInput3 = page.getByLabel('Profile name');
  await expect(nameInput3).toHaveValue('');
  await expect(nameInput3).toHaveAttribute('placeholder', 'My profile');

  expect(errors, errors.join('\n')).toEqual([]);
});
