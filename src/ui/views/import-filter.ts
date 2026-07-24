/**
 * Pre-import filter ("What to import") — the generic step between parse and
 * review for a large import. A full page (same layout as review, not a dialog —
 * too many controls for a mobile dialog): a PERIOD section (segmented presets +
 * a custom Od/Do date pair) and a METRICS section (a searchable, tag-filterable
 * checklist of the distinct metrics the file holds, with live per-period counts).
 *
 * It is generic across every import format: it reads the pipeline's full pending
 * batch via {@link getPendingImport}, narrows it with the pure
 * {@link import-filter-model}, and on Continue writes the narrowed subset back
 * with {@link setPendingImport} before navigating to review. Cancel clears the
 * batch and returns to the Import page — nothing is stored (like cancelling
 * review). All decision arithmetic lives in the DOM-free model; this file is glue
 * to the DOM. Every user string goes through `ctx.t` / `formatDateTime`.
 */

import type { AppContext, View } from '../app-context';
import { formatDateTime, formatNumber } from '../../i18n/index';
import type { StringKey } from '../../i18n/index';
import type { ReviewItem } from '../../core/contracts';
import type { Metric } from '../../core/types';
import { tagLabel, usedTags } from '../../core/tags';
import { tagChip } from '../components/tag-chip';
import { getPendingImport, setPendingImport } from './review';
import { metricMatchesQuery } from './export-model';
import {
  aggregateByMetric,
  applyImportFilter,
  countsInPeriod,
  defaultRange,
  fileSummary,
  initialSelection,
  itemMetricId,
  presetRange,
  type FilterPreset,
  type FilterRange,
  type MetricGroup,
} from './import-filter-model';
import { getImportKnownOnly } from './import-actions';
import './import-filter.css';

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

/** Metric display name: i18n key for built-ins, custom name for user metrics. */
function metricName(ctx: AppContext, metric: Metric): string {
  if (metric.customName) return metric.customName;
  if (metric.nameKey) return ctx.t(metric.nameKey as StringKey);
  return metric.key ?? '';
}

/** Display name for a review item's metric: catalog name, or the raw unresolved name. */
function groupName(ctx: AppContext, item: ReviewItem): string {
  const id = itemMetricId(item);
  if (id) {
    const metric = ctx.catalog().byId(id);
    if (metric) return metricName(ctx, metric);
  }
  const m = item.proposed.metric;
  return typeof m === 'string' ? id ?? '' : m.unresolvedName;
}

/** The calendar-year label of an ISO date, or ''. */
function yearOf(iso?: string): string {
  return iso && /^\d{4}/.test(iso) ? iso.slice(0, 4) : '';
}

/** Localized date (day precision) of an ISO instant, or ''. */
function fmtDay(iso?: string): string {
  return iso ? formatDateTime(iso, 'date') : '';
}

const PRESETS: { id: FilterPreset; labelKey: StringKey }[] = [
  { id: 'all', labelKey: 'importFilter.periodAll' },
  { id: 'year', labelKey: 'importFilter.periodYear' },
  { id: 'month', labelKey: 'importFilter.periodMonth' },
  { id: 'custom', labelKey: 'importFilter.periodCustom' },
];

export const importFilterView: View = {
  render(container: HTMLElement, ctx: AppContext): void {
    const { t } = ctx;
    container.replaceChildren();

    const { items, meta } = getPendingImport();

    const root = el('div', 'import-filter-view');
    const title = textEl('h1', t('importFilter.title'));
    root.append(title);

    // An empty/absent batch (e.g. a direct navigation): nothing to filter.
    if (items.length === 0) {
      root.append(textEl('p', t('review.nothing'), 'card muted import-filter-empty'));
      container.append(root);
      return;
    }

    if (meta.fileName) root.append(textEl('p', meta.fileName, 'muted import-filter-file'));

    const useTags = ctx.data().settings.useTags !== false;
    const knownOnly = getImportKnownOnly(ctx);

    const groups = aggregateByMetric(items, (item) => groupName(ctx, item));
    const summary = fileSummary(items);

    // --- In-closure state -----------------------------------------------------
    const def = defaultRange(items, ctx.now());
    let preset: FilterPreset = def.presetId;
    let customFrom = summary.minIso ? summary.minIso.slice(0, 10) : '';
    let customTo = summary.maxIso ? summary.maxIso.slice(0, 10) : '';
    const selected = initialSelection(groups, { knownOnly });
    let tag: string | undefined;

    /** The active range from the current preset (custom → the Od/Do inputs). */
    function currentRange(): FilterRange | undefined {
      if (preset === 'custom') {
        const range: FilterRange = {};
        if (customFrom) range.fromIso = customFrom;
        if (customTo) range.toIso = customTo;
        return range.fromIso || range.toIso ? range : undefined;
      }
      return presetRange(preset, ctx.now());
    }

    // ======================= Period section =================================
    const periodSection = el('section', 'import-filter-section');
    periodSection.append(sectionTitle(t('importFilter.periodTitle')));

    const seg = el('div', 'import-filter-segment');
    const segBtns: { id: FilterPreset; btn: HTMLButtonElement }[] = [];
    for (const p of PRESETS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'import-filter-segment-btn';
      btn.textContent = t(p.labelKey);
      if (p.id === preset) {
        btn.classList.add('is-active');
        btn.setAttribute('aria-current', 'true');
      }
      btn.addEventListener('click', () => {
        preset = p.id;
        for (const s of segBtns) {
          const active = s.id === preset;
          s.btn.classList.toggle('is-active', active);
          if (active) s.btn.setAttribute('aria-current', 'true');
          else s.btn.removeAttribute('aria-current');
        }
        customBox.hidden = preset !== 'custom';
        refreshCounts();
        refreshCta();
      });
      seg.append(btn);
      segBtns.push({ id: p.id, btn });
    }
    periodSection.append(seg);

    // Custom Od / Do date pair (revealed for the "custom" preset).
    const customBox = el('div', 'import-filter-custom');
    customBox.hidden = preset !== 'custom';
    const fromInput = dateInput(t('importFilter.from'), customFrom);
    const toInput = dateInput(t('importFilter.to'), customTo);
    fromInput.addEventListener('change', () => {
      customFrom = fromInput.value;
      refreshCounts();
      refreshCta();
    });
    toInput.addEventListener('change', () => {
      customTo = toInput.value;
      refreshCounts();
      refreshCta();
    });
    customBox.append(labelled(t('importFilter.from'), fromInput), labelled(t('importFilter.to'), toInput));
    periodSection.append(customBox);

    // File summary + (for a large history) the preselect note.
    const summaryLine = textEl(
      'p',
      summary.minIso && summary.maxIso
        ? t('importFilter.fileSummary', {
            count: formatNumber(summary.count),
            from: fmtDay(summary.minIso),
            to: fmtDay(summary.maxIso),
          })
        : t('importFilter.fileSummaryNoDates', { count: formatNumber(summary.count) }),
      'muted import-filter-summary',
    );
    periodSection.append(summaryLine);
    if (def.presetId === 'year') {
      periodSection.append(textEl('p', t('importFilter.presetYearNote'), 'muted import-filter-note'));
    }
    root.append(periodSection);

    // ======================= Metrics section ================================
    const metricsSection = el('section', 'import-filter-section');
    metricsSection.append(sectionTitle(t('importFilter.metricsTitle')));

    // Search + All / None (act on the visible/filtered set, like Export).
    const controls = el('div', 'import-filter-metric-controls');
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'import-filter-search';
    search.placeholder = t('importFilter.searchMetrics');
    search.setAttribute('aria-label', t('importFilter.searchMetrics'));
    const allBtn = ghostButton(t('importFilter.selectAll'));
    const noneBtn = ghostButton(t('importFilter.selectNone'));
    controls.append(search, allBtn, noneBtn);
    metricsSection.append(controls);

    // Tag filter chips (union of tags among resolved metrics), when tags are on.
    const tagFilter = el('div', 'import-filter-tags');
    function paintTagFilter(): void {
      if (!useTags) return;
      tagFilter.replaceChildren();
      const metrics = groups
        .map((g) => (g.metricId ? ctx.catalog().byId(g.metricId) : undefined))
        .filter((m): m is Metric => m !== undefined);
      const tags = usedTags(metrics);
      if (tags.length === 0) return;
      const makeChip = (label: string, value: string | undefined): HTMLButtonElement =>
        tagChip({
          label,
          isActive: tag === value,
          onToggle: () => {
            tag = tag === value ? undefined : value;
            paintTagFilter();
            applyRowFilter();
          },
        });
      tagFilter.append(makeChip(t('tags.all'), undefined));
      for (const tg of tags) tagFilter.append(makeChip(tagLabel(tg, t), tg));
    }
    metricsSection.append(tagFilter);

    // The checklist: one row per metric group.
    const list = el('div', 'import-filter-list');
    interface Row {
      group: MetricGroup;
      row: HTMLElement;
      checkbox: HTMLInputElement;
      meta: HTMLElement;
      tags: string[];
    }
    const rows: Row[] = [];
    for (const group of groups) {
      const row = el('label', 'import-filter-row');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'check import-filter-check';
      checkbox.checked = selected.has(group.key);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(group.key);
        else selected.delete(group.key);
        refreshCta();
      });
      const text = el('span', 'import-filter-text');
      const nameRow = el('span', 'import-filter-name-row');
      nameRow.append(textEl('span', group.name, 'import-filter-name'));
      if (group.unresolved) {
        nameRow.append(textEl('span', t('review.unresolved'), 'pill import-filter-unresolved'));
      }
      const metaEl = textEl('span', '', 'import-filter-meta muted');
      text.append(nameRow, metaEl);
      row.append(checkbox, text);
      list.append(row);
      const metricTags = group.metricId ? ctx.catalog().byId(group.metricId)?.tags ?? [] : [];
      rows.push({ group, row, checkbox, meta: metaEl, tags: metricTags });
    }
    metricsSection.append(list);
    root.append(metricsSection);

    // ======================= Footer =========================================
    const footer = el('div', 'import-filter-footer');
    const cancelBtn = ghostButton(t('importFilter.cancel'));
    cancelBtn.classList.add('import-filter-cancel');
    cancelBtn.addEventListener('click', () => {
      setPendingImport([]);
      ctx.navigate('import');
    });
    const continueBtn = document.createElement('button');
    continueBtn.type = 'button';
    continueBtn.className = 'primary import-filter-continue';
    continueBtn.addEventListener('click', () => {
      const narrowed = applyImportFilter(items, { range: currentRange(), selectedKeys: selected });
      setPendingImport(narrowed, meta);
      ctx.navigate('review');
    });
    footer.append(cancelBtn, continueBtn);
    root.append(footer);

    // --- Live refresh ---------------------------------------------------------
    function applyRowFilter(): void {
      const q = search.value;
      for (const r of rows) {
        const matchesTag = tag === undefined || r.tags.includes(tag);
        r.row.hidden = !matchesTag || !metricMatchesQuery(r.group.name, q);
      }
    }

    function metricMetaText(group: MetricGroup, inPeriod: number): string {
      if (inPeriod === 0) return t('importFilter.noneInPeriod');
      const y1 = yearOf(group.minIso);
      const y2 = yearOf(group.maxIso);
      const count = formatNumber(inPeriod);
      if (!y1 && !y2) return t('importFilter.metricMetaNoDates', { count });
      if (y1 === y2) return t('importFilter.metricMetaSingleYear', { count, year: y1 });
      return t('importFilter.metricMeta', { count, from: y1, to: y2 });
    }

    function refreshCounts(): void {
      const counts = countsInPeriod(items, currentRange());
      for (const r of rows) {
        const inPeriod = counts.get(r.group.key) ?? 0;
        r.meta.textContent = metricMetaText(r.group, inPeriod);
        // A group with nothing in the current period cannot contribute — disable it.
        r.checkbox.disabled = inPeriod === 0;
        r.row.classList.toggle('import-filter-row--empty', inPeriod === 0);
      }
    }

    function refreshCta(): void {
      const kept = applyImportFilter(items, { range: currentRange(), selectedKeys: selected }).length;
      continueBtn.textContent = t('importFilter.continue', { count: formatNumber(kept) });
      continueBtn.disabled = kept === 0;
    }

    search.addEventListener('input', applyRowFilter);
    allBtn.addEventListener('click', () => {
      for (const r of rows) {
        if (r.row.hidden || r.checkbox.disabled) continue;
        r.checkbox.checked = true;
        selected.add(r.group.key);
      }
      refreshCta();
    });
    noneBtn.addEventListener('click', () => {
      for (const r of rows) {
        if (r.row.hidden) continue;
        r.checkbox.checked = false;
        selected.delete(r.group.key);
      }
      refreshCta();
    });

    paintTagFilter();
    applyRowFilter();
    refreshCounts();
    refreshCta();

    container.append(root);
  },
};

// ---------------------------------------------------------------------------
// Small builders
// ---------------------------------------------------------------------------

function sectionTitle(text: string): HTMLElement {
  return textEl('h2', text, 'import-filter-section-title');
}

function ghostButton(label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'import-filter-ghost';
  b.textContent = label;
  return b;
}

function dateInput(ariaLabel: string, value: string): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'date';
  input.className = 'import-filter-date';
  input.value = value;
  input.setAttribute('aria-label', ariaLabel);
  return input;
}

/** A labelled date field (small caption above the pill input). */
function labelled(caption: string, input: HTMLInputElement): HTMLElement {
  const wrap = el('label', 'import-filter-date-field');
  wrap.append(textEl('span', caption, 'import-filter-date-label muted'), input);
  return wrap;
}
