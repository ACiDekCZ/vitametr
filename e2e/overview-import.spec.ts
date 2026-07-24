import { expect, test, type Page } from '@playwright/test';
import { reachReview } from './support/pass-import-filter';

/**
 * The empty/sparse overview makes Import the primary action: its button opens a
 * file picker directly and auto-detects the file, routing it to the destination
 * that fits the file type — review for data files, the Veličiny (metrics) page
 * for a metric pack. Manual entry is the secondary action. An unrecognised file
 * is still tried by the generic lab parser before a clear unknown-format toast.
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
  await page.getByRole('button', { name: /Create profile|Vytvořit profil/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();
  // A fresh profile has no data, so the overview shows its empty prompt.
  await expect(page.locator('.overview-prompt')).toBeVisible();
});

/** The overview's own primary Import button (not the nav's Import entry). */
function overviewImport(page: Page) {
  return page.locator('.overview-prompt').getByRole('button', { name: /^Import$/ });
}

test('the empty overview promotes Import as the primary action; entry is secondary', async ({
  page,
}) => {
  const prompt = page.locator('.overview-prompt');
  await expect(prompt).toBeVisible();
  // Import is the primary button; "Add values" is present but not primary.
  await expect(prompt.locator('button.primary')).toHaveText(/^Import$/);
  await expect(prompt.getByRole('button', { name: /Add values|Zadat hodnoty/ })).toBeVisible();
  await expect(
    prompt.getByRole('button', { name: /Add values|Zadat hodnoty/ }),
  ).not.toHaveClass(/primary/);
});

test('the primary Import button opens a file chooser and a FHIR file lands in review', async ({
  page,
}) => {
  const errors = trackErrors(page);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    overviewImport(page).click(),
  ]);
  await chooser.setFiles('test/fixtures/fhir-bundle.json');

  await reachReview(page);
  await page.getByRole('button', { name: /Import selected/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('a CSV picked from the overview goes to the column-mapping screen', async ({ page }) => {
  const errors = trackErrors(page);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    overviewImport(page).click(),
  ]);
  await chooser.setFiles('test/fixtures/labs/cz/lab-cs-semicolon.csv');
  await expect(page).toHaveURL(/#\/import-csv$/, { timeout: 20000 });
  expect(errors, errors.join('\n')).toEqual([]);
});

test('a metric pack picked from the overview lands on the Veličiny page', async ({ page }) => {
  const errors = trackErrors(page);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    overviewImport(page).click(),
  ]);
  await chooser.setFiles('test/fixtures/demo-pack-metrics-only.json');

  // A metrics-defining pack routes to the metrics manager (not review).
  await expect(page).toHaveURL(/#\/metrics-manage$/, { timeout: 20000 });
  // The pack's metric is visible once the filter includes non-used metrics.
  await page.getByRole('button', { name: /^All$|^Vše$/ }).click();
  await expect(page.getByText('Demo feritin').first()).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('an unrecognised but parseable text file is imported via the generic fallback', async ({
  page,
}) => {
  const errors = trackErrors(page);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    overviewImport(page).click(),
  ]);
  // Plain .txt lab lines: not a known format, but the generic parser reads them.
  await chooser.setFiles('test/fixtures/lab-plain-fallback.txt');

  await reachReview(page);
  await page.getByRole('button', { name: /Import selected/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('a truly unreadable file shows the unknown-format toast', async ({ page }) => {
  const errors = trackErrors(page);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    overviewImport(page).click(),
  ]);
  await chooser.setFiles('test/fixtures/garbage.bin');

  await expect(page.locator('.toast')).toContainText(/Unknown format|could not be read|Nerozpoznaný/i);
  // No navigation away from the overview on failure — its prompt is still shown.
  await expect(page.locator('.overview-prompt')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});
