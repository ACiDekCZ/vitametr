import { expect, test } from '@playwright/test';

test('app boots to onboarding without console errors', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(err.message));

    await page.goto('/');
    // Start from a clean local database so the boot flow is deterministic.
    await page.evaluate(async () => {
        for (const db of (await indexedDB.databases?.()) ?? []) {
            if (db.name) indexedDB.deleteDatabase(db.name);
        }
    });
    await page.goto('/');

    const app = page.locator('#app');
    await expect(app).toBeAttached();
    // First run shows the onboarding screen with a create-profile action.
    await expect(page.locator('.center-screen')).toBeVisible();
    await expect(
        page.getByRole('button', { name: /Create profile|Vytvořit profil/ }),
    ).toBeVisible();
    // The profile name is no longer collected during onboarding (it moved to
    // Settings → Application); the field must be absent here.
    await expect(page.getByLabel('Profile name')).toHaveCount(0);
    await expect(app).not.toBeEmpty();

    expect(consoleErrors, `Console errors: ${consoleErrors.join('\n')}`).toEqual([]);
});
