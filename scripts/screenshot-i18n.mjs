/**
 * Dev-only: shared locale table for the screenshot scripts. The scripts drive
 * the real UI by visible text, so every string they click on has to exist per
 * language (values mirror src/i18n/{en,cs}.ts — update together).
 */

/**
 * Seeding values through the entry UI pops a "Saved" toast per value; they
 * linger (and stack) long enough to land in the capture. Drop them before
 * every screenshot.
 */
export async function clearToasts(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.toast-host .toast').forEach((t) => t.remove());
  });
}

/**
 * Full-page captures repaint fixed/sticky chrome (bottom nav + FAB, sticky
 * header) at the viewport's scroll position, i.e. floating mid-content.
 * Hide it for screens taller than the viewport.
 */
export async function hideChrome(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.app-nav, .app-header').forEach((n) => {
      n.style.display = 'none';
    });
  });
}

export const LANGS = [
  { lang: 'en', locale: 'en-US' },
  { lang: 'cs', locale: 'cs-CZ' },
];

export const STR = {
  en: {
    addValues: 'Add values',
    overview: 'Overview',
    settings: 'Settings',
    import: 'Import',
    export: 'Export',
    metrics: 'Metrics',
    metric: 'Metric',
    value: 'Value',
    add: /^Add$/,
    createProfile: /Create profile/,
    summary: /Summary/,
    compare: /Compare/,
    continueReview: /Continue to review/,
    listView: 'List view',
    glucose: 'Glucose',
    bodyWeight: 'Body weight',
    totalCholesterol: 'Total cholesterol',
    ldlCholesterol: 'LDL cholesterol',
    creatinine: 'Creatinine',
    tsh: 'TSH',
  },
  cs: {
    addValues: 'Zadat hodnoty',
    overview: 'Přehled',
    settings: 'Nastavení',
    import: 'Import',
    export: 'Export',
    metrics: 'Veličiny',
    metric: 'Veličina',
    value: 'Hodnota',
    add: /^Přidat$/,
    createProfile: /Vytvořit profil/,
    summary: /Souhrn/,
    compare: /Porovnat/,
    continueReview: /Pokračovat na kontrolu/,
    listView: 'Zobrazení seznam',
    glucose: 'Glukóza',
    bodyWeight: 'Hmotnost',
    totalCholesterol: 'Celkový cholesterol',
    ldlCholesterol: 'LDL cholesterol',
    creatinine: 'Kreatinin',
    tsh: 'TSH',
  },
};
