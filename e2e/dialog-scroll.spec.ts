import { expect, test, type Locator, type Page } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Create profile/ }).click();
  await page.locator('.app-nav').getByRole('button', { name: 'Metrics', exact: true }).click();
  await expect(page.locator('.metrics-add')).toBeVisible();
});

async function wheel(page: Page, x: number, y: number, delta: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, delta);
  // Wheel events are processed asynchronously by the browser's compositor.
  await page.waitForTimeout(250);
}

async function expectBackdropLocked(page: Page): Promise<void> {
  const { y, delta } = await page.evaluate(() => ({
    y: scrollY,
    delta: scrollY < document.documentElement.scrollHeight - innerHeight - 200 ? 200 : -200,
  }));
  await wheel(page, 3, 100, delta);
  expect(await page.evaluate(() => scrollY)).toBe(y);
}

async function wheelOverDialog(page: Page, dialog: Locator, delta: number): Promise<void> {
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  await wheel(page, box!.x + box!.width / 2, box!.y + box!.height / 2, delta);
}

test('the add menu blocks background scrolling and closing restores it', async ({ page }) => {
  await page.evaluate(() => scrollTo(0, 200));
  await page.locator('.nav-fab').click();
  const dialog = page.locator('dialog.fab-menu');
  await expect(dialog).toBeVisible();
  const y = await page.evaluate(() => scrollY);

  await expectBackdropLocked(page);
  await wheelOverDialog(page, dialog, 200);
  expect(await page.evaluate(() => scrollY)).toBe(y);

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => scrollY)).toBe(y);
  await wheel(page, 3, 100, 200);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(y);
});

test('a long dialog scrolls internally without chaining to the page at its boundary', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 500 });
  await page.locator('.metrics-add').click();
  const dialog = page.locator('dialog.modal');
  await expect(dialog).toBeVisible();
  const y = await page.evaluate(() => scrollY);
  expect(await dialog.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

  await wheelOverDialog(page, dialog, 200);
  await expect.poll(() => dialog.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => scrollY)).toBe(y);

  await dialog.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await wheelOverDialog(page, dialog, 200);
  expect(await page.evaluate(() => scrollY)).toBe(y);
  await expectBackdropLocked(page);
});

test('the Settings sources dialog also blocks background scrolling', async ({ page }) => {
  await page.locator('.app-nav').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: /sources · manage/ }).click();
  const dialog = page.locator('dialog.modal');
  await expect(dialog).toBeVisible();
  const y = await page.evaluate(() => scrollY);

  await expectBackdropLocked(page);
  await wheelOverDialog(page, dialog, -200);
  expect(await page.evaluate(() => scrollY)).toBe(y);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => scrollY)).toBe(y);
});
