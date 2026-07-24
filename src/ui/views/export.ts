/**
 * Export wizard (phase 3) — a first-class route for getting a selectable subset
 * of the data OUT for interoperability (doctor, spreadsheet, another app). This
 * is deliberately distinct from Backup (the full, versioned, optionally-encrypted
 * JSON in Settings): Export is a choice of metrics + period + an interop format,
 * always plain.
 *
 * Three sections mirroring the wizard steps: a searchable metric checklist
 * (select all / none), a segmented period control, and a grid of format tiles
 * (CSV / FHIR / printable HTML report — never the JSON backup). Picking a format
 * and pressing Export runs the matching export plugin and downloads its Blob via
 * a hidden `<a download>`. All pure logic lives in `export-model.ts`; this file
 * is view wiring only. All user text goes through `ctx.t`.
 *
 * A dedicated visual redesign comes later — this uses the existing design tokens
 * (segmented controls, cards, format tiles) for a coherent, functional screen.
 */

import type { AppContext, RouteState, View } from '../app-context';
import type { ExportContext, ExportSelection } from '../../core/contracts';
import type { MetricId } from '../../core/types';
import type { StringKey } from '../../i18n/index';
import { formatDateTime } from '../../i18n/index';
import { exportPluginById } from '../../plugins/registry';
import { snapshotMeasurements } from '../../core/snapshot';
import { tagLabel, usedTags } from '../../core/tags';
import { dataSwitch } from '../components/data-switch';
import { tagChip } from '../components/tag-chip';
import {
  EXPORT_FORMATS,
  applyExtension,
  buildExportBaseName,
  buildExportSelection,
  buildMetricItems,
  buildSnapshotBaseName,
  canExport,
  formatById,
  isoDay,
  metricMatchesQuery,
  periodOptions,
  sanitizeFilename,
  type ExportFormatId,
  type ExportMetricItem,
  type ExportMode,
  type ExportPeriod,
} from './export-model';
import './export.css';

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

/** Resolve a checklist item's display name for the current locale. */
function itemName(ctx: AppContext, item: ExportMetricItem): string {
  if (item.customName) return item.customName;
  if (item.nameKey) return ctx.t(item.nameKey as StringKey);
  return String(item.metricId);
}

export const exportView: View = {
  render(container: HTMLElement, ctx: AppContext, route: RouteState): () => void {
    const { t } = ctx;

    const items = buildMetricItems(ctx.data().measurements, ctx.catalog());
    const selected = new Set<MetricId>(items.map((i) => i.metricId));
    const useTags = ctx.data().settings.useTags !== false;
    let period: ExportPeriod = 'all';
    // A route param carrying an ISO date pre-selects As-of-date (snapshot) mode at
    // that date — the Overview "export this state" hand-off. Otherwise range mode.
    const paramDay =
      route?.param && /^\d{4}-\d{2}-\d{2}/.test(route.param) ? route.param.slice(0, 10) : undefined;
    let mode: ExportMode = paramDay ? 'snapshot' : 'range';
    let asOfIso = paramDay ?? (isoDay(ctx.now()) || ctx.now());
    let format: ExportFormatId | undefined;
    let tag: string | undefined;
    let nameEdited = false;

    const root = el('div', 'export-view');
    root.append(textEl('h1', t('export.title')));
    root.append(textEl('p', t('export.subtitle'), 'export-subtitle muted'));

    // Import ⇄ Export switcher — same pill as the Import page, mirrored here.
    root.append(dataSwitch(ctx, 'export'));

    // Hidden download anchor, reused for every export.
    const hiddenLink = document.createElement('a');
    hiddenLink.className = 'visually-hidden';

    // --- Section 1: metric selection ------------------------------------
    const metricSection = el('section', 'export-section');
    metricSection.append(sectionTitle(t('export.step.metrics')));

    if (items.length === 0) {
      metricSection.append(textEl('p', t('export.noMetrics'), 'muted export-empty'));
    }

    // Search + select all/none row.
    const controls = el('div', 'export-metric-controls');
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'export-search';
    search.placeholder = t('export.searchMetrics');
    search.setAttribute('aria-label', t('export.searchMetrics'));
    const allBtn = ghostButton(t('export.selectAll'));
    const noneBtn = ghostButton(t('export.selectNone'));
    controls.append(search, allBtn, noneBtn);
    if (items.length > 0) metricSection.append(controls);

    // Tag filter chip row (union of tags among exportable metrics).
    const tagFilter = el('div', 'export-tag-filter');
    function paintTagFilter(): void {
      if (!useTags) return;
      tagFilter.replaceChildren();
      const tags = usedTags(items);
      if (tags.length === 0) return;
      const makeChip = (label: string, value: string | undefined): HTMLButtonElement =>
        tagChip({
          label,
          isActive: tag === value,
          onToggle: () => {
            tag = tag === value ? undefined : value;
            paintTagFilter();
            applyFilter();
          },
        });
      tagFilter.append(makeChip(t('tags.all'), undefined));
      for (const tg of tags) tagFilter.append(makeChip(tagLabel(tg, t), tg));
    }
    if (items.length > 0) metricSection.append(tagFilter);

    const list = el('div', 'export-metric-list');
    const rows: {
      item: ExportMetricItem;
      row: HTMLElement;
      checkbox: HTMLInputElement;
      note: HTMLElement;
    }[] = [];
    for (const item of items) {
      const row = el('label', 'export-metric-row');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = true;
      // Native input (a11y + label-click) with the shared `.check` look. The
      // `.export-metric-check` hook stays for the e2e selector.
      checkbox.className = 'check export-metric-check';
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(item.metricId);
        else selected.delete(item.metricId);
        refreshExportEnabled();
      });
      const text = el('span', 'export-metric-text');
      text.append(textEl('span', itemName(ctx, item), 'export-metric-name'));
      text.append(
        textEl('span', t('export.recordCount', { count: item.count }), 'export-metric-count muted'),
      );
      // Snapshot-only note: this metric has no value at the chosen date (hidden
      // in range mode / when a value exists). The checkbox stays active — the
      // date can change.
      const note = textEl('span', t('export.noValueAtDate'), 'export-metric-note muted');
      note.hidden = true;
      text.append(note);
      row.append(checkbox, text);
      list.append(row);
      rows.push({ item, row, checkbox, note });
    }
    metricSection.append(list);
    root.append(metricSection);

    function applyFilter(): void {
      const q = search.value;
      for (const { item, row } of rows) {
        const matchesTag = tag === undefined || item.tags.includes(tag);
        row.hidden = !matchesTag || !metricMatchesQuery(itemName(ctx, item), q);
      }
    }
    search.addEventListener('input', applyFilter);
    paintTagFilter();

    allBtn.addEventListener('click', () => {
      for (const { item, row, checkbox } of rows) {
        if (row.hidden) continue; // act on the visible (filtered) set only
        checkbox.checked = true;
        selected.add(item.metricId);
      }
      refreshExportEnabled();
    });
    noneBtn.addEventListener('click', () => {
      for (const { item, row, checkbox } of rows) {
        if (row.hidden) continue;
        checkbox.checked = false;
        selected.delete(item.metricId);
      }
      refreshExportEnabled();
    });

    // --- Section 2: range (period or snapshot) --------------------------
    const rangeSection = el('section', 'export-section');
    rangeSection.append(sectionTitle(t('export.step.range')));

    // Mode segment: Period (default) | As of date.
    const modeSeg = el('div', 'export-segment export-mode-segment');
    const modeBtns: { id: ExportMode; btn: HTMLButtonElement }[] = [];
    for (const m of [
      { id: 'range' as ExportMode, labelKey: 'export.mode.range' as StringKey },
      { id: 'snapshot' as ExportMode, labelKey: 'export.mode.snapshot' as StringKey },
    ]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'export-segment-btn';
      btn.textContent = t(m.labelKey);
      if (m.id === mode) {
        btn.classList.add('is-active');
        btn.setAttribute('aria-current', 'true');
      }
      btn.addEventListener('click', () => {
        mode = m.id;
        for (const b of modeBtns) {
          const active = b.id === mode;
          b.btn.classList.toggle('is-active', active);
          if (active) b.btn.setAttribute('aria-current', 'true');
          else b.btn.removeAttribute('aria-current');
        }
        periodBox.hidden = mode !== 'range';
        snapshotBox.hidden = mode !== 'snapshot';
        refreshSnapshot();
        refreshExportEnabled();
      });
      modeSeg.append(btn);
      modeBtns.push({ id: m.id, btn });
    }
    rangeSection.append(modeSeg);

    // Period presets (range mode).
    const periodBox = el('div', 'export-period-box');
    const seg = el('div', 'export-segment');
    const periodBtns: { id: ExportPeriod; btn: HTMLButtonElement }[] = [];
    for (const opt of periodOptions()) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'export-segment-btn';
      btn.textContent = t(opt.labelKey);
      if (opt.id === period) {
        btn.classList.add('is-active');
        btn.setAttribute('aria-current', 'true');
      }
      btn.addEventListener('click', () => {
        period = opt.id;
        for (const p of periodBtns) {
          const active = p.id === period;
          p.btn.classList.toggle('is-active', active);
          if (active) p.btn.setAttribute('aria-current', 'true');
          else p.btn.removeAttribute('aria-current');
        }
      });
      seg.append(btn);
      periodBtns.push({ id: opt.id, btn });
    }
    periodBox.append(seg);
    rangeSection.append(periodBox);

    // As-of controls (snapshot mode): a "today" pill + a date input + a hint.
    const snapshotBox = el('div', 'export-snapshot-box');
    periodBox.hidden = mode !== 'range';
    snapshotBox.hidden = mode !== 'snapshot';
    const asOfRow = el('div', 'export-asof-row');
    const todayBtn = document.createElement('button');
    todayBtn.type = 'button';
    todayBtn.className = 'export-asof-today';
    todayBtn.textContent = t('export.asOfToday');
    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.className = 'export-asof-date';
    dateInput.value = asOfIso;
    dateInput.setAttribute('aria-label', t('export.asOfDateLabel'));
    todayBtn.addEventListener('click', () => {
      asOfIso = isoDay(ctx.now()) || ctx.now();
      dateInput.value = asOfIso;
      refreshSnapshot();
    });
    dateInput.addEventListener('change', () => {
      if (dateInput.value) asOfIso = dateInput.value;
      refreshSnapshot();
    });
    asOfRow.append(todayBtn, dateInput);
    snapshotBox.append(asOfRow);
    snapshotBox.append(textEl('p', t('export.asOfHint'), 'export-asof-hint muted'));
    rangeSection.append(snapshotBox);
    root.append(rangeSection);

    // --- Section 3: format tiles ----------------------------------------
    const formatSection = el('section', 'export-section');
    formatSection.append(sectionTitle(t('export.step.format')));
    const grid = el('div', 'export-format-grid');
    const formatTiles: { id: ExportFormatId; tile: HTMLButtonElement }[] = [];
    for (const fmt of EXPORT_FORMATS) {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'format-card export-format-card';
      const iconTile = el('div', 'format-card-tile');
      iconTile.append(textEl('span', fmt.tag, 'format-card-tag'));
      tile.append(iconTile);
      const body = el('div', 'format-card-body');
      body.append(textEl('span', t(fmt.nameKey), 'format-card-name'));
      body.append(textEl('span', t(fmt.descKey), 'format-card-desc muted'));
      tile.append(body);
      tile.addEventListener('click', () => {
        format = fmt.id;
        for (const f of formatTiles) {
          const active = f.id === format;
          f.tile.classList.toggle('is-selected', active);
          f.tile.setAttribute('aria-pressed', String(active));
        }
        refreshExportEnabled();
      });
      tile.setAttribute('aria-pressed', 'false');
      grid.append(tile);
      formatTiles.push({ id: fmt.id, tile });
    }
    formatSection.append(grid);
    root.append(formatSection);

    // --- Section 4: filename --------------------------------------------
    // Editable download name (pre-filled with a dated default); the chosen
    // format's extension is appended at export time.
    const nameSection = el('section', 'export-section');
    nameSection.append(sectionTitle(t('export.step.filename')));
    const nameField = el('label', 'export-filename-field');
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'export-filename';
    nameInput.value = defaultBaseName();
    nameInput.setAttribute('aria-label', t('export.filenameLabel'));
    nameInput.placeholder = t('export.filenamePlaceholder');
    // Typing marks the name as user-owned so mode/date changes stop overwriting it.
    nameInput.addEventListener('input', () => {
      nameEdited = true;
    });
    nameField.append(nameInput);
    nameSection.append(nameField);
    root.append(nameSection);

    // --- Footer: Export action + hint -----------------------------------
    const footer = el('div', 'export-footer');
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'primary export-run';
    exportBtn.textContent = t('export.run');
    const hint = textEl('p', '', 'export-hint muted');
    footer.append(exportBtn, hint);
    root.append(footer);

    // The metric ids that HAVE a value at the chosen date (snapshot resolver).
    function snapshotPresentSet(): Set<MetricId> {
      const snap = snapshotMeasurements(ctx.data().measurements, undefined, asOfIso);
      return new Set(snap.map((m) => m.metricId));
    }

    function defaultBaseName(): string {
      return mode === 'snapshot'
        ? buildSnapshotBaseName(asOfIso)
        : buildExportBaseName(ctx.now());
    }

    // React to a mode/date change: per-row "no value at date" notes, the today
    // pill state, and the (unedited) default filename.
    function refreshSnapshot(): void {
      const snapshot = mode === 'snapshot';
      const present = snapshot ? snapshotPresentSet() : undefined;
      for (const { item, note } of rows) {
        note.hidden = !snapshot || (present?.has(item.metricId) ?? true);
      }
      todayBtn.classList.toggle('is-active', (isoDay(ctx.now()) || ctx.now()) === asOfIso);
      if (!nameEdited) nameInput.value = defaultBaseName();
      refreshExportEnabled();
    }

    function refreshExportEnabled(): void {
      const hasMetrics = canExport([...selected]);
      const hasFormat = format !== undefined;
      // Snapshot counter: metrics that actually have a value at the date.
      if (mode === 'snapshot') {
        const present = snapshotPresentSet();
        const count = [...selected].filter((id) => present.has(id)).length;
        exportBtn.textContent = t('export.runSnapshotCount', {
          count,
          date: formatDateTime(asOfIso, 'date'),
        });
      } else {
        exportBtn.textContent = t('export.run');
      }
      exportBtn.disabled = !hasMetrics || !hasFormat;
      if (!hasMetrics) hint.textContent = t('export.hintNoMetrics');
      else if (!hasFormat) hint.textContent = t('export.hintNoFormat');
      else hint.textContent = '';
    }
    refreshSnapshot();

    exportBtn.addEventListener('click', () => {
      if (format === undefined || !canExport([...selected])) return;
      const tile = formatById(format);
      if (!tile) return;
      const base = sanitizeFilename(nameInput.value, defaultBaseName());
      nameInput.value = base; // reflect the sanitized value back to the user
      const filename = applyExtension(base, tile.extension);
      void runExport(
        ctx,
        tile.pluginId,
        [...selected],
        { period, mode, asOfIso },
        filename,
        hiddenLink,
      );
    });

    root.append(hiddenLink);
    container.replaceChildren();
    container.append(root);

    return () => {
      container.replaceChildren();
    };
  },
};

function sectionTitle(text: string): HTMLElement {
  return textEl('h2', text, 'export-section-title');
}

function ghostButton(label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'export-ghost';
  b.textContent = label;
  return b;
}

/** Run the chosen export plugin over the selection and download its Blob. */
async function runExport(
  ctx: AppContext,
  pluginId: string,
  metricIds: MetricId[],
  opts: { period: ExportPeriod; mode: ExportMode; asOfIso: string },
  filename: string,
  link: HTMLAnchorElement,
): Promise<void> {
  const plugin = exportPluginById(pluginId);
  if (!plugin) return;
  const nowIso = ctx.now();
  const selection: ExportSelection = buildExportSelection(metricIds, opts.period, nowIso, {
    mode: opts.mode,
    asOfIso: opts.asOfIso,
  });
  const exportCtx: ExportContext = {
    data: ctx.data(),
    catalog: ctx.catalog(),
    units: ctx.units,
    locale: ctx.locale,
    nowIso,
  };
  const blob = await plugin.export(selection, exportCtx);
  const url = URL.createObjectURL(blob);
  try {
    link.href = url;
    link.download = filename;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
  ctx.toast(ctx.t('export.done'), 'success');
}
