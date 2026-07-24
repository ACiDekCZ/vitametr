import { expect, test, type Page } from '@playwright/test';

/**
 * Overview grid / list toggle + filter row (search + tags). The grid is the
 * default at every width; the toggle switches to the list and persists across a
 * reload; the list renders a six-column grid (with a reference-range column)
 * whose header aligns with the rows (a long metric name ellipsises and never
 * collides with the status pill); a ranged metric shows its range and range
 * state (never "no range") and both convert with the unit system; an
 * out-of-range value is warn-coloured while the row itself is not; the search
 * narrows rows; a tag chip filters and drops the group headings; the
 * clear-filters ghost resets; on a phone viewport the list folds into the
 * compact two-line row (no Change column). English default.
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

/** Add a value together with an explicit reference-high, expanding the row's
 * range fields first. `value` above `refHigh` lands the metric above its range. */
async function addRangedValue(
  page: Page,
  metric: string,
  value: string,
  refHigh: string,
): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/entry';
  });
  const metricInput = page.getByLabel('Metric', { exact: true }).first();
  await metricInput.fill(metric);
  await metricInput.press('Enter');
  await page.getByLabel('Value', { exact: true }).first().fill(value);
  await page.getByRole('button', { name: 'Range' }).first().click();
  await page.locator('.field', { hasText: 'Reference high' }).locator('input').fill(refHigh);
  await page.getByRole('button', { name: /^Add$/ }).click();
}

async function seed(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();
  await addValue(page, 'Glucose', '5.4'); // → Diabetes
  await addValue(page, 'Hemoglobin', '140'); // → Blood count (CBC)
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
}

test('the default is the grid at desktop width (no saved choice)', async ({ page }) => {
  const errors = trackErrors(page);
  await seed(page);

  // The desktop test viewport (1280px) now defaults to the card grid, not the
  // list — the list is an explicit opt-in.
  await expect(page.locator('.overview-layout-toggle')).toBeVisible();
  await expect(page.locator('.grid').first()).toBeVisible();
  await expect(page.locator('.overview-list')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Grid view' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the layout toggle switches to the list and persists across a reload', async ({ page }) => {
  const errors = trackErrors(page);
  await seed(page);

  // Switch to list (the non-default) — a choice that differs from the grid
  // default, so persistence is meaningful → two tag-group cards.
  await page.getByRole('button', { name: 'List view' }).click();
  await expect(page.locator('.overview-list')).toHaveCount(2);
  await expect(page.locator('.grid')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'List view' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // The list choice survives a reload (overriding the grid default).
  await page.waitForTimeout(700);
  await page.reload();
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
  await expect(page.locator('.overview-list')).toHaveCount(2);
  await expect(page.locator('.grid')).toHaveCount(0);

  // Switch back to grid.
  await page.getByRole('button', { name: 'Grid view' }).click();
  await expect(page.locator('.overview-list')).toHaveCount(0);
  await expect(page.locator('.grid').first()).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the list view renders a column header and a metric row', async ({ page }) => {
  const errors = trackErrors(page);
  await seed(page);
  await page.getByRole('button', { name: 'List view' }).click();

  // Column header (desktop-only styling, but always present in the DOM).
  const head = page.locator('.overview-list-head').first();
  await expect(head.locator('.overview-row-metric', { hasText: 'Metric' })).toBeVisible();
  await expect(head.locator('.overview-row-status', { hasText: 'Status' })).toBeVisible();

  // A row per metric, whole row navigates to the detail.
  const glucoseRow = page.locator('.overview-row').filter({ hasText: 'Glucose' });
  await expect(glucoseRow).toHaveCount(1);
  await glucoseRow.click();
  await expect(page.locator('.metric-title', { hasText: 'Glucose' })).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('search narrows the visible list rows', async ({ page }) => {
  const errors = trackErrors(page);
  await seed(page);
  await page.getByRole('button', { name: 'List view' }).click();

  await page.getByPlaceholder('Search metrics…').fill('Gluc');
  await expect(page.locator('.overview-row').filter({ hasText: 'Glucose' })).toHaveCount(1);
  await expect(page.locator('.overview-row').filter({ hasText: 'Hemoglobin' })).toHaveCount(0);

  // Clearing brings the other row back.
  await page.getByPlaceholder('Search metrics…').fill('');
  await expect(page.locator('.overview-row').filter({ hasText: 'Hemoglobin' })).toHaveCount(1);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('a tag chip filters and drops the group headings', async ({ page }) => {
  const errors = trackErrors(page);
  await seed(page);
  await page.getByRole('button', { name: 'List view' }).click();

  // Grouped by default → tag headings present.
  await expect(page.locator('.overview-group-title')).not.toHaveCount(0);

  // Filter to Diabetes → only Glucose, headings gone (flat block).
  await page.locator('.overview-tag-filter .tag-chip', { hasText: 'Diabetes' }).click();
  await expect(page.locator('.overview-row').filter({ hasText: 'Glucose' })).toHaveCount(1);
  await expect(page.locator('.overview-row').filter({ hasText: 'Hemoglobin' })).toHaveCount(0);
  await expect(page.locator('.overview-group-title')).toHaveCount(0);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the clear-filters ghost resets an empty result', async ({ page }) => {
  const errors = trackErrors(page);
  await seed(page);
  await page.getByRole('button', { name: 'List view' }).click();

  await page.getByPlaceholder('Search metrics…').fill('zzzznope');
  await expect(page.getByText('Nothing matches the filter')).toBeVisible();

  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByText('Nothing matches the filter')).toHaveCount(0);
  await expect(page.locator('.overview-row').filter({ hasText: 'Glucose' })).toHaveCount(1);
  await expect(page.getByPlaceholder('Search metrics…')).toHaveValue('');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the list is a 6-column grid; a long name ellipsises without overlap', async ({ page }) => {
  const errors = trackErrors(page);
  // A catalog metric with a deliberately long name (MCHC).
  const longName = 'Mean corpuscular hemoglobin concentration';
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();
  await addValue(page, longName, '340');
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'List view' }).click();

  const row = page.locator('.overview-row').filter({ hasText: longName });
  await expect(row).toHaveCount(1);

  // The header spells all six columns (Range/Change are desktop-only but always
  // in the DOM).
  const head = page.locator('.overview-list-head').first();
  for (const col of ['Metric', 'Latest value', 'Range', 'Change', 'Measured', 'Status']) {
    await expect(head.getByText(col, { exact: true })).toBeVisible();
  }

  // The name cell ellipsises and its right edge stays left of both the value
  // column and the status pill — the grid guarantees no overlap.
  const nameBox = await row.locator('.overview-row-name').boundingBox();
  const valueBox = await row.locator('.overview-row-value').boundingBox();
  const statusBox = await row.locator('.overview-row-status').boundingBox();
  expect(nameBox).not.toBeNull();
  expect(valueBox).not.toBeNull();
  expect(statusBox).not.toBeNull();
  expect(nameBox!.x + nameBox!.width).toBeLessThanOrEqual(valueBox!.x + 1);
  expect(nameBox!.x + nameBox!.width).toBeLessThanOrEqual(statusBox!.x + 1);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the desktop header cells map to the six columns (no overlap, flush left)', async ({
  page,
}) => {
  const errors = trackErrors(page);
  const longName = 'Mean corpuscular hemoglobin concentration';
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();
  await addValue(page, longName, '340');
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'List view' }).click();

  const list = page.locator('.overview-list').first();
  const head = list.locator('.overview-list-head').first();

  // The six header cells sit side by side, each starting at or after the
  // previous cell's right edge — no overlap, no stacking into implicit columns.
  const headCells = [
    head.locator('.overview-row-metric'),
    head.locator('.overview-row-value'),
    head.locator('.overview-row-range'),
    head.locator('.overview-row-change'),
    head.locator('.overview-row-age'),
    head.locator('.overview-row-status'),
  ];
  const boxes = [];
  for (const cell of headCells) {
    const box = await cell.boundingBox();
    expect(box).not.toBeNull();
    boxes.push(box!);
  }
  for (let i = 1; i < boxes.length; i++) {
    // Left of the next cell is not to the left of the previous cell's right.
    expect(boxes[i].x).toBeGreaterThanOrEqual(boxes[i - 1].x + boxes[i - 1].width - 1);
  }

  // The first column starts flush with the card's left edge (content is not
  // jammed to the right into implicit columns).
  const listBox = await list.boundingBox();
  const firstRowMetricBox = await page
    .locator('.overview-row')
    .filter({ hasText: longName })
    .locator('.overview-row-metric')
    .boundingBox();
  expect(listBox).not.toBeNull();
  expect(firstRowMetricBox).not.toBeNull();
  expect(Math.abs(firstRowMetricBox!.x - listBox!.x)).toBeLessThanOrEqual(20);
  // And the header's first cell lines up with the row's first cell.
  expect(Math.abs(boxes[0].x - firstRowMetricBox!.x)).toBeLessThanOrEqual(2);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('an out-of-range value is warn-coloured; the row/card is not', async ({ page }) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();
  // 9 above a reference-high of 5 → the latest Glucose value is above its range.
  await addRangedValue(page, 'Glucose', '9', '5');
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();

  // Grid (default): the card's value number carries the warn class; the card
  // itself is not tinted (no wall of red).
  const card = page.locator('.metric-card').filter({ hasText: 'Glucose' });
  await expect(card.locator('.value-unit--warn')).toHaveCount(1);
  await expect(page.locator('.metric-card--warn')).toHaveCount(0);

  // List: the value cell is warn-coloured and the worded status pill is present
  // (colour is never the only signal) — but the row itself is not tinted.
  await page.getByRole('button', { name: 'List view' }).click();
  const row = page.locator('.overview-row').filter({ hasText: 'Glucose' });
  await expect(row.locator('.overview-row-value .value-unit--warn')).toHaveCount(1);
  await expect(row.locator('.overview-status.above')).toHaveText('above range');
  await expect(row).not.toHaveClass(/warn|danger|above/);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('a ranged metric shows the Range column and its state (never "no range")', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();
  // 90 with a reference-high of 100 → the latest value is within its range.
  await addRangedValue(page, 'Glucose', '90', '100');
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'List view' }).click();

  const row = page.locator('.overview-row').filter({ hasText: 'Glucose' });
  // The Range column carries the actual reference range (not the "—" placeholder).
  const rangeCell = row.locator('.overview-row-range');
  await expect(rangeCell).toContainText('100');
  await expect(rangeCell).not.toHaveText('—');
  // The status is the resolved position, "in range" — NOT the "no range" bug.
  await expect(row.locator('.overview-status')).toHaveText('in range');
  await expect(row.locator('.overview-status.muted')).toHaveCount(0);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('switching Units converts both the value and the Range column', async ({ page }) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();
  // Entered in the English default unit for glucose (mg/dl): value 90, range ≤ 100.
  await addRangedValue(page, 'Glucose', '90', '100');
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'List view' }).click();

  const row = page.locator('.overview-row').filter({ hasText: 'Glucose' });
  await expect(row.locator('.overview-row-value .metric-unit')).toHaveText('mg/dl');
  await expect(row.locator('.overview-row-range')).toContainText('100');

  // Switch Units → SI (mmol/l). Both the value AND the range convert together.
  await page.locator('.app-nav').getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /^SI/ }).click();
  await page.locator('.app-nav').getByRole('button', { name: 'Overview' }).click();

  const siRow = page.locator('.overview-row').filter({ hasText: 'Glucose' });
  await expect(siRow.locator('.overview-row-value .metric-unit')).toHaveText('mmol/l');
  const siRange = siRow.locator('.overview-row-range');
  await expect(siRange).toContainText('5'); // 100 mg/dl ≈ 5.6 mmol/l
  await expect(siRange).not.toContainText('100');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the list rows carry no redundant tag chip', async ({ page }) => {
  const errors = trackErrors(page);
  await seed(page);
  await page.getByRole('button', { name: 'List view' }).click();

  // Grouped by tag: the section heading names the category, so the per-row chip
  // is redundant and is not rendered.
  await expect(page.locator('.overview-group-title')).not.toHaveCount(0);
  await expect(page.locator('.overview-row .tag-chip')).toHaveCount(0);
  await expect(page.locator('.overview-row .tag-chip--mini')).toHaveCount(0);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the phone list drops the Change column (compact two-line row)', async ({ page }) => {
  const errors = trackErrors(page);
  await page.setViewportSize({ width: 390, height: 780 });
  await seed(page);
  await page.getByRole('button', { name: 'List view' }).click();

  const changeCell = page
    .locator('.overview-row')
    .filter({ hasText: 'Glucose' })
    .locator('.overview-row-change');
  await expect(changeCell).toHaveCount(1);
  // Hidden by the mobile layout.
  await expect(changeCell).toBeHidden();

  expect(errors, errors.join('\n')).toEqual([]);
});
