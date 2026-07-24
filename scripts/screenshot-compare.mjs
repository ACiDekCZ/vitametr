/** Dev-only: capture the Compare-over-time screen per language and theme. */
import { chromium } from '@playwright/test';
import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import { LANGS, STR, clearToasts } from './screenshot-i18n.mjs';

const PORT = 8126;
const BASE = `http://localhost:${PORT}`;
const DAYS = ['2025-03-01', '2025-06-01', '2025-09-01', '2025-12-01'];

async function addValue(page, t, name, value, date) {
  await page.locator('.app-nav').getByRole('button', { name: t.addValues }).click();
  const m = page.getByLabel(t.metric, { exact: true }).first();
  await m.fill(name);
  await m.press('Enter');
  await page.getByLabel(t.value, { exact: true }).first().fill(String(value));
  await page.locator('input[type="date"]').first().fill(date);
  await page.getByRole('button', { name: t.add }).click();
  await page.waitForTimeout(50);
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
        const ctx = await browser.newContext({ viewport: { width: 390, height: 1200 }, colorScheme: theme, locale, deviceScaleFactor: 2 });
        const page = await ctx.newPage();
        await page.goto(BASE);
        await page.evaluate(async () => {
          for (const db of (await indexedDB.databases?.()) ?? []) if (db.name) indexedDB.deleteDatabase(db.name);
        });
        await page.goto(BASE);
        await page.getByRole('button', { name: t.createProfile }).click();
        await page.locator('.app-nav').waitFor();

        // Correlated-ish series over the same days.
        const glu = [5.0, 5.4, 5.8, 6.1];
        const wt = [80, 82, 84, 86];
        for (let i = 0; i < DAYS.length; i++) {
          await addValue(page, t, t.glucose, glu[i], DAYS[i]);
          await addValue(page, t, t.bodyWeight, wt[i], DAYS[i]);
        }

        await page.locator('.app-nav').getByRole('button', { name: t.compare }).click();
        await page.getByText(t.glucose, { exact: true }).click();
        await page.getByText(t.bodyWeight, { exact: true }).click();
        await page.waitForTimeout(250);
        await clearToasts(page);
        await page.screenshot({ path: `screenshots/compare-${lang}-${theme}.png`, fullPage: true });
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    server.kill();
  }
  console.log('Wrote screenshots/compare-*.png');
}
main().catch((e) => { console.error(e); process.exit(1); });
