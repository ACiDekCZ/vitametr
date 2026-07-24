import { expect, test, type Page } from '@playwright/test';

/**
 * The Metrics ("Veličiny") page: search + used/all/custom filter, a visibility
 * switch and an expandable detail with editable alias chips per metric, a "+"
 * that adds a custom metric, and the pack import/export tools moved here from
 * settings.
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

test('search, filter, toggle visibility and edit aliases on the Metrics page', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await page.locator('.app-nav').getByRole('button', { name: 'Metrics' }).click();
  await expect(page.getByRole('heading', { name: 'Metrics' })).toBeVisible();

  // Default "In use" filter has no measurements yet → empty state.
  await expect(page.locator('.metrics-empty')).toBeVisible();

  // Switch to "All" and search for Glucose.
  await page.locator('.metrics-segment-btn', { hasText: 'All' }).click();
  await page.getByPlaceholder('Search metrics…').fill('Glucose');
  const row = page
    .locator('.metric-row-wrap')
    .filter({ has: page.locator('.metric-row-name', { hasText: /^Glucose$/ }) });
  await expect(row).toHaveCount(1);

  // Visibility switch toggles (on = visible by default).
  const visSwitch = row.getByRole('switch');
  await expect(visSwitch).toHaveAttribute('aria-checked', 'true');
  await visSwitch.click();
  await expect(visSwitch).toHaveAttribute('aria-checked', 'false');

  // Expand its detail and add a custom alias chip.
  await row.getByRole('button', { name: /Details: / }).click();
  await row.getByRole('button', { name: '+ add' }).click();
  await row.getByPlaceholder('Name or abbreviation').fill('Cukr v krvi');
  await row.getByRole('button', { name: '+ add' }).click(); // confirm ✓ (aria-label reuses "+ add")
  await expect(row.getByText('Cukr v krvi')).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the "+" adds a custom metric which shows under the Custom filter', async ({ page }) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await page.locator('.app-nav').getByRole('button', { name: 'Metrics' }).click();
  await page.getByRole('button', { name: 'Add metric' }).click();

  await page.getByLabel('Name', { exact: true }).fill('Sleep score');
  await page.getByRole('button', { name: 'Create new metric' }).click();

  await expect(page.getByText('Metric added')).toBeVisible();
  // The filter auto-switches to Custom, where the new metric is listed.
  await expect(
    page.locator('.metric-row-wrap').filter({ hasText: 'Sleep score' }),
  ).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('Enter in the name field adds the metric (no reaching for the button)', async ({ page }) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await page.locator('.app-nav').getByRole('button', { name: 'Metrics' }).click();
  await page.getByRole('button', { name: 'Add metric' }).click();

  // Type the name and press Enter — the metric is added with the defaults.
  const name = page.getByLabel('Name', { exact: true });
  await name.fill('Mood score');
  await name.press('Enter');

  await expect(page.getByText('Metric added')).toBeVisible();
  await expect(
    page.locator('.metric-row-wrap').filter({ hasText: 'Mood score' }),
  ).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the "+" dialog sets a typed unit, a tag, a LOINC and a generic code on the new metric', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await page.locator('.app-nav').getByRole('button', { name: 'Metrics' }).click();
  await page.getByRole('button', { name: 'Add metric' }).click();
  const dialog = page.getByRole('dialog');

  // Name + a brand-new (freely typed) unit.
  await dialog.getByLabel('Name', { exact: true }).fill('Grip strength');
  await dialog.getByLabel('Unit (optional)').fill('kgf');

  // Tag via the repeatable chip editor (same as the detail): "+ tag" opens the
  // input, "+ tag" again (aria-label reuses the label) confirms.
  await dialog.getByRole('button', { name: '+ tag' }).click();
  await dialog.getByPlaceholder('Tag name').fill('fitness');
  await dialog.getByRole('button', { name: '+ tag' }).click();

  // LOINC via its row editor, and a generic pair via the "+ code" chip.
  const dialogLoinc = dialog.locator('.metric-code-row').filter({ hasText: 'LOINC' });
  await dialogLoinc.getByRole('button').click(); // "+ add" — opens the LOINC input
  await dialogLoinc.getByLabel('LOINC').fill('2345-7');
  await dialogLoinc.getByRole('button', { name: 'Save' }).click();
  await dialog.getByRole('button', { name: '+ code' }).click();
  await dialog.getByLabel('Code system').fill('ACME');
  await dialog.getByLabel('Code', { exact: true }).fill('GRIP-1');
  await dialog.getByRole('button', { name: 'Save' }).click();

  await dialog.getByRole('button', { name: 'Create new metric' }).click();

  await expect(page.getByText('Metric added')).toBeVisible();

  // The new metric auto-expands under the Custom filter — assert its detail.
  const row = page.locator('.metric-row-wrap').filter({ hasText: 'Grip strength' });
  await expect(row).toBeVisible();
  // Tag chip shows.
  await expect(row.locator('.metric-chip', { hasText: 'fitness' })).toBeVisible();
  // LOINC saved.
  const loincRow = row.locator('.metric-code-row').filter({ hasText: 'LOINC' });
  await expect(loincRow.locator('.metric-code-value', { hasText: '2345-7' })).toBeVisible();
  // Generic pair saved.
  await expect(
    row.locator('.metric-code-row').filter({ hasText: 'ACME' }).getByText('GRIP-1'),
  ).toBeVisible();
  // Typed unit is carried onto the metric.
  await expect(row.getByText('kgf')).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the "+" dialog ignores an invalid LOINC without failing the create', async ({ page }) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await page.locator('.app-nav').getByRole('button', { name: 'Metrics' }).click();
  await page.getByRole('button', { name: 'Add metric' }).click();
  const dialog = page.getByRole('dialog');

  await dialog.getByLabel('Name', { exact: true }).fill('Balance score');
  // Try to set an invalid LOINC via its row editor: the inline hint flags it and
  // the edit does not commit, so create stays non-blocking (LOINC not saved).
  const dialogLoinc = dialog.locator('.metric-code-row').filter({ hasText: 'LOINC' });
  await dialogLoinc.getByRole('button').click(); // "+ add"
  await dialogLoinc.getByLabel('LOINC').fill('not-a-loinc');
  await dialogLoinc.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.modal-box .metric-code-error')).toBeVisible();
  await dialog.getByRole('button', { name: 'Create new metric' }).click();

  await expect(page.getByText('Metric added')).toBeVisible();
  const row = page.locator('.metric-row-wrap').filter({ hasText: 'Balance score' });
  await expect(row).toBeVisible();
  // The invalid LOINC was simply not saved — the LOINC row shows "Not set".
  const loincRow = row.locator('.metric-code-row').filter({ hasText: 'LOINC' });
  await expect(loincRow.locator('.metric-code-value.is-empty')).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('edit LOINC and add an external code on a metric detail; both persist across reload', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await page.locator('.app-nav').getByRole('button', { name: 'Metrics' }).click();
  await page.locator('.metrics-segment-btn', { hasText: 'All' }).click();
  await page.getByPlaceholder('Search metrics…').fill('Glucose');
  const row = page
    .locator('.metric-row-wrap')
    .filter({ has: page.locator('.metric-row-name', { hasText: /^Glucose$/ }) });
  await expect(row).toHaveCount(1);

  // Expand the detail (advanced "External codes" section is at the bottom).
  await row.getByRole('button', { name: /Details: / }).click();
  await expect(row.getByText('External codes')).toBeVisible();

  const loincRow = row.locator('.metric-code-row').filter({ hasText: 'LOINC' });

  // Invalid LOINC shows the inline error and does not persist.
  await loincRow.getByRole('button', { name: 'Edit' }).click();
  await loincRow.getByLabel('LOINC').fill('not-a-loinc');
  await loincRow.getByRole('button', { name: 'Save' }).click();
  await expect(row.locator('.metric-code-error')).toBeVisible();

  // A valid LOINC saves.
  await loincRow.getByLabel('LOINC').fill('2345-7');
  await loincRow.getByRole('button', { name: 'Save' }).click();
  await expect(loincRow.locator('.metric-code-value', { hasText: '2345-7' })).toBeVisible();

  // Add a generic external code pair (system typed freely by the user).
  await row.getByRole('button', { name: '+ code' }).click();
  await row.getByLabel('Code system').fill('ACME');
  await row.getByLabel('Code', { exact: true }).fill('03123');
  await row.getByRole('button', { name: 'Save' }).click();
  const pairRow = row.locator('.metric-code-row').filter({ hasText: 'ACME' });
  await expect(pairRow.locator('.metric-code-value', { hasText: '03123' })).toBeVisible();

  // Reload: both the edited LOINC and the added pair persist and show.
  // Give the debounced write time to persist first (matches the tags spec).
  await page.waitForTimeout(700);
  await page.reload();
  await page.locator('.app-nav').getByRole('button', { name: 'Metrics' }).click();
  await page.locator('.metrics-segment-btn', { hasText: 'All' }).click();
  await page.getByPlaceholder('Search metrics…').fill('Glucose');
  const row2 = page
    .locator('.metric-row-wrap')
    .filter({ has: page.locator('.metric-row-name', { hasText: /^Glucose$/ }) });
  await row2.getByRole('button', { name: /Details: / }).click();
  const loincRow2 = row2.locator('.metric-code-row').filter({ hasText: 'LOINC' });
  await expect(loincRow2.locator('.metric-code-value', { hasText: '2345-7' })).toBeVisible();
  await expect(
    row2.locator('.metric-code-row').filter({ hasText: 'ACME' }).getByText('03123'),
  ).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('a metric detail can add several external codes in a row (persistent "+ code")', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  // A fresh custom metric with an open detail.
  await page.locator('.app-nav').getByRole('button', { name: 'Metrics' }).click();
  await page.getByRole('button', { name: 'Add metric' }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Multi code');
  await page.getByRole('dialog').getByRole('button', { name: 'Create new metric' }).click();
  const row = page.locator('.metric-row-wrap').filter({ hasText: 'Multi code' });
  await expect(row).toBeVisible();

  // Add two generic code pairs one after another — before the fix the "+ code"
  // chip vanished after the first, so only one extra code could be added.
  for (const [system, code] of [
    ['ACME', 'A-1'],
    ['NCLP', 'N-2'],
  ]) {
    await row.getByRole('button', { name: '+ code' }).click();
    await row.getByLabel('Code system').fill(system);
    await row.getByLabel('Code', { exact: true }).fill(code);
    await row.getByRole('button', { name: 'Save' }).click();
    await expect(row.locator('.metric-code-row').filter({ hasText: system }).getByText(code)).toBeVisible();
  }

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the pack export opens as a modal dialog (not a bottom toggle)', async ({ page }) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await page.locator('.app-nav').getByRole('button', { name: 'Metrics' }).click();
  await page.getByRole('button', { name: 'Export pack' }).click();

  // The catalog tools live in a modal dialog now: selection + export, plus a
  // Close. (The catalog Reset action was removed — pack toggles replace it.)
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Export as pack' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Reset to default' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the "+" dialog adds multiple aliases, tags and codes repeatedly', async ({ page }) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await page.locator('.app-nav').getByRole('button', { name: 'Metrics' }).click();
  await page.getByRole('button', { name: 'Add metric' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Panel metric');

  // Two aliases via the repeatable chip editor.
  for (const alias of ['Alpha', 'Beta']) {
    await dialog.getByRole('button', { name: '+ add' }).first().click();
    await dialog.getByPlaceholder('Name or abbreviation').fill(alias);
    await dialog.getByRole('button', { name: '+ add' }).first().click(); // confirm ✓
  }
  await expect(dialog.locator('.metric-chip-text', { hasText: 'Alpha' })).toBeVisible();
  await expect(dialog.locator('.metric-chip-text', { hasText: 'Beta' })).toBeVisible();

  // Two tags via the repeatable chip editor.
  for (const tag of ['fitness', 'sleep']) {
    await dialog.getByRole('button', { name: '+ tag' }).click();
    await dialog.getByPlaceholder('Tag name').fill(tag);
    await dialog.getByRole('button', { name: '+ tag' }).click(); // confirm ✓
  }
  await expect(dialog.locator('.metric-chip-text', { hasText: 'fitness' })).toBeVisible();
  await expect(dialog.locator('.metric-chip-text', { hasText: 'sleep' })).toBeVisible();

  // Two generic code pairs via the persistent "+ code" chip — the fix means the
  // chip stays after each add, so a second pair can be added without reopening.
  for (const [system, code] of [
    ['ACME', 'A-1'],
    ['NCLP', 'N-2'],
  ]) {
    await dialog.getByRole('button', { name: '+ code' }).click();
    await dialog.getByLabel('Code system').fill(system);
    await dialog.getByLabel('Code', { exact: true }).fill(code);
    await dialog.getByRole('button', { name: 'Save' }).click();
  }
  await expect(dialog.locator('.metric-code-row').filter({ hasText: 'ACME' })).toBeVisible();
  await expect(dialog.locator('.metric-code-row').filter({ hasText: 'NCLP' })).toBeVisible();

  await dialog.getByRole('button', { name: 'Create new metric' }).click();
  await expect(page.getByText('Metric added')).toBeVisible();

  // Both code pairs persisted onto the new metric's detail.
  const row = page.locator('.metric-row-wrap').filter({ hasText: 'Panel metric' });
  await expect(row.locator('.metric-code-row').filter({ hasText: 'ACME' }).getByText('A-1')).toBeVisible();
  await expect(row.locator('.metric-code-row').filter({ hasText: 'NCLP' }).getByText('N-2')).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the "+" dialog hides the Tags section when tags are turned off', async ({ page }) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  // Turn tags off in Settings.
  await page.locator('.app-nav').getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('switch', { name: 'Use tags' }).click();

  await page.locator('.app-nav').getByRole('button', { name: 'Metrics' }).click();
  await page.getByRole('button', { name: 'Add metric' }).click();
  const dialog = page.getByRole('dialog');

  // No Tags section (no "+ tag" chip) when tags are off; aliases/codes remain.
  await expect(dialog.getByRole('button', { name: '+ tag' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '+ add' }).first()).toBeVisible();
  await expect(dialog.getByRole('button', { name: '+ code' })).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('quick-create on entry offers "Add details" that opens the new metric on the Metrics page', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();
  await page.evaluate(() => {
    window.location.hash = '#/entry';
  });

  // Quick-create a metric inline (unit-only), enter a value and save.
  await page.getByLabel('Metric', { exact: true }).first().fill('Handgrip');
  await page.getByRole('button', { name: /Create new metric —/ }).click();
  await page.getByLabel('Unit (optional)').first().fill('kg');
  await page.getByRole('button', { name: 'Create new metric', exact: true }).click();
  await page.getByLabel('Value', { exact: true }).first().fill('42');
  await page.getByRole('button', { name: /^Add$/ }).click();

  // The toast carries an "Add details" action → lands on the metric's detail.
  await page.getByRole('button', { name: 'Add details' }).click();
  await expect(page).toHaveURL(/#\/metrics-manage\//);
  const row = page.locator('.metric-row-wrap').filter({ hasText: 'Handgrip' });
  await expect(row).toBeVisible();
  // The detail is expanded (its "External codes" section shows).
  await expect(row.getByText('External codes')).toBeVisible();
  // And it lives under the Custom filter.
  await expect(page.locator('.metrics-segment-btn.is-active', { hasText: 'Custom' })).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});
