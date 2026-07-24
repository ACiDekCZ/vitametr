import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 3: a password-protected PDF asks for its password in a modal dialog,
 * then imports. Fixture: lab-en-chemistry-encrypted.pdf (synthetic, "labpass").
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

test('password-protected PDF prompts for the password, then imports', async ({ page }) => {
  const errors = trackErrors(page);

  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await page.evaluate(() => { window.location.hash = '#/import'; });
  await page.getByRole('button', { name: 'Specific format' }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.format-card', { hasText: 'Lab PDF' }).click(),
  ]);
  await chooser.setFiles('test/fixtures/labs/foreign/lab-en-chemistry-encrypted.pdf');

  // The encrypted PDF triggers a modal password prompt instead of going
  // straight to review.
  const pwField = page.getByRole('textbox', { name: /File password/ });
  await expect(pwField).toBeVisible({ timeout: 20000 });

  // A wrong password is rejected and keeps the prompt open.
  await pwField.fill('nope');
  await page.getByRole('button', { name: /Confirm/ }).click();
  await expect(page.getByText(/Wrong password/i)).toBeVisible({ timeout: 20000 });

  // The correct password imports the file.
  await pwField.fill('labpass');
  await page.getByRole('button', { name: /Confirm/ }).click();

  await expect(page).toHaveURL(/#\/review$/, { timeout: 20000 });
  await page.getByRole('button', { name: /Import selected/ }).click();

  await expect(page).toHaveURL(/#\/overview$/);
  await expect(
    page.locator('.app-content button').filter({ hasText: 'Glucose' }).first(),
  ).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});
