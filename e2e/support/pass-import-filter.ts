import { expect, type Page } from '@playwright/test';

/**
 * A large import now stops at the generic "What to import" filter step between
 * parse and review (period + per-metric selection). The end-to-end import flows
 * exercise the whole pipeline, so they pass through that step keeping everything
 * selected (the default) and land on review exactly as before. A small import
 * skips the step, making this a no-op. Not a spec file — it is a shared helper.
 */
export async function reachReview(page: Page, timeout = 20000): Promise<void> {
  await expect(page).toHaveURL(/#\/(import-filter|review)$/, { timeout });
  if (/#\/import-filter$/.test(page.url())) {
    // Keep the whole batch (a very old file would preselect "last year").
    await page.locator('.import-filter-segment-btn', { hasText: 'All' }).click();
    await page.locator('.import-filter-continue').click();
  }
  await expect(page).toHaveURL(/#\/review$/, { timeout });
}
