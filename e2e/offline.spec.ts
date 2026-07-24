import { expect, test } from '@playwright/test';

/**
 * Offline-first: after the service worker caches the shell, the app still
 * boots with the network cut off.
 */
test('app loads from cache while offline', async ({ page, context }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    for (const db of (await indexedDB.databases?.()) ?? []) {
      if (db.name) indexedDB.deleteDatabase(db.name);
    }
  });

  // Wait for the service worker to control the page.
  await page.goto('/');
  await page.waitForFunction(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return !!reg && !!navigator.serviceWorker.controller;
  });

  // Cut the network and reload — the shell must come from cache.
  await context.setOffline(true);
  await page.reload();

  await expect(page.locator('.center-screen')).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Create profile|Vytvořit profil/ }),
  ).toBeVisible();

  await context.setOffline(false);
});
