/**
 * Import page (redesign IA, screen 1).
 *
 * A first-class route (not a settings subsection) for getting data into the app.
 * A large dropzone auto-detects any dropped/picked file and routes it straight
 * to review; a segmented control switches to a grid of per-format cards for when
 * the format should be chosen explicitly. All import logic lives in
 * `import-actions.ts` (shared with the transitional settings section) and the
 * card/accept descriptors in `import-model.ts`; this file is view wiring only.
 *
 * File inputs are always a hidden `<input type="file">` triggered from the nice
 * cards/buttons — never a visible raw native input. All user text goes through
 * `ctx.t`.
 */

import type { AppContext, View } from '../app-context';
import type { StringKey } from '../../i18n/index';
import { formatDateTime, formatNumber, plural } from '../../i18n/index';
import type { ImportRecord } from '../../core/types';
import {
  importsNewestFirst,
  removeImportAndMetrics,
  unusedMetricsCreatedByImport,
} from '../../core/imports';
import { switchControl } from '../components/switch';
import { dataSwitch } from '../components/data-switch';
import {
  getImportKnownOnly,
  getOfferHiddenMetrics,
  runAutoImport,
  runCsvImport,
  runImport,
  runPackImport,
  runPdfImport,
  runPluginImport,
  setImportKnownOnly,
  setOfferHiddenMetrics,
} from './import-actions';
import { ACCEPT_AUTO, FORMAT_CARDS, type FormatCard } from './import-model';
import { pendingImportCount } from './review';
import './import.css';

function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function textEl(tag: string, text: string, className?: string): HTMLElement {
  const node = el(tag, className);
  node.textContent = text;
  return node;
}

/** Upload glyph for the dropzone tile. */
function uploadIcon(className: string): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const arrow = document.createElementNS(ns, 'path');
  arrow.setAttribute('d', 'M12 16 V4 M7 9 l5 -5 l5 5');
  const tray = document.createElementNS(ns, 'path');
  tray.setAttribute('d', 'M4 15 v4 a1 1 0 0 0 1 1 h14 a1 1 0 0 0 1 -1 v-4');
  svg.append(arrow, tray);
  return svg;
}

/** Friendly label for a recorded import's plugin, reusing the format-card names. */
const PLUGIN_LABEL_KEY: Record<string, StringKey> = {
  pdf: 'import.card.pdf.name',
  csv: 'import.card.csv.name',
  'json-backup': 'import.card.json.name',
  fhir: 'import.card.fhir.name',
  'apple-health': 'import.card.apple.name',
  hl7v2: 'import.card.hl7.name',
  pack: 'import.card.pack.name',
};

function pluginLabel(ctx: AppContext, pluginId: string): string {
  const key = PLUGIN_LABEL_KEY[pluginId];
  return key ? ctx.t(key) : pluginId;
}

/**
 * "Recent imports" history: each recorded file import, newest-first, with an
 * inline double-confirm Undo that removes the import's measurements and record.
 * `section` is re-rendered in place after an undo so the list stays current.
 */
function renderHistory(ctx: AppContext, section: HTMLElement): void {
  const { t } = ctx;
  section.replaceChildren();
  section.append(textEl('h2', t('import.historyTitle'), 'import-history-title'));

  const records = importsNewestFirst(ctx.data().imports ?? []);
  if (records.length === 0) {
    section.append(textEl('p', t('import.historyEmpty'), 'import-history-empty muted'));
    return;
  }

  const list = el('ul', 'import-history-list');
  for (const record of records) {
    list.append(renderHistoryRow(ctx, section, record));
  }
  section.append(list);
}

function renderHistoryRow(ctx: AppContext, section: HTMLElement, record: ImportRecord): HTMLElement {
  const row = el('li', 'import-history-row card');
  renderHistoryRowIdle(ctx, section, row, record);
  return row;
}

function renderHistoryRowIdle(
  ctx: AppContext,
  section: HTMLElement,
  row: HTMLElement,
  record: ImportRecord,
): void {
  const { t } = ctx;
  row.replaceChildren();
  row.classList.remove('is-confirming');

  const text = el('div', 'import-history-text');
  const primary = record.fileName ?? record.sourceName ?? pluginLabel(ctx, record.pluginId);
  text.append(textEl('span', primary, 'import-history-name'));
  const metaParts = [
    formatDateTime(record.importedAt, 'datetime'),
    pluginLabel(ctx, record.pluginId),
    t('import.historyCount', { count: formatNumber(record.count) }),
  ];
  text.append(textEl('span', metaParts.join(' · '), 'import-history-meta muted'));

  const undoBtn = document.createElement('button');
  undoBtn.type = 'button';
  undoBtn.className = 'import-history-undo';
  undoBtn.textContent = t('import.undo');
  undoBtn.addEventListener('click', () =>
    renderHistoryRowConfirm(ctx, section, row, record),
  );

  row.append(text, undoBtn);
}

function renderHistoryRowConfirm(
  ctx: AppContext,
  section: HTMLElement,
  row: HTMLElement,
  record: ImportRecord,
): void {
  const { t } = ctx;
  row.replaceChildren();
  row.classList.add('is-confirming');
  row.append(textEl('p', t('import.undoConfirm', { count: formatNumber(record.count) }), 'muted'));

  // If this import created custom metrics that undoing it would leave unused,
  // offer to remove them too — off by default (deleting metrics is more
  // destructive than removing values).
  const unusedCount = unusedMetricsCreatedByImport(ctx.data(), record.id).length;
  let alsoMetrics: HTMLInputElement | undefined;
  if (unusedCount > 0) {
    const metricsRow = el('label', 'import-history-also-metrics');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'check';
    metricsRow.append(
      cb,
      textEl(
        'span',
        plural(
          unusedCount,
          {
            one: 'import.undoAlsoMetricsOne',
            few: 'import.undoAlsoMetricsFew',
            many: 'import.undoAlsoMetricsMany',
          },
          { count: formatNumber(unusedCount) },
        ),
      ),
    );
    row.append(metricsRow);
    alsoMetrics = cb;
  }

  const choice = el('div', 'settings-choice');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = t('common.cancel');
  cancel.addEventListener('click', () => renderHistoryRowIdle(ctx, section, row, record));

  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'danger';
  confirm.textContent = t('import.undo');
  confirm.addEventListener('click', () => {
    const removeMetrics = alsoMetrics?.checked ?? false;
    let result = { measurements: 0, metrics: 0 };
    ctx.mutate((data) => {
      result = removeImportAndMetrics(data, record.id, removeMetrics);
    });
    ctx.toast(
      result.metrics > 0
        ? t('import.undoneWithMetrics', {
            values: formatNumber(result.measurements),
            metrics: formatNumber(result.metrics),
          })
        : t('import.undone', { count: formatNumber(result.measurements) }),
      'success',
    );
    renderHistory(ctx, section);
  });

  choice.append(cancel, confirm);
  row.append(choice);
}

export const importView: View = {
  render(container: HTMLElement, ctx: AppContext): () => void {
    const { t } = ctx;

    // One hidden file input, retargeted per card/dropzone action. Never shown.
    const hidden = document.createElement('input');
    hidden.type = 'file';
    hidden.className = 'visually-hidden';

    function pickFile(accept: string, run: (file: File) => void): void {
      hidden.accept = accept;
      hidden.value = '';
      hidden.onchange = (): void => {
        const file = hidden.files?.[0];
        hidden.onchange = null;
        hidden.value = '';
        if (file) run(file);
      };
      hidden.click();
    }

    /** Map a card's action to the matching import runner (or a navigation). */
    function runCard(card: FormatCard): void {
      const a = card.action;
      switch (a.kind) {
        case 'navigate':
          ctx.navigate(a.route);
          return;
        case 'plugin':
          pickFile(card.accept ?? '', (f) => void runPluginImport(ctx, a.pluginId, f));
          return;
        case 'pdf':
          pickFile(card.accept ?? '', (f) => void runPdfImport(ctx, f));
          return;
        case 'pack':
          pickFile(card.accept ?? '', (f) => void runPackImport(ctx, f));
          return;
        case 'json':
          pickFile(card.accept ?? '', (f) => void runImport(ctx, f));
          return;
        case 'csv':
          pickFile(card.accept ?? '', (f) => void runCsvImport(ctx, f));
          return;
      }
    }

    const root = el('div', 'import-view');
    root.append(textEl('h1', t('import.title')));
    root.append(textEl('p', t('import.subtitle'), 'import-subtitle muted'));

    // Import ⇄ Export switcher — the data-out counterpart lives on its own route.
    root.append(dataSwitch(ctx, 'import'));

    // A batch still waiting for review (the user navigated away mid-import): a
    // prominent entry point back to it, so an unfinished import is never stranded.
    const pending = pendingImportCount();
    if (pending > 0) {
      const resume = document.createElement('button');
      resume.type = 'button';
      resume.className = 'import-pending-banner';
      resume.textContent = t('review.pendingBanner', { count: pending });
      resume.addEventListener('click', () => ctx.navigate('review'));
      root.append(resume);
    }

    // Segmented control: Automatic (dropzone only) / Specific format (grid).
    const seg = el('div', 'import-segment');
    const autoBtn = document.createElement('button');
    autoBtn.type = 'button';
    autoBtn.className = 'import-segment-btn is-active';
    autoBtn.textContent = t('import.modeAuto');
    autoBtn.setAttribute('aria-current', 'true');
    const specificBtn = document.createElement('button');
    specificBtn.type = 'button';
    specificBtn.className = 'import-segment-btn';
    specificBtn.textContent = t('import.modeSpecific');
    seg.append(autoBtn, specificBtn);
    root.append(seg);

    // Dropzone (auto mode): click or drop → auto-detect → review.
    const dropzone = el('div', 'import-dropzone');
    dropzone.setAttribute('role', 'button');
    dropzone.setAttribute('tabindex', '0');
    dropzone.setAttribute('aria-label', t('import.dropzoneTitle'));

    const tile = el('div', 'import-dropzone-tile');
    tile.append(uploadIcon('import-dropzone-icon'));
    dropzone.append(tile);
    dropzone.append(textEl('p', t('import.dropzoneTitle'), 'import-dropzone-title'));
    dropzone.append(textEl('p', t('import.dropzoneHint'), 'import-dropzone-hint muted'));

    // A visual pill only — NOT a real <button>. The whole dropzone is the button
    // (role="button" + tabindex), so a nested interactive control would be an
    // a11y violation; a click on this span bubbles to the dropzone handler.
    const pickBtn = el('span', 'import-pick-btn');
    pickBtn.textContent = t('import.chooseFile');
    pickBtn.setAttribute('aria-hidden', 'true');
    dropzone.append(pickBtn);

    const openAuto = (): void => pickFile(ACCEPT_AUTO, (f) => void runAutoImport(ctx, f));
    dropzone.addEventListener('click', openAuto);
    dropzone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openAuto();
      }
    });
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('is-dragover');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-dragover'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('is-dragover');
      const file = e.dataTransfer?.files?.[0];
      if (file) void runAutoImport(ctx, file);
    });
    root.append(dropzone);

    // Format grid (specific mode): a card per format, hidden until selected.
    const grid = el('div', 'import-format-grid');
    grid.hidden = true;
    for (const card of FORMAT_CARDS) {
      const cardEl = document.createElement('button');
      cardEl.type = 'button';
      cardEl.className = 'format-card';
      const iconTile = el('div', 'format-card-tile');
      iconTile.append(textEl('span', card.tag, 'format-card-tag'));
      cardEl.append(iconTile);
      const body = el('div', 'format-card-body');
      body.append(textEl('span', t(card.nameKey), 'format-card-name'));
      body.append(textEl('span', t(card.descKey), 'format-card-desc muted'));
      cardEl.append(body);
      cardEl.addEventListener('click', () => runCard(card));
      grid.append(cardEl);
    }
    root.append(grid);

    function setMode(mode: 'auto' | 'specific'): void {
      const auto = mode === 'auto';
      autoBtn.classList.toggle('is-active', auto);
      specificBtn.classList.toggle('is-active', !auto);
      if (auto) {
        autoBtn.setAttribute('aria-current', 'true');
        specificBtn.removeAttribute('aria-current');
      } else {
        specificBtn.setAttribute('aria-current', 'true');
        autoBtn.removeAttribute('aria-current');
      }
      dropzone.hidden = !auto;
      grid.hidden = auto;
    }
    autoBtn.addEventListener('click', () => setMode('auto'));
    specificBtn.addEventListener('click', () => setMode('specific'));

    // "Known metrics only" switch — shared transient state with settings.
    const knownRow = el('div', 'import-known-row card');
    const knownText = el('div', 'import-known-text');
    knownText.append(textEl('span', t('import.knownOnly'), 'import-known-label'));
    knownText.append(textEl('span', t('import.knownOnlyHint'), 'import-known-hint muted'));
    const knownSwitch = switchControl({
      checked: getImportKnownOnly(ctx),
      label: t('import.knownOnly'),
      onChange: (on) => setImportKnownOnly(ctx, on),
    });
    knownRow.append(knownText, knownSwitch.el);
    root.append(knownRow);

    // "Offer metrics from hidden packs" switch — when on (default), import
    // recognises metrics from inactive packs and review offers to reveal them.
    const offerRow = el('div', 'import-offer-row card');
    const offerText = el('div', 'import-known-text');
    offerText.append(textEl('span', t('import.offerHidden'), 'import-known-label'));
    offerText.append(textEl('span', t('import.offerHiddenHint'), 'import-known-hint muted'));
    const offerSwitch = switchControl({
      checked: getOfferHiddenMetrics(ctx),
      label: t('import.offerHidden'),
      onChange: (on) => setOfferHiddenMetrics(ctx, on),
    });
    offerRow.append(offerText, offerSwitch.el);
    root.append(offerRow);

    // Recent imports history: what was imported, with an inline-confirm Undo.
    const history = el('section', 'import-history');
    renderHistory(ctx, history);
    root.append(history);

    // Footer: on-device processing + review-before-save reassurance.
    root.append(textEl('p', t('import.footer'), 'import-footer muted'));

    root.append(hidden);

    container.replaceChildren();
    container.append(root);

    return () => {
      container.replaceChildren();
    };
  },
};
