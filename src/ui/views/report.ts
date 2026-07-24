/**
 * Health summary report — display-first.
 *
 * An on-screen summary of everything tracked: an "attention" section
 * (out-of-range / long-unmeasured / mixed-unit series), then a table per
 * category with latest value, reference position, change, long-term trend and
 * how recently it was measured. A print button reuses the same layout for a
 * doctor-ready PDF via the browser. Only descriptive, data-backed statements —
 * no diagnosis (spec §11).
 */

import './report.css';
import type { AppContext, RouteState, View } from '../app-context';
import type { StringKey } from '../../i18n/index';
import { formatDateTime, formatNumber } from '../../i18n/index';
import { valueWithUnitEl } from '../format-value';
import {
  ageMonths,
  buildReport,
  buildSnapshotReport,
  composeReportTitle,
  SNAPSHOT_AGE_DAYS,
  type AttentionItem,
  type ReportRow,
  type SnapshotReportRow,
} from './report-model';
import { profileDisplayName } from './settings-model';
import type { MetricCategory, MetricId } from '../../core/types';

type ReportMode = 'range' | 'snapshot';

/**
 * A metric subset the Overview hands off when its "Summary / print" button is
 * used under an active filter: the pre-selected metric ids plus a display label
 * (a tag name, or "selection of {n} metrics"). Passed via module state — mirrors
 * review's `setPendingImport` — so the ISO-date route param stays free for the
 * snapshot date; the two compose. Read once, on the report's entry.
 */
export interface ReportSelection {
  metricIds: MetricId[];
  label?: string;
}

let pendingSelection: ReportSelection | undefined;

/** Store the subset the report should preselect on its next entry. */
export function setReportSelection(selection: ReportSelection): void {
  pendingSelection = selection;
}

/** Read (and clear) the pending subset; `undefined` ⇒ the full report. */
export function takeReportSelection(): ReportSelection | undefined {
  const selection = pendingSelection;
  pendingSelection = undefined;
  return selection;
}

/** The calendar day (YYYY-MM-DD) of an ISO instant. */
function isoDay(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : iso;
}

declare const __APP_VERSION__: string;

const CATEGORY_KEY: Record<MetricCategory, StringKey> = {
  lab: 'report.category.lab',
  home: 'report.category.home',
  wearable: 'report.category.wearable',
  custom: 'report.category.custom',
};

const RANGE_KEY: Record<ReportRow['rangeState'], StringKey | undefined> = {
  below: 'range.below',
  above: 'range.above',
  'in-range': 'range.within',
  unknown: undefined,
};

const TREND_KEY: Record<ReportRow['trend'], StringKey | undefined> = {
  rising: 'metric.detail.trend.rising',
  falling: 'metric.detail.trend.falling',
  fluctuating: 'metric.detail.trend.fluctuating',
  flat: 'metric.detail.trend.flat',
  insufficient: undefined,
};

export const reportView: View = {
  render(container: HTMLElement, ctx: AppContext, route: RouteState): void {
    const { t } = ctx;
    container.replaceChildren();

    const data = ctx.data();

    // A route param carrying an ISO date pre-selects snapshot mode at that date
    // (F2: the Overview "export this state" hand-off). Otherwise range mode.
    const paramDay =
      route?.param && /^\d{4}-\d{2}-\d{2}/.test(route.param) ? route.param.slice(0, 10) : undefined;
    let mode: ReportMode = paramDay ? 'snapshot' : 'range';
    let asOfIso = paramDay ?? isoDay(ctx.now());

    // The metric subset handed off by a filtered Overview (read once on entry;
    // orthogonal to the date mode, so it survives the range/snapshot toggle).
    const selection = takeReportSelection();
    const subsetLabel = selection?.label;

    // Universe of selectable metrics = every non-hidden metric with any data
    // (the full report's rows). The checkbox panel preselects the subset (or all
    // of them when there is no subset); the report body renders only what stays
    // checked — a preselection the user can adjust, not a lock.
    const universe = buildReport(data, ctx.catalog(), ctx.units, ctx.locale, ctx.now())
      .categories.flatMap((c) => c.rows)
      .map((r) => ({ metricId: r.metricId, nameKey: r.nameKey, customName: r.customName }));
    const universeIds = new Set(universe.map((u) => u.metricId));
    const selectedIds = new Set<MetricId>(
      selection ? selection.metricIds.filter((id) => universeIds.has(id)) : universe.map((u) => u.metricId),
    );

    const root = el('div', 'report');

    // Back to the Overview (like the metric detail); hidden when printing.
    const back = el('button', 'report-back') as HTMLButtonElement;
    back.type = 'button';
    back.textContent = `‹ ${t('metric.detail.back')}`;
    back.addEventListener('click', () => ctx.navigate('overview'));
    root.append(back);

    // Header — title and the toolbar share one aligned row; the toolbar stays in
    // .report-toolbar so it is hidden when printing.
    const header = el('header', 'report-header');
    const titleRow = el('div', 'report-titlerow');
    const h1 = textEl('h1', '');
    titleRow.append(h1);

    const toolbar = el('div', 'report-toolbar');

    // Range | As-of-date mode switch.
    const modeSeg = el('div', 'report-mode-segment');
    const modeBtns: { id: ReportMode; btn: HTMLButtonElement }[] = [];
    for (const m of [
      { id: 'range' as ReportMode, labelKey: 'export.mode.range' as StringKey },
      { id: 'snapshot' as ReportMode, labelKey: 'export.mode.snapshot' as StringKey },
    ]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'report-mode-btn';
      btn.textContent = t(m.labelKey);
      btn.addEventListener('click', () => {
        mode = m.id;
        paint();
      });
      modeSeg.append(btn);
      modeBtns.push({ id: m.id, btn });
    }
    toolbar.append(modeSeg);

    // As-of date input (snapshot mode only).
    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.className = 'report-asof-date';
    dateInput.value = asOfIso;
    dateInput.setAttribute('aria-label', t('export.asOfDateLabel'));
    dateInput.addEventListener('change', () => {
      if (dateInput.value) asOfIso = dateInput.value;
      paint();
    });
    toolbar.append(dateInput);

    const printBtn = document.createElement('button');
    printBtn.className = 'primary';
    printBtn.textContent = t('report.print');
    printBtn.addEventListener('click', () => window.print());
    toolbar.append(printBtn);

    titleRow.append(toolbar);
    header.append(titleRow);
    const meta = el('p', 'muted');
    header.append(meta);

    // Screen-only metric picker (collapsed): every metric with data, the subset
    // pre-checked. Hidden when printing (.report-select is display:none in print).
    if (universe.length > 0) {
      const details = el('details', 'report-select') as HTMLDetailsElement;
      const summary = document.createElement('summary');
      details.append(summary);
      const listEl = el('div', 'report-select-list');
      const updateSelectSummary = (): void => {
        summary.textContent = t('report.chooseMetrics', {
          shown: selectedIds.size,
          total: universe.length,
        });
      };
      for (const u of universe) {
        const label = el('label', 'report-select-item');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = selectedIds.has(u.metricId);
        cb.addEventListener('change', () => {
          if (cb.checked) selectedIds.add(u.metricId);
          else selectedIds.delete(u.metricId);
          updateSelectSummary();
          paint();
        });
        label.append(cb, textEl('span', metricName(ctx, u)));
        listEl.append(label);
      }
      details.append(listEl);
      updateSelectSummary();
      header.append(details);
    }

    root.append(header);

    const body = el('div', 'report-body');
    root.append(body);

    root.append(textEl('p', t('report.disclaimer'), 'report-disclaimer muted'));
    root.append(textEl('p', `Vitametr v${versionString()}`, 'report-footer muted'));

    container.append(root);
    paint();

    function paint(): void {
      // Title + meta reflect the mode.
      h1.textContent =
        mode === 'snapshot'
          ? composeReportTitle(
              t('report.snapshotTitle', { date: formatDateTime(asOfIso, 'date') }),
              subsetLabel,
            )
          : subsetLabel
            ? t('report.subsetTitle', { label: subsetLabel })
            : t('report.title');
      meta.textContent =
        `${t('report.profile')}: ${profileDisplayName(data.profile.name, t)} · ` +
        t('report.generated', { date: formatDateTime(ctx.now(), 'datetime') });
      dateInput.hidden = mode !== 'snapshot';
      for (const { id, btn } of modeBtns) {
        const active = id === mode;
        btn.classList.toggle('is-active', active);
        if (active) btn.setAttribute('aria-current', 'true');
        else btn.removeAttribute('aria-current');
      }

      body.replaceChildren();
      if (mode === 'snapshot') paintSnapshot();
      else paintRange();
    }

    function paintRange(): void {
      const model = buildReport(data, ctx.catalog(), ctx.units, ctx.locale, ctx.now(), [...selectedIds]);
      if (model.totalMetrics === 0) {
        body.append(textEl('p', t('report.empty'), 'muted'));
        return;
      }
      if (model.attention.length > 0) {
        const box = el('section', 'report-attention');
        box.append(textEl('h2', t('report.attention')));
        const ul = document.createElement('ul');
        for (const item of model.attention) ul.append(attentionLi(ctx, item));
        box.append(ul);
        body.append(box);
      }
      for (const cat of model.categories) {
        const section = el('section', 'report-section');
        section.append(textEl('h2', t(CATEGORY_KEY[cat.category])));
        section.append(renderCards(ctx, cat.rows));
        section.append(renderTable(ctx, cat.rows));
        body.append(section);
      }
    }

    function paintSnapshot(): void {
      const model = buildSnapshotReport(data, ctx.catalog(), ctx.units, ctx.locale, asOfIso, [...selectedIds]);
      if (model.totalMetrics === 0) {
        body.append(textEl('p', t('report.empty'), 'muted'));
        return;
      }
      const section = el('section', 'report-section');
      section.append(renderSnapshotCards(ctx, model.rows));
      section.append(renderSnapshotTable(ctx, model.rows));
      body.append(section);
    }
  },
};

/** Snapshot table: Metric | Value | Reference | Measured | Source. */
function renderSnapshotTable(ctx: AppContext, rows: SnapshotReportRow[]): HTMLElement {
  const { t } = ctx;
  const scroll = el('div', 'report-scroll');
  const table = document.createElement('table');

  const head = document.createElement('tr');
  for (const key of [
    'report.metric',
    'report.value',
    'report.reference',
    'report.measured',
    'report.source',
  ] as StringKey[]) {
    const th = document.createElement('th');
    th.textContent = t(key);
    head.append(th);
  }
  table.append(head);

  for (const r of rows) {
    const tr = document.createElement('tr');
    if (isSnapshotOutOfRange(r)) tr.className = 'out-of-range';
    tr.append(td(snapshotMetricName(ctx, r)));
    tr.append(valueCell(ctx, r, 'num'));
    tr.append(snapshotReferenceCell(ctx, r));
    tr.append(measuredCell(ctx, r));
    tr.append(td(r.sourceName ?? '—'));
    table.append(tr);
  }
  scroll.append(table);
  return scroll;
}

/** Stacked snapshot card-rows for narrow screens. */
function renderSnapshotCards(ctx: AppContext, rows: SnapshotReportRow[]): HTMLElement {
  const { t } = ctx;
  const list = el('div', 'report-cards');
  for (const r of rows) {
    const card = el('div', 'report-card');
    if (isSnapshotOutOfRange(r)) card.className = 'report-card out-of-range';
    card.append(textEl('div', snapshotMetricName(ctx, r), 'report-card-name'));
    const grid = el('dl', 'report-card-grid');
    valueInto(ctx, r, cardField(grid, t('report.value'), ''));
    const refDd = cardField(grid, t('report.reference'), '');
    snapshotReferenceInto(ctx, r, refDd);
    const measuredDd = cardField(grid, t('report.measured'), '');
    measuredInto(ctx, r, measuredDd);
    cardField(grid, t('report.source'), r.sourceName ?? '—');
    card.append(grid);
    list.append(card);
  }
  return list;
}

function isSnapshotOutOfRange(r: SnapshotReportRow): boolean {
  return r.rangeState === 'above' || r.rangeState === 'below';
}

function snapshotMetricName(ctx: AppContext, r: SnapshotReportRow): string {
  if (r.customName) return r.customName;
  if (r.nameKey) return ctx.t(r.nameKey as StringKey);
  return '';
}

/**
 * Fill `node` with a reading via the shared value+unit formatter (numeric →
 * `<span class="value-unit">` with proper power typography; qualitative → text).
 * Shared by the range and snapshot reports (both carry value/operator/unit).
 */
function valueInto(
  ctx: AppContext,
  r: { value?: number; operator?: import('../../core/types').Operator; unit: string; textValue?: string },
  node: HTMLElement,
): void {
  if (r.value === undefined) {
    node.textContent = r.textValue ?? '';
    return;
  }
  const unit = ctx.units.getUnit(r.unit)?.display ?? r.unit;
  node.append(
    valueWithUnitEl({
      value: r.value,
      ...(unit ? { unit } : {}),
      ...(r.operator ? { operator: r.operator } : {}),
    }),
  );
}

/** A `<td>` holding a reading via {@link valueInto}. */
function valueCell(
  ctx: AppContext,
  r: { value?: number; operator?: import('../../core/types').Operator; unit: string; textValue?: string },
  className?: string,
): HTMLElement {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  valueInto(ctx, r, cell);
  return cell;
}

function snapshotReferenceCell(ctx: AppContext, r: SnapshotReportRow): HTMLElement {
  const cell = document.createElement('td');
  snapshotReferenceInto(ctx, r, cell);
  return cell;
}

function snapshotReferenceInto(ctx: AppContext, r: SnapshotReportRow, node: HTMLElement): void {
  const hasRange = r.refLow !== undefined || r.refHigh !== undefined;
  node.textContent = hasRange
    ? `${r.refLow !== undefined ? formatNumber(r.refLow) : ''}–${r.refHigh !== undefined ? formatNumber(r.refHigh) : ''}`
    : '—';
  const rangeKey = RANGE_KEY[r.rangeState];
  if (rangeKey && isSnapshotOutOfRange(r)) {
    const pill = el('span', `pill ${r.rangeState}`);
    pill.textContent = ctx.t(rangeKey);
    node.append(document.createTextNode(' '), pill);
  }
}

/** Measured date + a muted "measured N months ago" note for old values. */
function measuredCell(ctx: AppContext, r: SnapshotReportRow): HTMLElement {
  const cell = document.createElement('td');
  measuredInto(ctx, r, cell);
  return cell;
}

function measuredInto(ctx: AppContext, r: SnapshotReportRow, node: HTMLElement): void {
  node.textContent = formatDateTime(r.measuredIso, 'date');
  if (r.ageDays >= SNAPSHOT_AGE_DAYS) {
    const age = el('span', 'report-age muted');
    age.textContent = ctx.t('report.snapshotAge', { months: ageMonths(r.ageDays) });
    node.append(document.createTextNode(' '), age);
  }
}

function renderTable(ctx: AppContext, rows: ReportRow[]): HTMLElement {
  const { t } = ctx;
  const scroll = el('div', 'report-scroll');
  const table = document.createElement('table');

  const head = document.createElement('tr');
  for (const key of [
    'report.metric',
    'report.latest',
    'report.reference',
    'report.change',
    'report.trend',
    'report.measured',
  ] as StringKey[]) {
    const th = document.createElement('th');
    th.textContent = t(key);
    head.append(th);
  }
  table.append(head);

  for (const r of rows) {
    const tr = document.createElement('tr');
    if (isOutOfRange(r)) tr.className = 'out-of-range';
    tr.append(td(metricName(ctx, r)));
    tr.append(valueCell(ctx, r, 'num'));
    tr.append(referenceCell(ctx, r));
    tr.append(td(changeText(ctx, r), 'num'));
    tr.append(td(trendText(ctx, r)));
    tr.append(td(formatDateTime(r.lastMeasuredIso, 'date')));
    table.append(tr);
  }
  scroll.append(table);
  return scroll;
}

/** Stacked card-rows for narrow screens (the table overflows there). */
function renderCards(ctx: AppContext, rows: ReportRow[]): HTMLElement {
  const { t } = ctx;
  const list = el('div', 'report-cards');
  for (const r of rows) {
    const card = el('div', 'report-card');
    if (isOutOfRange(r)) card.className = 'report-card out-of-range';
    card.append(textEl('div', metricName(ctx, r), 'report-card-name'));
    const grid = el('dl', 'report-card-grid');
    valueInto(ctx, r, cardField(grid, t('report.latest'), ''));
    const refDd = cardField(grid, t('report.reference'), '');
    referenceInto(ctx, r, refDd);
    cardField(grid, t('report.change'), changeText(ctx, r));
    cardField(grid, t('report.trend'), trendText(ctx, r));
    cardField(grid, t('report.measured'), formatDateTime(r.lastMeasuredIso, 'date'));
    card.append(grid);
    list.append(card);
  }
  return list;
}

/** Append a labeled dt/dd pair; returns the dd for further content. */
function cardField(grid: HTMLElement, label: string, value: string): HTMLElement {
  grid.append(textEl('dt', label));
  const dd = textEl('dd', value);
  grid.append(dd);
  return dd;
}

function isOutOfRange(r: ReportRow): boolean {
  return r.rangeState === 'above' || r.rangeState === 'below';
}

function trendText(ctx: AppContext, r: ReportRow): string {
  const key = TREND_KEY[r.trend];
  return key ? ctx.t(key) : '—';
}

function metricName(ctx: AppContext, r: { nameKey?: string; customName?: string }): string {
  if (r.customName) return r.customName;
  if (r.nameKey) return ctx.t(r.nameKey as StringKey);
  return '';
}

function referenceCell(ctx: AppContext, r: ReportRow): HTMLElement {
  const cell = document.createElement('td');
  referenceInto(ctx, r, cell);
  return cell;
}

/** Fill `node` with the reference range (or "—" when absent) plus a state pill. */
function referenceInto(ctx: AppContext, r: ReportRow, node: HTMLElement): void {
  const hasRange = r.refLow !== undefined || r.refHigh !== undefined;
  const rangeText = hasRange
    ? `${r.refLow !== undefined ? formatNumber(r.refLow) : ''}–${r.refHigh !== undefined ? formatNumber(r.refHigh) : ''}`
    : '—';
  node.textContent = rangeText;
  const rangeKey = RANGE_KEY[r.rangeState];
  if (rangeKey && isOutOfRange(r)) {
    const pill = el('span', `pill ${r.rangeState}`);
    pill.textContent = ctx.t(rangeKey);
    node.append(document.createTextNode(' '), pill);
  }
}

function changeText(ctx: AppContext, r: ReportRow): string {
  if (r.deltaKind === 'up' && r.deltaAmount !== undefined) {
    return ctx.t('overview.change.up', { amount: formatNumber(r.deltaAmount) });
  }
  if (r.deltaKind === 'down' && r.deltaAmount !== undefined) {
    return ctx.t('overview.change.down', { amount: formatNumber(r.deltaAmount) });
  }
  if (r.deltaKind === 'same') return ctx.t('overview.change.same');
  return '—';
}

function attentionLi(ctx: AppContext, item: AttentionItem): HTMLElement {
  const li = document.createElement('li');
  const name = metricName(ctx, item);
  let reason: string;
  if (item.reason === 'out-of-range') reason = ctx.t('report.outOfRange');
  else if (item.reason === 'stale') reason = ctx.t('report.stale', { days: item.days ?? 0 });
  else reason = ctx.t('report.mixedUnits');
  li.textContent = `${name} — ${reason}`;
  if (item.reason === 'out-of-range') li.className = 'attn-range';
  li.addEventListener('click', () => ctx.navigate('metric', item.metricId));
  return li;
}

function versionString(): string {
  return typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

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
function td(text: string, className?: string): HTMLElement {
  const node = document.createElement('td');
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
