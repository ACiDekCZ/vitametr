/**
 * Dev-only: boot the built app in a headless browser, seed a few measurements
 * across time, and capture screenshots of the overview and the metric chart.
 * Runs per language (en, cs) and theme (light, dark); the browser context's
 * locale drives the app language. Not part of the shipped app.
 * Run: node scripts/screenshots.mjs
 */

import { chromium } from '@playwright/test';
import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import { LANGS, STR, clearToasts } from './screenshot-i18n.mjs';

const PORT = 8123;
const BASE = `http://localhost:${PORT}`;

function serve() {
  const proc = spawn('node', ['scripts/serve.js', 'dist', String(PORT)], { stdio: 'ignore' });
  return proc;
}

async function seed(page, t) {
  // Seed measurements through the real entry UI (deterministic, and the
  // date input is locale-independent).
  const values = [
    { d: '2023-02-10', v: '6.1' },
    { d: '2023-08-14', v: '5.9' },
    { d: '2024-03-02', v: '6.4' },
    { d: '2024-09-20', v: '5.7' },
    { d: '2025-04-11', v: '6.0' },
    { d: '2026-01-15', v: '5.5' },
  ];
  // The FAB opens the add-data menu now; reach the entry page directly by hash.
  await page.evaluate(() => { window.location.hash = '#/entry'; });
  for (const { d, v } of values) {
    const metric = page.getByLabel(t.metric, { exact: true }).first();
    await metric.fill(t.glucose);
    await metric.press('Enter');
    await page.getByLabel(t.value, { exact: true }).first().fill(v);
    // Set the date input (first date field).
    const date = page.locator('input[type="date"]').first();
    await date.fill(d);
    await page.getByRole('button', { name: t.add }).click();
    await page.waitForTimeout(80);
  }
}

async function main() {
  mkdirSync('screenshots', { recursive: true });
  const server = serve();
  await new Promise((r) => setTimeout(r, 500));

  const browser = await chromium.launch();
  try {
    for (const { lang, locale } of LANGS) {
      const t = STR[lang];
      for (const theme of ['light', 'dark']) {
        const ctx = await browser.newContext({
          viewport: { width: 390, height: 780 },
          colorScheme: theme,
          locale,
          deviceScaleFactor: 2,
        });
        const page = await ctx.newPage();
        await page.goto(BASE);
        await page.evaluate(async () => {
          for (const db of (await indexedDB.databases?.()) ?? []) {
            if (db.name) indexedDB.deleteDatabase(db.name);
          }
        });
        await page.goto(BASE);
        await page.getByRole('button', { name: t.createProfile }).click();
        await page.locator('.app-nav').waitFor();

        await seed(page, t);

        await page.locator('.app-nav').getByRole('button', { name: t.overview }).click();
        await page.waitForTimeout(150);
        await clearToasts(page);
        await page.screenshot({ path: `screenshots/overview-${lang}-${theme}.png` });

        // List layout of the overview (grid ↔ list toggle).
        await page.getByRole('button', { name: t.listView }).click();
        await page.waitForTimeout(150);
        await clearToasts(page);
        await page.screenshot({ path: `screenshots/overview-list-${lang}-${theme}.png` });

        await page.locator('.app-content button').filter({ hasText: t.glucose }).first().click();
        await page.waitForTimeout(200);
        await clearToasts(page);
        await page.screenshot({ path: `screenshots/metric-${lang}-${theme}.png` });

        // Import page (reached by hash — the nav slot moved into the FAB menu).
        await page.evaluate(() => { window.location.hash = '#/import'; });
        await page.waitForTimeout(150);
        await clearToasts(page);
        await page.screenshot({ path: `screenshots/import-${lang}-${theme}.png` });

        // Export page — reached via the Import ⇄ Export switcher at the top.
        await page.locator('.data-switch').getByRole('button', { name: t.export }).click();
        await page.waitForTimeout(150);
        await clearToasts(page);
        await page.screenshot({ path: `screenshots/export-${lang}-${theme}.png` });

        // Veličiny (metrics management) page.
        await page.locator('.app-nav').getByRole('button', { name: t.metrics }).click();
        await page.waitForTimeout(150);
        await clearToasts(page);
        await page.screenshot({ path: `screenshots/metrics-${lang}-${theme}.png` });

        // Pre-import filter ("What to import") — reached by a large CSV import
        // (60 rows across three metrics), which trips the "worth filtering" bar.
        await page.evaluate(() => { window.location.hash = '#/import'; });
        await page.waitForTimeout(100);
        await page.locator('.import-segment-btn').nth(1).click(); // Specific format
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser'),
          page.locator('.format-card', { hasText: 'CSV' }).first().click(),
        ]);
        await chooser.setFiles('test/fixtures/labs/cz/lab-cs-large.csv');
        await page.locator('.csv-mapping').waitFor();
        await page.getByRole('button', { name: t.continueReview }).click();
        await page.locator('.import-filter-view').waitFor();
        await page.waitForTimeout(150);
        await clearToasts(page);
        await page.screenshot({ path: `screenshots/import-filter-${lang}-${theme}.png` });

        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    server.kill();
  }
  console.log('Wrote screenshots/*.png');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
