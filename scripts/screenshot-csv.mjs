/**
 * Dev-only: capture the CSV column-mapping and review screens per language
 * and theme. Run: node scripts/screenshot-csv.mjs
 */

import { chromium } from '@playwright/test';
import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import { LANGS, STR, clearToasts, hideChrome } from './screenshot-i18n.mjs';

const PORT = 8124;
const BASE = `http://localhost:${PORT}`;

async function main() {
  mkdirSync('screenshots', { recursive: true });
  const server = spawn('node', ['scripts/serve.js', 'dist', String(PORT)], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 500));

  const browser = await chromium.launch();
  try {
    for (const { lang, locale } of LANGS) {
      const t = STR[lang];
      for (const theme of ['light', 'dark']) {
        const ctx = await browser.newContext({
          viewport: { width: 390, height: 900 },
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

        // Import is now a first-class page: open it, then drop a CSV on the
        // auto-detect dropzone (which routes CSV to the column-mapping screen).
        await page.locator('.app-nav').getByRole('button', { name: t.import }).click();
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser'),
          page.locator('.import-dropzone').click(),
        ]);
        await chooser.setFiles('test/fixtures/labs/cz/lab-cs-semicolon.csv');
        await page.locator('.csv-mapping').waitFor();
        await page.waitForTimeout(150);
        await clearToasts(page);
        await hideChrome(page);
        await page.screenshot({ path: `screenshots/csv-mapping-${lang}-${theme}.png`, fullPage: true });

        await page.getByRole('button', { name: t.continueReview }).click();
        await page.waitForTimeout(150);
        await clearToasts(page);
        await hideChrome(page);
        await page.screenshot({ path: `screenshots/csv-review-${lang}-${theme}.png`, fullPage: true });

        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    server.kill();
  }
  console.log('Wrote screenshots/csv-*.png');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
