import { expect, test, type Page } from '@playwright/test';

/** Import an Apple Health export.xml (many device types at once) → review → overview. */

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

test('Apple Health export.xml imports vitals across device types', async ({ page }) => {
  const errors = trackErrors(page);

  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  await page.evaluate(() => { window.location.hash = '#/import'; });
  await page.getByRole('button', { name: 'Specific format' }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.format-card', { hasText: 'Apple Health' }).click(),
  ]);
  await chooser.setFiles('test/fixtures/sources/apple-health/export-sample.xml');

  await expect(page).toHaveURL(/#\/review$/, { timeout: 20000 });
  await page.getByRole('button', { name: /Import selected/ }).click();

  await expect(page).toHaveURL(/#\/overview$/);
  await expect(
    page.locator('.app-content button').filter({ hasText: 'Body weight' }).first(),
  ).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

// --- Tiny stored-method .zip builder (no compression, CRC left 0; the reader
// ignores CRC). Produces a real Apple-Health-shaped archive: export.xml plus a
// redundant export_cda.xml that must be ignored. ---
function u16(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff];
}
function u32(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
}
function buildStoredZip(files: Array<{ name: string; text: string }>): Buffer {
  const enc = new TextEncoder();
  const local: number[] = [];
  const central: number[] = [];
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = enc.encode(f.text);
    const offset = local.length;
    local.push(...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0));
    local.push(...u32(0), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0));
    local.push(...name, ...data);
    central.push(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0));
    central.push(...u32(0), ...u32(data.length), ...u32(data.length), ...u16(name.length));
    central.push(...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset));
    central.push(...name);
  }
  const cdOffset = local.length;
  const eocd: number[] = [
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
    ...u32(central.length), ...u32(cdOffset), ...u16(0),
  ];
  return Buffer.from([...local, ...central, ...eocd]);
}

test('Apple Health .zip imports export.xml and ignores export_cda.xml', async ({ page }) => {
  const errors = trackErrors(page);

  await page.getByRole('button', { name: /Create profile/ }).click();
  await expect(page.locator('.app-nav')).toBeVisible();

  const exportXml =
    '<?xml version="1.0"?><HealthData locale="en_US">' +
    '<Record type="HKQuantityTypeIdentifierBodyMass" sourceName="Scale" unit="kg" value="82.5" startDate="2025-02-10 08:00:00 +0100"/>' +
    '<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" value="66" startDate="2025-02-10 08:00:00 +0100"/>' +
    '<Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" value="9000" startDate="2025-02-10 00:00:00 +0100"/>' +
    '</HealthData>';
  const zip = buildStoredZip([
    { name: 'apple_health_export/export_cda.xml', text: '<ClinicalDocument>ignored</ClinicalDocument>' },
    { name: 'apple_health_export/export.xml', text: exportXml },
  ]);

  await page.evaluate(() => { window.location.hash = '#/import'; });
  await page.getByRole('button', { name: 'Specific format' }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.format-card', { hasText: 'Apple Health' }).click(),
  ]);
  await chooser.setFiles({ name: 'export.zip', mimeType: 'application/zip', buffer: zip });

  await expect(page).toHaveURL(/#\/review$/, { timeout: 20000 });
  await page.getByRole('button', { name: /Import selected/ }).click();

  await expect(page).toHaveURL(/#\/overview$/);
  await expect(
    page.locator('.app-content button').filter({ hasText: 'Body weight' }).first(),
  ).toBeVisible();
  // Heart rate imported too, StepCount ignored (unmapped), CDA never parsed.
  await expect(
    page.locator('.app-content button').filter({ hasText: 'Heart rate' }).first(),
  ).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});
