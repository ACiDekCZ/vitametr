/** Dev-only: capture a metric's time series WITH its reference band.
 *  Seeds via a synthetic backup import (measurements already carry refLow/High). */
import { chromium } from '@playwright/test';
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';

const PORT = 8127;
const BASE = `http://localhost:${PORT}`;

// Glucose over a year, reference 3.9–5.6 mmol/L, a couple of points above.
const days = ['2025-02-01', '2025-04-01', '2025-06-01', '2025-08-01', '2025-10-01', '2025-12-01'];
const values = [4.8, 5.2, 6.0, 5.1, 5.9, 4.9];
const measurements = days.map((d, i) => ({
  id: `m${i}`,
  profileId: 'p',
  metricId: 'builtin:glucose',
  value: values[i],
  unit: 'mmol/L',
  takenAt: `${d}T08:00:00`,
  timePrecision: 'date',
  refLow: 3.9,
  refHigh: 5.6,
  status: 'confirmed',
  origin: { pluginId: 'seed' },
  createdAt: `${d}T08:00:00`,
  modifiedAt: `${d}T08:00:00`,
}));
const backup = {
  format: 'vitametr-backup',
  backupVersion: 1,
  schemaVersion: 1,
  profile: { id: 'p', name: 'Demo', createdAt: '2025-01-01T00:00:00Z' },
  metrics: [],
  sources: [],
  measurements,
  settings: {},
};
const BACKUP_PATH = '/tmp/vitametr-bounds-backup.json';
writeFileSync(BACKUP_PATH, JSON.stringify(backup));

async function main() {
  mkdirSync('screenshots', { recursive: true });
  const server = spawn('node', ['scripts/serve.js', 'dist', String(PORT)], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 500));
  const browser = await chromium.launch();
  try {
    for (const theme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, colorScheme: theme, deviceScaleFactor: 2, locale: 'cs-CZ' });
      const page = await ctx.newPage();
      await page.goto(BASE);
      await page.evaluate(async () => {
        for (const db of (await indexedDB.databases?.()) ?? []) if (db.name) indexedDB.deleteDatabase(db.name);
      });
      await page.goto(BASE);
      // Onboarding in Czech: pick "no encryption" then create.
      await page.getByRole('button', { name: /Vytvořit profil/ }).click();
      await page.locator('.app-nav').waitFor();

      // Import the backup via the Import page's auto-detect dropzone → review.
      await page.locator('.app-nav').getByRole('button', { name: 'Import' }).click();
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.locator('.import-dropzone').click(),
      ]);
      await chooser.setFiles(BACKUP_PATH);
      await page.waitForURL(/#\/review$/);
      await page.getByRole('button', { name: /Importovat vybrané/ }).click();
      await page.waitForURL(/#\/overview$/);

      // Open the glucose detail (chart with reference band).
      await page.locator('.app-content button').filter({ hasText: 'Glukóza' }).first().click();
      await page.locator('svg[role="img"]').waitFor();
      await page.waitForTimeout(250);
      await page.screenshot({ path: `screenshots/bounds-${theme}.png` });
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.kill();
  }
  console.log('Wrote screenshots/bounds-*.png');
}
main().catch((e) => { console.error(e); process.exit(1); });
