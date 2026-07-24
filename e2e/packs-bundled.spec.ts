import { expect, test, type Page } from '@playwright/test';

/**
 * Bundled-pack management on the Metrics page under the VISIBILITY model. The
 * Core pack is the first row (on by default, deactivatable like any pack); the
 * 14 category packs follow, each with a per-row toggle that shows/hides its
 * metrics. An inactive pack whose metrics are all already visible shows an "all
 * already yours" chip; a partial overlap shows a muted count; no overlap shows
 * just the count. Deactivation confirms in hide/keep terms. No seed note.
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

async function openMetrics(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();
  await page.locator('.app-nav').getByRole('button', { name: 'Metrics' }).click();
}

async function addValue(page: Page, metric: string, value: string): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/entry';
  });
  const metricInput = page.getByLabel('Metric', { exact: true }).first();
  await metricInput.fill(metric);
  await metricInput.press('Enter');
  await page.getByLabel('Value', { exact: true }).first().fill(value);
  await page.getByRole('button', { name: /^Add$/ }).click();
}

test('Core is the first row (on by default), then the 14 category packs, no seed note', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await openMetrics(page);

  // 15 rows: Core + 14 category packs.
  await expect(page.locator('.metrics-bundled-item')).toHaveCount(15);
  // Core is first and its switch is on.
  const firstName = page.locator('.metrics-bundled-item').first().locator('.metrics-pack-name');
  await expect(firstName).toHaveText('Core set');
  await expect(page.getByRole('switch', { name: 'Core set' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  // The old always-on seed note is gone.
  await expect(
    page.getByText('The basic set of common metrics is always active.'),
  ).toHaveCount(0);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('turning Core off confirms, then hides an unused routine metric while data-bearing ones stay', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await openMetrics(page);

  // Give one routine metric data so it survives Core going off.
  await addValue(page, 'Glucose', '5.1');
  await page.locator('.app-nav').getByRole('button', { name: 'Metrics' }).click();

  const core = page.getByRole('switch', { name: 'Core set' });
  await core.click();
  // Inline confirm in hide terms.
  await expect(page.getByText(/Hide \d+ metrics from/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText(/Core set off — \d+ hidden/)).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Core set' })).toHaveAttribute(
    'aria-checked',
    'false',
  );

  await page.getByRole('button', { name: 'All', exact: true }).click();
  // Glucose has a measurement → still visible; an unused routine metric is hidden.
  await page.getByRole('searchbox').fill('Glucose');
  await expect(
    page.locator('.metrics-list .metric-row-name', { hasText: 'Glucose' }),
  ).toBeVisible();
  await page.getByRole('searchbox').fill('Creatinine');
  await expect(
    page.locator('.metrics-list .metric-row-name', { hasText: 'Creatinine' }),
  ).toHaveCount(0);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('a full-overlap inactive pack shows the "all already yours" chip and preview hint', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await openMetrics(page);

  // Blood count is all Core built-ins → on a fresh (Core-on) profile it is
  // inactive but fully overlapped: the chip replaces the count.
  const cbcRow = page.locator('.metrics-bundled-item', { hasText: 'Blood count' });
  await expect(cbcRow.locator('.metrics-pack-fullhave')).toHaveText(/all already yours/);
  await expect(page.getByRole('switch', { name: 'Blood count' })).toHaveAttribute(
    'aria-checked',
    'false',
  );

  // Expanding it shows the muted full-overlap hint above the list.
  await cbcRow.locator('.metrics-pack-open').click();
  await expect(cbcRow.locator('.metrics-pack-fullhint')).toBeVisible();
  await expect(cbcRow.getByText(/activating only adds aliases and tags/)).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('a partial-overlap pack shows a muted count, a no-overlap pack shows just the count', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await openMetrics(page);

  // Kidney mixes Core metrics (already held) with the cystatin-c extra → partial.
  const kidney = page.locator('.metrics-bundled-item', { hasText: 'Kidney' });
  await expect(kidney.locator('.metrics-pack-count')).toContainText('already yours');
  await expect(kidney.locator('.metrics-pack-fullhave')).toHaveCount(0);

  // Hormones are all extras → no overlap → the meta is just the metric count.
  const hormones = page.locator('.metrics-bundled-item', { hasText: 'Hormones' });
  await expect(hormones.locator('.metrics-pack-count')).toBeVisible();
  await expect(hormones.locator('.metrics-pack-count')).not.toContainText('already yours');
  await expect(hormones.locator('.metrics-pack-fullhave')).toHaveCount(0);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('activating a category pack shows its metrics with a show-term toast', async ({ page }) => {
  const errors = trackErrors(page);
  await openMetrics(page);

  const hormones = page.getByRole('switch', { name: 'Hormones' });
  await expect(hormones).toHaveAttribute('aria-checked', 'false');
  await hormones.click();

  // Toast in show terms (Hormones are all extras → all newly shown).
  await expect(page.getByText(/Hormones on — \d+ metrics now shown/)).toBeVisible();
  await expect(hormones).toHaveAttribute('aria-checked', 'true');

  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByRole('searchbox').fill('FSH');
  await expect(page.locator('.metrics-list .metric-row-name', { hasText: 'FSH' })).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('deactivating a pack confirms in hide terms, then hides its metrics', async ({ page }) => {
  const errors = trackErrors(page);
  await openMetrics(page);

  const hormones = page.getByRole('switch', { name: 'Hormones' });
  await hormones.click();
  await expect(hormones).toHaveAttribute('aria-checked', 'true');

  // Turn it off → inline confirm (its metrics are unused → they would be hidden).
  await hormones.click();
  await expect(page.getByText(/Hide \d+ metrics from/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText(/Hormones off — \d+ hidden/)).toBeVisible();

  await expect(page.getByRole('switch', { name: 'Hormones' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByRole('searchbox').fill('FSH');
  await expect(page.locator('.metrics-list .metric-row-name', { hasText: 'FSH' })).toHaveCount(0);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('deactivating a fully-overlapped pack skips the confirm (fast path)', async ({ page }) => {
  const errors = trackErrors(page);
  await openMetrics(page);

  // Blood count is all Core built-ins → activation shows nothing new, so turning
  // it off hides nothing: no confirm, calm toast.
  const cbc = page.getByRole('switch', { name: 'Blood count' });
  await cbc.click();
  await expect(page.getByText(/everything already shown/)).toBeVisible();

  await cbc.click();
  await expect(page.getByText(/Blood count off — everything stays/)).toBeVisible();
  await expect(page.getByText(/Hide \d+ metrics from/)).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Blood count' })).toHaveAttribute(
    'aria-checked',
    'false',
  );

  expect(errors, errors.join('\n')).toEqual([]);
});

test('a metric shared by two active packs survives turning one off', async ({ page }) => {
  const errors = trackErrors(page);
  await openMetrics(page);

  // Hormones and Bone metabolism both claim Parathormon (pth).
  await page.getByRole('switch', { name: 'Hormones' }).click();
  await page.getByRole('switch', { name: 'Bone metabolism' }).click();

  // Turn off Hormones (confirm) — Bone still claims pth, so it is kept visible.
  await page.getByRole('switch', { name: 'Hormones' }).click();
  await expect(page.getByText(/Hide \d+ metrics from/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText(/Hormones off — \d+ hidden/)).toBeVisible();

  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByRole('searchbox').fill('Parathormon');
  await expect(
    page.locator('.metrics-list .metric-row-name', { hasText: 'Parathyroid hormone' }),
  ).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('expanding a pack row previews its metrics; ones with data show the last measured date', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await openMetrics(page);

  // Give a Kidney metric a value so its preview row shows the last-measured date.
  await addValue(page, 'Creatinine', '80');
  await page.locator('.app-nav').getByRole('button', { name: 'Metrics' }).click();

  await page.locator('.metrics-pack-open', { hasText: 'Kidney' }).click();
  await expect(page.locator('.metrics-pack-preview')).toBeVisible();
  // Creatinine has a measurement → its preview row shows a ✓ + last-measured date.
  const marker = page.locator('.metrics-pack-preview .metrics-pack-preview-have').first();
  await expect(marker).toBeVisible();
  await expect(marker).toContainText('✓');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the wipe confirmation states that packs are reset too', async ({ page }) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await page.locator('.app-nav').getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Delete all data/ }).click();
  await expect(
    page.getByText('Deletes all measurements, metrics and activated packs.'),
  ).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});
