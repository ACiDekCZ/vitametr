import { expect, test, type Page } from '@playwright/test';

/**
 * The redesigned import-review "Unresolved" card (spec ZADANI-REVIEW-NEPRIRAZENO):
 * an unknown analyte carrying an `fl` unit gets intelligent suggestion chips
 * (platelet/RBC volume metrics — never cholesterol). Covers the three exits:
 * assign via a chip, create from the raw name via the combobox, and reject.
 *
 * Fixture: a Czech-style CSV whose second row ("PDW - distr. křivka trombo",
 * unit fl) does not resolve to any catalog metric.
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

/** Onboard (no encryption) and drive the CSV fixture to the review screen. */
async function toReview(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await page.evaluate(() => { window.location.hash = '#/import'; });
  await page.getByRole('button', { name: 'Specific format' }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.format-card', { hasText: 'CSV table' }).click(),
  ]);
  await chooser.setFiles('test/fixtures/labs/cz/lab-cs-unresolved-fl.csv');

  await expect(page).toHaveURL(/#\/import-csv$/);
  await expect(page.locator('.csv-mapping')).toBeVisible();
  await page.getByRole('button', { name: /Continue to review/ }).click();
  await expect(page).toHaveURL(/#\/review$/);
}

/** The single unresolved review card (badge "Unresolved"). */
function unresolvedCard(page: Page) {
  return page.locator('.review-item--unresolved');
}

test('suggestion chips surface platelet volume, never cholesterol; a chip resolves the row', async ({ page }) => {
  const errors = trackErrors(page);
  await toReview(page);

  const card = unresolvedCard(page);
  await expect(card).toBeVisible();

  // Chips are present and relevant: MPV (fl + name token) shows, cholesterol never.
  const chips = card.locator('.review-suggest-chip');
  await expect(chips.filter({ hasText: 'Mean platelet volume' })).toBeVisible();
  await expect(chips.filter({ hasText: /holesterol/ })).toHaveCount(0);

  // One tap assigns it: the card collapses to the resolved state with the
  // alias-learned hint, and the unresolved badge is gone.
  await chips.filter({ hasText: 'Mean platelet volume' }).click();
  await expect(unresolvedCard(page)).toHaveCount(0);
  await expect(page.getByText("After import, we'll match it automatically next time.")).toBeVisible();

  await page.getByRole('button', { name: /Import selected/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);
  await expect(
    page.locator('.app-content button').filter({ hasText: 'Mean platelet volume' }).first(),
  ).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('review decisions survive navigating away and back', async ({ page }) => {
  const errors = trackErrors(page);
  await toReview(page);

  // Resolve the unknown row by assigning MPV, and change my mind on it via "Change".
  await unresolvedCard(page).locator('.review-suggest-chip').filter({ hasText: 'Mean platelet volume' }).click();
  await expect(unresolvedCard(page)).toHaveCount(0);

  // Leave review (as if to check something elsewhere) and come back.
  await page.evaluate(() => { window.location.hash = '#/overview'; });
  await expect(page).toHaveURL(/#\/overview$/);
  await page.evaluate(() => { window.location.hash = '#/review'; });
  await expect(page).toHaveURL(/#\/review$/);

  // The assignment is still there — the row is NOT unresolved again.
  await expect(unresolvedCard(page)).toHaveCount(0);
  await expect(
    page.locator('.review-item').filter({ hasText: 'Mean platelet volume' }),
  ).toBeVisible();
  // "Change metric" reopens the picker (reverting a misclick is possible).
  await page.getByRole('button', { name: 'Change metric' }).click();
  await expect(unresolvedCard(page)).toHaveCount(1);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the combobox "+ Create" row creates a metric from the raw name', async ({ page }) => {
  const errors = trackErrors(page);
  await toReview(page);

  const card = unresolvedCard(page);
  // Type a non-matching query to reveal the dropdown, then choose its create row
  // (`.sugg-new`) — distinct from the always-visible direct create button.
  await card.getByPlaceholder('Search metric…').fill('zzz');
  await card.locator('.sugg-new').click();

  // The inline quick-create prefilled the raw name; confirm creates + assigns it.
  await expect(card.locator('.review-create-name')).toHaveValue('PDW - distr. křivka trombo');
  await card.getByRole('button', { name: /^Add$/ }).click();

  await expect(unresolvedCard(page)).toHaveCount(0);
  await page.getByRole('button', { name: /Import selected/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);
  await expect(
    page.locator('.app-content button').filter({ hasText: 'PDW - distr. křivka trombo' }).first(),
  ).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('a direct "Create" button skips the combobox and quick-creates from the raw name', async ({ page }) => {
  const errors = trackErrors(page);
  await toReview(page);

  const card = unresolvedCard(page);
  // The direct create button is visible without touching the combobox.
  await card.locator('.review-create-direct').click();
  await expect(card.locator('.review-create-name')).toHaveValue('PDW - distr. křivka trombo');
  await card.getByRole('button', { name: /^Add$/ }).click();

  await expect(unresolvedCard(page)).toHaveCount(0);
  await page.getByRole('button', { name: /Import selected/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('an unfinished import stays reachable via a "continue review" banner on the Data page', async ({ page }) => {
  const errors = trackErrors(page);
  await toReview(page);

  // Navigate away mid-review to the Data (import) page — the batch is not lost.
  await page.evaluate(() => { window.location.hash = '#/import'; });
  await expect(page).toHaveURL(/#\/import$/);
  const banner = page.locator('.import-pending-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('awaiting review');

  // Clicking it returns to the same review, state intact (still the unresolved row).
  await banner.click();
  await expect(page).toHaveURL(/#\/review$/);
  await expect(unresolvedCard(page)).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('"Reject item" drops only the unresolved row; the resolved value still imports', async ({ page }) => {
  const errors = trackErrors(page);
  await toReview(page);

  await unresolvedCard(page).getByRole('button', { name: 'Reject item' }).click();

  await page.getByRole('button', { name: /Import selected/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);
  // Glucose (the resolved row) imported; the rejected unknown did not.
  await expect(
    page.locator('.app-content button').filter({ hasText: 'Glucose' }).first(),
  ).toBeVisible();
  await expect(
    page.locator('.app-content').filter({ hasText: 'PDW - distr. křivka trombo' }),
  ).toHaveCount(0);

  expect(errors, errors.join('\n')).toEqual([]);
});
