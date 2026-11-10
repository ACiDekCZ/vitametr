import { expect, test, type Page } from '@playwright/test';

/**
 * The pill selects (.settings-inline-select) draw their chevron as a background
 * image anchored to the right edge. A view that restyles the field with the
 * `background` shorthand keeps that image — a theme rule sets it at higher
 * specificity — but resets `background-repeat`/`position`, which tiles the
 * chevron across the whole pill. That is what the Source select on Add values
 * did while focused, so the single chevron is pinned here, in every theme.
 */

async function openEntry(page: Page, theme: 'auto' | 'light' | 'dark'): Promise<void> {
  await page.goto('/');
  await page.evaluate(async () => {
    for (const db of (await indexedDB.databases?.()) ?? []) {
      if (db.name) indexedDB.deleteDatabase(db.name);
    }
    localStorage.clear();
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();
  if (theme !== 'auto') {
    await page.locator('.app-nav').getByRole('button', { name: 'Settings' }).click();
    const label = theme === 'light' ? 'Light' : 'Dark';
    await page.locator('.settings-segment-btn', { hasText: label }).click();
  }
  await page.evaluate(() => {
    window.location.hash = '#/entry';
  });
  await expect(page.locator('#entry-source')).toBeVisible();
}

for (const theme of ['auto', 'light', 'dark'] as const) {
  test(`the source select keeps one right-aligned chevron while focused (${theme})`, async ({
    page,
  }) => {
    await openEntry(page, theme);
    const select = page.locator('#entry-source');
    await select.focus();

    const painted = await select.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        image: style.backgroundImage,
        repeat: style.backgroundRepeat,
        position: style.backgroundPosition,
      };
    });
    expect(painted.image).toContain('svg');
    expect(painted.repeat).toBe('no-repeat');
    expect(painted.position).toContain('100%');
  });
}
