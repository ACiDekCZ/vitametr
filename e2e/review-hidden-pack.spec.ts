import { expect, test, type Page } from '@playwright/test';

/**
 * Import-review "belongs to a disabled pack" flow (Fáze 4). A value whose name
 * resolves to a metric that lives in a currently-INACTIVE pack (FSH → Hormones,
 * off by default) surfaces a dedicated review row offering to activate the pack,
 * show just that metric, create it as your own (guarded), or skip.
 *
 * Also covers the `offerHiddenMetrics` setting: turned off, the same value is
 * treated as unresolved (the normal create-new / skip path) instead.
 *
 * Fixture: a Czech-style CSV with a Glukóza row (visible core) and an FSH row
 * (hidden hormone).
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

async function onboard(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();
}

/** Drive a CSV fixture through the mapping screen to the review screen. */
async function toReview(
  page: Page,
  fixture = 'test/fixtures/labs/cz/lab-cs-hidden-hormone.csv',
): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/import';
  });
  await page.getByRole('button', { name: 'Specific format' }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.format-card', { hasText: 'CSV table' }).click(),
  ]);
  await chooser.setFiles(fixture);

  await expect(page).toHaveURL(/#\/import-csv$/);
  await expect(page.locator('.csv-mapping')).toBeVisible();
  await page.getByRole('button', { name: /Continue to review/ }).click();
  await expect(page).toHaveURL(/#\/review$/);
}

/** The FSH review row (its metric belongs to the disabled Hormones pack). */
function fshRow(page: Page) {
  return page.locator('.review-item').filter({ hasText: 'FSH' });
}

/** The LH review row (also a hidden Hormones-pack metric). */
function lhRow(page: Page) {
  return page.locator('.review-item').filter({ hasText: 'LH' });
}

test('activating the pack from review resolves the hidden metric and commits it', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await onboard(page);
  await toReview(page);

  // The FSH row is in the hidden-pack state, naming the disabled Hormones pack.
  const row = fshRow(page);
  await expect(row).toHaveClass(/review-item--hidden-pack/);
  await expect(row.getByText('belongs to the disabled pack')).toBeVisible();

  // Activate the pack: the row falls back to the normal (accepted) resolved row.
  await row.getByRole('button', { name: 'Activate the «Hormones» pack' }).click();
  await expect(fshRow(page)).not.toHaveClass(/review-item--hidden-pack/);

  await page.getByRole('button', { name: /Import selected/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);
  await expect(
    page.locator('.app-content button').filter({ hasText: 'FSH' }).first(),
  ).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('"Create as your own" is guarded and, on confirm, resolves the row', async ({ page }) => {
  const errors = trackErrors(page);
  await onboard(page);
  await toReview(page);

  const row = fshRow(page);
  await expect(row).toHaveClass(/review-item--hidden-pack/);

  // The guard asks before shadowing the built-in; Back restores the actions.
  await row.getByRole('button', { name: 'Create as your own' }).click();
  await expect(row.getByText(/Are you sure you want to create your own/)).toBeVisible();
  await row.getByRole('button', { name: 'Back' }).click();
  await expect(row.getByRole('button', { name: 'Create as your own' })).toBeVisible();

  // Confirm creates the user metric and repoints the row (no longer hidden-pack).
  await row.getByRole('button', { name: 'Create as your own' }).click();
  await row.getByRole('button', { name: 'Confirm' }).click();
  await expect(fshRow(page)).not.toHaveClass(/review-item--hidden-pack/);

  await page.getByRole('button', { name: /Import selected/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);
  await expect(
    page.locator('.app-content button').filter({ hasText: 'FSH' }).first(),
  ).toBeVisible();

  // The Hormones pack was NOT activated — the value went to a user's own metric.
  await page.locator('.app-nav').getByRole('button', { name: 'Metrics' }).click();
  await expect(page.getByRole('switch', { name: 'Hormones' })).toHaveAttribute(
    'aria-checked',
    'false',
  );

  expect(errors, errors.join('\n')).toEqual([]);
});

test('bulk "activate the pack for all N" resolves every hidden row at once', async ({ page }) => {
  const errors = trackErrors(page);
  await onboard(page);
  await toReview(page, 'test/fixtures/labs/cz/lab-cs-hidden-hormones-two.csv');

  // Both hormone rows start in the hidden-pack state.
  await expect(fshRow(page)).toHaveClass(/review-item--hidden-pack/);
  await expect(lhRow(page)).toHaveClass(/review-item--hidden-pack/);

  // A single bulk banner offers to activate Hormones for both rows.
  const bulk = page.locator('.review-hidden-banner').getByRole('button', {
    name: 'Activate «Hormones» for all 2',
  });
  await expect(bulk).toBeVisible();
  await bulk.click();

  // One click normalizes every covered row and drops the banner.
  await expect(fshRow(page)).not.toHaveClass(/review-item--hidden-pack/);
  await expect(lhRow(page)).not.toHaveClass(/review-item--hidden-pack/);
  await expect(page.locator('.review-hidden-banner')).toHaveCount(0);

  await page.getByRole('button', { name: /Import selected/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);
  await expect(page.locator('.app-content button').filter({ hasText: 'FSH' }).first()).toBeVisible();
  await expect(page.locator('.app-content button').filter({ hasText: 'LH' }).first()).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the hidden-pack row does not overflow horizontally on a narrow screen', async ({ page }) => {
  const errors = trackErrors(page);
  await page.setViewportSize({ width: 360, height: 740 });
  await onboard(page);
  await toReview(page, 'test/fixtures/labs/cz/lab-cs-hidden-hormones-two.csv');

  await expect(fshRow(page)).toHaveClass(/review-item--hidden-pack/);

  // The page body never scrolls sideways, and neither the row nor its action
  // cluster is wider than the viewport.
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const bodyOverflows = doc.scrollWidth > doc.clientWidth;
    const row = document.querySelector('.review-item--hidden-pack') as HTMLElement | null;
    const actions = document.querySelector('.review-hidden-pack-actions') as HTMLElement | null;
    return {
      bodyOverflows,
      rowOverflows: row ? row.scrollWidth > doc.clientWidth : false,
      actionsOverflow: actions ? actions.scrollWidth > actions.clientWidth + 1 : false,
    };
  });
  expect(overflow.bodyOverflows).toBe(false);
  expect(overflow.rowOverflows).toBe(false);
  expect(overflow.actionsOverflow).toBe(false);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('after "Create as your own", a second import resolves straight to the user metric', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await onboard(page);
  await toReview(page);

  // Create FSH as the user's own metric (guarded), then import it.
  const row = fshRow(page);
  await row.getByRole('button', { name: 'Create as your own' }).click();
  await row.getByRole('button', { name: 'Confirm' }).click();
  await expect(fshRow(page)).not.toHaveClass(/review-item--hidden-pack/);
  await page.getByRole('button', { name: /Import selected/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);

  // Re-import the same file: "FSH" now resolves to the user's own (visible) metric,
  // so its row is a normal resolved row — no hidden-pack prompt, not unresolved.
  await toReview(page);
  const second = fshRow(page);
  await expect(second).not.toHaveClass(/review-item--hidden-pack/);
  await expect(second).not.toHaveClass(/review-item--unresolved/);
  await expect(second.getByRole('button', { name: 'Accept' })).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('with "offer hidden metrics" off, the hidden metric arrives as unresolved', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await onboard(page);

  // Turn the setting off on the Import page.
  await page.evaluate(() => {
    window.location.hash = '#/import';
  });
  await page.locator('.import-offer-row').getByRole('switch').click();

  await toReview(page);

  // FSH now flows into the normal unresolved path (create-new / skip), not the
  // hidden-pack row.
  const row = fshRow(page);
  await expect(row).toHaveClass(/review-item--unresolved/);
  await expect(row).not.toHaveClass(/review-item--hidden-pack/);

  expect(errors, errors.join('\n')).toEqual([]);
});
