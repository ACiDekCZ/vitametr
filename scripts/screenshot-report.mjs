/** Dev-only: capture the health summary report per language and theme. */
import { chromium } from '@playwright/test';
import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import { LANGS, STR, clearToasts, hideChrome } from './screenshot-i18n.mjs';

const PORT = 8125;
const BASE = `http://localhost:${PORT}`;

async function addValue(page, t, name, value) {
  await page.locator('.app-nav').getByRole('button', { name: t.addValues }).click();
  const m = page.getByLabel(t.metric, { exact: true }).first();
  await m.fill(name);
  await m.press('Enter');
  await page.getByLabel(t.value, { exact: true }).first().fill(String(value));
  await page.getByRole('button', { name: t.add }).click();
  await page.waitForTimeout(60);
}

async function main() {
  mkdirSync('screenshots', { recursive: true });
  const server = spawn('node', ['scripts/serve.js', 'dist', String(PORT)], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 500));
  const browser = await chromium.launch();
  try {
    for (const { lang, locale } of LANGS) {
      const t = STR[lang];
      for (const theme of ['light', 'dark']) {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 1100 }, colorScheme: theme, locale, deviceScaleFactor: 2 });
        const page = await ctx.newPage();
        await page.goto(BASE);
        await page.evaluate(async () => {
          for (const db of (await indexedDB.databases?.()) ?? []) if (db.name) indexedDB.deleteDatabase(db.name);
        });
        await page.goto(BASE);
        await page.getByRole('button', { name: t.createProfile }).click();
        await page.locator('.app-nav').waitFor();

        for (const [name, v] of [
          [t.glucose, 95], [t.totalCholesterol, 205], [t.ldlCholesterol, 130],
          [t.creatinine, 0.9], [t.tsh, 2.1], [t.bodyWeight, 82.5],
        ]) await addValue(page, t, name, v);

        await page.locator('.app-nav').getByRole('button', { name: t.overview }).click();
        await page.locator('.overview-header').getByRole('button', { name: t.summary }).click();
        await page.locator('.report').waitFor();
        await page.waitForTimeout(150);
        await clearToasts(page);
        await hideChrome(page);
        await page.screenshot({ path: `screenshots/report-${lang}-${theme}.png`, fullPage: true });
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    server.kill();
  }
  console.log('Wrote screenshots/report-*.png');
}
main().catch((e) => { console.error(e); process.exit(1); });
