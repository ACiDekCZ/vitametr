/**
 * Metric detail screen (K8e).
 *
 * Reads `route.param` as the metric id and shows: a back link to the overview,
 * a header (name + current value + range pill + display-unit segmented switch),
 * a period segmented switch (3M / year / 5y / all), the hand-rolled SVG chart
 * (restyled — see chart.ts), a row of Minimum / Average / Maximum mini-cards
 * computed over the shown series, and a card-list of measurements with inline
 * edit / delete (in-view confirm — never a native dialog).
 *
 * Converting the whole series (values AND reference bounds) into the chosen
 * display unit before building ChartPoints happens HERE; the chart layers never
 * convert (spec §2, §8). The reference-band caption is also built here (localized)
 * and handed to the chart via `handlers.bandLabel`, keeping chart.ts translation-free.
 */

import type { AppContext, RouteState, View } from '../app-context';
import type { StringKey } from '../../i18n/index';
import { formatDateTime, formatNumber } from '../../i18n/index';
import type { Measurement, MeasurementId, Metric, MetricId, Operator } from '../../core/types';
import {
  latest,
  measurementText,
  mixedUnits,
  rangePosition,
  seriesFor,
  trend,
} from '../../core/series';
import { buildChartModel, type ChartConfig, type ChartPoint } from '../chart-model';
import { renderChart, type ChartHandlers } from '../chart';
import { seriesStats } from '../metric-model';
import { resolveDisplayUnit } from './overview-model';
import { rangeStatusKey } from '../range-status';
import { tagLabel } from '../../core/tags';
import { watchStar } from '../components/watch-star';
import { sourcePicker } from '../components/source-picker';
import type { SourceSelection } from '../components/source-picker-model';
import { valueWithUnitEl } from '../format-value';
import '../chart.css';

type Period = '3m' | 'year' | '5y' | 'all';

const CHART_HEIGHT = 240;
const CHART_PADDING = { top: 16, right: 14, bottom: 26, left: 46 };

const PERIOD_OPTIONS: readonly { id: Period; labelKey: StringKey }[] = [
  { id: '3m', labelKey: 'metric.detail.period3m' },
  { id: 'year', labelKey: 'metric.detail.periodYear' },
  { id: '5y', labelKey: 'metric.detail.period5y' },
  { id: 'all', labelKey: 'metric.detail.periodAll' },
];

const TREND_KEY: Record<'rising' | 'falling' | 'fluctuating' | 'flat', StringKey> = {
  rising: 'metric.detail.trend.rising',
  falling: 'metric.detail.trend.falling',
  fluctuating: 'metric.detail.trend.fluctuating',
  flat: 'metric.detail.trend.flat',
};

const STAT_KEY: Record<'min' | 'avg' | 'max', StringKey> = {
  min: 'metric.detail.min',
  avg: 'metric.detail.avg',
  max: 'metric.detail.max',
};

/** A measurement paired with its value/bounds converted to the display unit. */
interface ConvertedPoint {
  m: Measurement;
  value: number;
  refLow?: number;
  refHigh?: number;
  /** True when the measurement was convertible into the display unit. */
  convertible: boolean;
}

function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function metricName(ctx: AppContext, metric: Metric): string {
  if (metric.nameKey) return ctx.t(metric.nameKey as StringKey);
  return metric.customName ?? metric.key ?? '';
}

function unitDisplay(ctx: AppContext, code: string): string {
  return ctx.units.getUnit(code)?.display ?? code;
}

/** Compute an inclusive `from` ISO bound for a period, relative to ctx.now(). */
function periodFrom(ctx: AppContext, period: Period): string | undefined {
  if (period === 'all') return undefined;
  const now = new Date(ctx.now());
  if (period === '3m') now.setMonth(now.getMonth() - 3);
  else if (period === 'year') now.setFullYear(now.getFullYear() - 1);
  else now.setFullYear(now.getFullYear() - 5);
  return now.toISOString();
}

/** Range-position → an i18n label key (shared, one source of truth) and the pill
 * modifier class. */
function rangeLabel(pos: ReturnType<typeof rangePosition>): { key: StringKey; cls: string } {
  const cls = pos === 'above' ? 'above' : pos === 'below' ? 'below' : pos === 'in-range' ? 'ok' : '';
  return { key: rangeStatusKey(pos), cls };
}

/** Signed change label between two display-unit values, via overview keys. */
function changeLabel(ctx: AppContext, curr: number, prev: number, unit: string, metric: Metric): string {
  const diff = ctx.units.round(curr - prev, unit, metric);
  if (diff === 0) return ctx.t('overview.change.same');
  const amount = `${formatNumber(Math.abs(diff))} ${unitDisplay(ctx, unit)}`;
  return diff > 0
    ? ctx.t('overview.change.up', { amount })
    : ctx.t('overview.change.down', { amount });
}

function operatorPrefix(operator?: Operator): string {
  return operator !== undefined ? `${operator} ` : '';
}

export const metricView: View = {
  render(container: HTMLElement, ctx: AppContext, route: RouteState): void | (() => void) {
    container.replaceChildren();

    const metricId = route.param as MetricId | undefined;
    const resolved = metricId ? ctx.catalog().byId(metricId) : undefined;

    if (!resolved) {
      const h = el('h1');
      h.textContent = ctx.t('metric.detail.measurements');
      const p = el('p', 'muted');
      p.textContent = ctx.t('metric.detail.noData');
      container.append(h, p);
      return;
    }
    // A non-optional binding so nested closures see the resolved metric.
    const metric: Metric = resolved;

    // --- View state -----------------------------------------------------
    let period: Period = 'all';
    // A qualitative metric (text/enum/multi) has no chart, stats, period or unit
    // controls — just the latest string and a list of past strings.
    const isText = metric.valueType !== 'number';
    const reachable = ctx.units.reachableUnits(metric);
    // The display unit is governed solely by the global unit system (via the shared
    // resolver — SI/US/auto→locale); there is no per-metric switcher. `reachableUnits`
    // may differ from `metric.units`, so guard and fall back to the first reachable.
    const resolvedUnit = resolveDisplayUnit(metric, ctx.data().settings, ctx.locale);
    const unit = reachable.includes(resolvedUnit) ? resolvedUnit : reachable[0];
    let editingId: MeasurementId | undefined;
    let deletingId: MeasurementId | undefined;

    // --- Back link ------------------------------------------------------
    const back = el('button', 'metric-back') as HTMLButtonElement;
    back.type = 'button';
    back.textContent = `‹ ${ctx.t('metric.detail.back')}`;
    back.addEventListener('click', () => ctx.navigate('overview'));
    container.append(back);

    // --- Header: name + star + current value + range pill + unit switch --
    const header = el('div', 'metric-header');
    const headMain = el('div', 'metric-header-main');
    const titleRow = el('div', 'metric-title-row');
    const title = el('h1', 'metric-title');
    title.textContent = metricName(ctx, metric);
    titleRow.append(title);

    // The star quick-toggle rides with the tag UI (hidden when tags are off).
    const useTags = ctx.data().settings.useTags !== false;
    if (useTags) {
      titleRow.append(
        watchStar({ ctx, metric, variant: 'watch-star--inline', onToggle: () => paintHeaderTags() }),
      );
    }

    const valueRow = el('div', 'metric-current');
    headMain.append(titleRow, valueRow);

    // Non-interactive tag chips (metric detail only; overview/entry unchanged).
    // Repainted after a star toggle so the "Watched" chip appears / disappears.
    let tagRow: HTMLElement | undefined;
    function paintHeaderTags(): void {
      const tags = useTags ? ctx.catalog().byId(metric.id)?.tags ?? [] : [];
      if (tags.length === 0) {
        tagRow?.remove();
        tagRow = undefined;
        return;
      }
      if (!tagRow) {
        tagRow = el('div', 'metric-header-tags');
        headMain.append(tagRow);
      }
      tagRow.replaceChildren();
      for (const tag of tags) {
        const chip = el('span', 'tag-chip tag-chip--mini');
        chip.textContent = tagLabel(tag, ctx.t);
        tagRow.append(chip);
      }
    }
    paintHeaderTags();

    header.append(headMain);
    container.append(header);

    // --- Period segmented control ---------------------------------------
    const periodGroup = el('div', 'seg metric-period');
    if (!isText) container.append(periodGroup);

    // Long-term trend + mixed-units warning (over the FULL series).
    const fullSeries = seriesFor(ctx.data().measurements, metric.id);
    const trendResult = trend(fullSeries, ctx.units, metric);
    if (!isText && mixedUnits(fullSeries)) {
      const warn = el('p', 'metric-warning');
      warn.textContent = ctx.t('metric.detail.mixedUnits');
      container.append(warn);
    }

    const chartCard = el('div', 'card metric-chart-card');
    // The long-term trend word reads as a labelled attribute of the chart:
    // a small chip in the card header, not loose text floating above it.
    // Hidden when the series is too short to characterise a trend.
    if (trendResult !== 'insufficient') {
      const chartHeader = el('div', 'metric-chart-header');
      const trendChip = el('span', 'chart-trend-chip');
      trendChip.textContent = ctx.t(TREND_KEY[trendResult]);
      chartHeader.append(trendChip);
      chartCard.append(chartHeader);
    }
    const chartHost = el('div', 'metric-chart');
    chartCard.append(chartHost);
    if (!isText) container.append(chartCard);

    const statsHost = el('div', 'metric-stats');
    if (!isText) container.append(statsHost);

    const listHost = el('div');
    container.append(listHost);

    // --- Segmented controls --------------------------------------------
    function renderPeriodControls(): void {
      periodGroup.replaceChildren();
      for (const opt of PERIOD_OPTIONS) {
        const active = opt.id === period;
        const b = el('button', active ? 'seg-btn seg-btn--active' : 'seg-btn') as HTMLButtonElement;
        b.type = 'button';
        b.textContent = ctx.t(opt.labelKey);
        b.setAttribute('aria-pressed', String(active));
        b.addEventListener('click', () => {
          period = opt.id;
          renderPeriodControls();
          rebuild();
        });
        periodGroup.append(b);
      }
    }

    // --- Current value + range pill (over the full series) --------------
    function renderCurrentValue(): void {
      valueRow.replaceChildren();
      const newest = latest(fullSeries);
      if (!newest) {
        const none = el('span', 'muted');
        none.textContent = ctx.t('metric.detail.noData');
        valueRow.append(none);
        return;
      }
      // A text (qualitative) result: show the string, no unit or conversion.
      if (newest.value === undefined) {
        const big = el('span', 'metric-value metric-value--text');
        big.textContent = measurementText(newest) ?? '';
        valueRow.append(big);
        return;
      }

      const conv = ctx.units.convertMeasurement(newest, unit, metric);
      const value = conv ? conv.value : newest.value;
      const shownUnit = conv ? unit : newest.unit;

      valueRow.append(
        valueWithUnitEl({
          value: ctx.units.round(value, shownUnit, metric),
          unit: unitDisplay(ctx, shownUnit),
          ...(newest.operator ? { operator: newest.operator } : {}),
          valueClass: 'metric-value',
          unitClass: 'metric-value-unit',
        }),
      );

      const pos = rangePosition(newest);
      if (pos !== 'unknown') {
        const rl = rangeLabel(pos);
        const pill = el('span', `pill ${rl.cls}`.trim());
        pill.textContent = ctx.t(rl.key);
        valueRow.append(pill);
      }
    }

    // --- Data for the current period / unit ----------------------------
    function convertedSeries(): ConvertedPoint[] {
      const series = seriesFor(ctx.data().measurements, metric.id, {
        from: periodFrom(ctx, period),
      }).filter((m): m is Measurement & { value: number } => m.value !== undefined); // text never charts
      return series.map((m) => {
        const conv = ctx.units.convertMeasurement(m, unit, metric);
        if (!conv) {
          return { m, value: m.value, refLow: m.refLow, refHigh: m.refHigh, convertible: false };
        }
        return { m, value: conv.value, refLow: conv.refLow, refHigh: conv.refHigh, convertible: true };
      });
    }

    // --- Chart ----------------------------------------------------------
    let converted: ConvertedPoint[] = [];

    /** Localized in-band caption from the newest point that has both bounds. */
    function bandLabel(chartPoints: ConvertedPoint[]): string | undefined {
      for (let i = chartPoints.length - 1; i >= 0; i -= 1) {
        const cp = chartPoints[i];
        if (cp.refLow !== undefined && cp.refHigh !== undefined) {
          return ctx.t('metric.detail.refBand', {
            low: formatNumber(ctx.units.round(cp.refLow, unit, metric)),
            high: formatNumber(ctx.units.round(cp.refHigh, unit, metric)),
          });
        }
      }
      return undefined;
    }

    function drawChart(): void {
      const width = Math.max(240, Math.round(chartHost.clientWidth) || 320);
      const config: ChartConfig = {
        width,
        height: CHART_HEIGHT,
        padding: CHART_PADDING,
        unitLabel: unitDisplay(ctx, unit),
      };
      const chartPoints = converted.filter((c) => c.convertible);
      const points: ChartPoint[] = chartPoints.map((c) => ({
        t: Date.parse(c.m.takenAt),
        value: c.value,
        operator: c.m.operator,
        refLow: c.refLow,
        refHigh: c.refHigh,
      }));

      const model = buildChartModel(points, config);

      const handlers: ChartHandlers = {
        ariaLabel: `${metricName(ctx, metric)}, ${ctx.t('timeline.valuesCount', { count: points.length })}`,
        tooltip: (_p, index) => buildTooltip(chartPoints, index),
        bandLabel: bandLabel(chartPoints),
      };
      renderChart(chartHost, model, handlers);
    }

    function buildTooltip(chartPoints: ConvertedPoint[], index: number): string[] {
      const cp = chartPoints[index];
      if (!cp) return [];
      const lines: string[] = [];
      lines.push(formatDateTime(cp.m.takenAt, cp.m.timePrecision));
      lines.push(
        `${operatorPrefix(cp.m.operator)}${formatNumber(ctx.units.round(cp.value, unit, metric))} ${unitDisplay(ctx, unit)}`,
      );

      const prev = chartPoints[index - 1];
      if (prev && cp.m.operator === undefined && prev.m.operator === undefined) {
        lines.push(
          `${ctx.t('metric.detail.change')}: ${changeLabel(ctx, cp.value, prev.value, unit, metric)}`,
        );
      }

      const rl = rangeLabel(rangePosition(cp.m));
      lines.push(`${ctx.t('metric.detail.range')}: ${ctx.t(rl.key)}`);

      const source = sourceName(ctx, cp.m);
      if (source) lines.push(`${ctx.t('metric.detail.source')}: ${source}`);
      return lines;
    }

    // --- Min / Average / Maximum mini-cards -----------------------------
    function renderStats(): void {
      statsHost.replaceChildren();
      const values = converted.filter((c) => c.convertible).map((c) => c.value);
      const stats = seriesStats(values);
      if (!stats) return;
      const entries: [keyof typeof STAT_KEY, number][] = [
        ['min', stats.min],
        ['avg', stats.avg],
        ['max', stats.max],
      ];
      for (const [id, value] of entries) {
        const card = el('div', 'metric-stat');
        const label = el('div', 'metric-stat-label');
        label.textContent = ctx.t(STAT_KEY[id]);
        const val = el('div', 'metric-stat-value');
        val.textContent = formatNumber(ctx.units.round(value, unit, metric));
        card.append(label, val);
        statsHost.append(card);
      }
    }

    // --- Measurements card-list ----------------------------------------
    function rebuildList(): void {
      listHost.replaceChildren();
      const heading = el('h2', 'metric-list-heading');
      heading.textContent = ctx.t('metric.detail.measurements');
      listHost.append(heading);

      if (converted.length === 0) {
        const empty = el('p', 'muted');
        empty.textContent = ctx.t('metric.detail.noData');
        listHost.append(empty);
        return;
      }

      const list = el('div', 'card metric-list');
      // Newest first; change compares to the chronologically previous point.
      for (let i = converted.length - 1; i >= 0; i -= 1) {
        const cp = converted[i];
        if (cp.m.id === editingId) {
          list.append(renderEditRow(cp));
        } else {
          list.append(renderRow(cp, converted[i - 1]));
        }
      }
      listHost.append(list);
    }

    function renderRow(cp: ConvertedPoint, prev: ConvertedPoint | undefined): HTMLElement {
      const row = el('div', 'metric-row');

      const meta = el('div', 'metric-row-meta');
      const date = el('div', 'metric-row-date');
      date.textContent = formatDateTime(cp.m.takenAt, cp.m.timePrecision);
      meta.append(date);
      const source = sourceName(ctx, cp.m);
      if (source) {
        const src = el('div', 'metric-row-source');
        src.textContent = source;
        meta.append(src);
      }
      if (cp.m.note) {
        const note = el('div', 'metric-row-source');
        note.textContent = cp.m.note;
        meta.append(note);
      }

      const value = valueWithUnitEl({
        value: cp.convertible ? ctx.units.round(cp.value, unit, metric) : cp.value,
        unit: cp.convertible ? unitDisplay(ctx, unit) : unitDisplay(ctx, cp.m.unit),
        ...(cp.m.operator ? { operator: cp.m.operator } : {}),
        wrapClass: 'metric-row-value',
      });

      // Reading order: value → range state → change (a leading delta before the
      // value reads confusingly). The chip's colour tracks range state, not the
      // direction of change (§4: descriptive, not diagnostic).
      const trailing = el('div', 'metric-row-trailing');
      trailing.append(value);
      const pos = rangePosition(cp.m);
      if (pos !== 'unknown') {
        const rl = rangeLabel(pos);
        const chip = el('span', `pill ${rl.cls}`.trim());
        chip.textContent = ctx.t(rl.key);
        trailing.append(chip);
      }
      if (
        prev &&
        cp.convertible &&
        prev.convertible &&
        cp.m.operator === undefined &&
        prev.m.operator === undefined
      ) {
        const delta = el('span', 'metric-row-delta');
        delta.textContent = changeLabel(ctx, cp.value, prev.value, unit, metric);
        trailing.append(delta);
      }

      const actions = el('div', 'metric-row-actions');
      if (cp.m.id === deletingId) {
        actions.append(renderDeleteConfirm(cp.m));
      } else {
        const edit = el('button', 'metric-icon-btn') as HTMLButtonElement;
        edit.type = 'button';
        edit.textContent = ctx.t('common.edit');
        edit.setAttribute('aria-label', ctx.t('metric.detail.editMeasurement'));
        edit.addEventListener('click', () => {
          editingId = cp.m.id;
          deletingId = undefined;
          rebuildList();
        });
        const del = el('button', 'metric-icon-btn danger') as HTMLButtonElement;
        del.type = 'button';
        del.textContent = ctx.t('common.delete');
        del.addEventListener('click', () => {
          deletingId = cp.m.id;
          editingId = undefined;
          rebuildList();
        });
        actions.append(edit, del);
      }

      row.append(meta, trailing, actions);
      return row;
    }

    function renderDeleteConfirm(m: Measurement): HTMLElement {
      const wrap = el('div', 'metric-confirm');
      const msg = el('span', 'muted');
      msg.textContent = ctx.t('metric.detail.deleteConfirm');
      const yes = el('button', 'danger') as HTMLButtonElement;
      yes.type = 'button';
      yes.textContent = ctx.t('common.confirm');
      yes.addEventListener('click', () => {
        ctx.mutate((d) => {
          d.measurements = d.measurements.filter((x) => x.id !== m.id);
        });
        deletingId = undefined;
        if (editingId === m.id) editingId = undefined;
        ctx.toast(ctx.t('common.delete'), 'success');
        rebuild();
      });
      const no = el('button') as HTMLButtonElement;
      no.type = 'button';
      no.textContent = ctx.t('common.cancel');
      no.addEventListener('click', () => {
        deletingId = undefined;
        rebuildList();
      });
      wrap.append(msg, yes, no);
      return wrap;
    }

    function renderEditRow(cp: ConvertedPoint): HTMLElement {
      const row = el('div', 'metric-row metric-edit-row');
      const form = el('div', 'metric-edit');

      const valueInput = document.createElement('input');
      valueInput.type = 'number';
      valueInput.step = 'any';
      valueInput.value = String(cp.m.value);
      valueInput.setAttribute('aria-label', ctx.t('metric.detail.value'));

      const unitSelect = document.createElement('select');
      unitSelect.setAttribute('aria-label', ctx.t('metric.detail.unit'));
      for (const code of metric.units) {
        const o = document.createElement('option');
        o.value = code;
        o.textContent = unitDisplay(ctx, code);
        if (code === cp.m.unit) o.selected = true;
        unitSelect.append(o);
      }

      const lowInput = document.createElement('input');
      lowInput.type = 'number';
      lowInput.step = 'any';
      lowInput.value = cp.m.refLow !== undefined ? String(cp.m.refLow) : '';
      lowInput.setAttribute('aria-label', ctx.t('entry.refLow'));

      const highInput = document.createElement('input');
      highInput.type = 'number';
      highInput.step = 'any';
      highInput.value = cp.m.refHigh !== undefined ? String(cp.m.refHigh) : '';
      highInput.setAttribute('aria-label', ctx.t('entry.refHigh'));

      const noteInput = document.createElement('input');
      noteInput.type = 'text';
      noteInput.value = cp.m.note ?? '';
      noteInput.setAttribute('aria-label', ctx.t('metric.detail.note'));

      const initialSource: SourceSelection = cp.m.sourceId
        ? { mode: 'existing', sourceId: cp.m.sourceId }
        : { mode: 'none' };
      const source = sourcePicker(ctx, {
        initial: initialSource,
        emptyMode: 'none',
        emptyLabel: ctx.t('source.none'),
        newLabel: `+ ${ctx.t('review.sourceNew')}…`,
        namePlaceholder: ctx.t('settings.sourceName'),
        nameAriaLabel: ctx.t('settings.sourceName'),
        kindAriaLabel: ctx.t('settings.sourceKind'),
        selectAriaLabel: ctx.t('metric.detail.source'),
      });

      const save = el('button', 'primary') as HTMLButtonElement;
      save.type = 'button';
      save.textContent = ctx.t('common.save');
      save.addEventListener('click', () => {
        const value = Number(valueInput.value);
        if (!Number.isFinite(value)) {
          ctx.toast(ctx.t('entry.invalidValue'), 'error');
          return;
        }
        const low = lowInput.value.trim() === '' ? undefined : Number(lowInput.value);
        const high = highInput.value.trim() === '' ? undefined : Number(highInput.value);
        const note = noteInput.value.trim();
        const { sourceId, newSource } = source.resolve();
        ctx.mutate((d) => {
          if (newSource && !d.sources.some((s) => s.id === newSource.id)) d.sources.push(newSource);
          const target = d.measurements.find((x) => x.id === cp.m.id);
          if (!target) return;
          target.value = value;
          target.unit = unitSelect.value;
          target.refLow = low !== undefined && Number.isFinite(low) ? low : undefined;
          target.refHigh = high !== undefined && Number.isFinite(high) ? high : undefined;
          target.note = note === '' ? undefined : note;
          target.sourceId = sourceId;
          target.status = 'corrected';
          target.modifiedAt = ctx.now();
        });
        editingId = undefined;
        rebuild();
      });

      const cancel = el('button') as HTMLButtonElement;
      cancel.type = 'button';
      cancel.textContent = ctx.t('common.cancel');
      cancel.addEventListener('click', () => {
        editingId = undefined;
        rebuildList();
      });

      form.append(
        field(ctx.t('metric.detail.value'), valueInput),
        field(ctx.t('metric.detail.unit'), unitSelect),
        field(ctx.t('entry.refLow'), lowInput),
        field(ctx.t('entry.refHigh'), highInput),
        field(ctx.t('metric.detail.note'), noteInput),
        field(ctx.t('metric.detail.source'), source.el),
      );
      const actions = el('div', 'metric-edit-actions');
      actions.append(save, cancel);
      form.append(actions);
      row.append(form);
      return row;
    }

    // --- Text (qualitative) measurements list ---------------------------
    function rebuildTextList(): void {
      listHost.replaceChildren();
      const heading = el('h2', 'metric-list-heading');
      heading.textContent = ctx.t('metric.detail.measurements');
      listHost.append(heading);

      const rows = seriesFor(ctx.data().measurements, metric.id);
      if (rows.length === 0) {
        const empty = el('p', 'muted');
        empty.textContent = ctx.t('metric.detail.noData');
        listHost.append(empty);
        return;
      }
      const list = el('div', 'card metric-list');
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const m = rows[i];
        const row = el('div', 'metric-row');
        const meta = el('div', 'metric-row-meta');
        const date = el('div', 'metric-row-date');
        date.textContent = formatDateTime(m.takenAt, m.timePrecision);
        meta.append(date);
        if (m.note) {
          const note = el('div', 'metric-row-source');
          note.textContent = m.note;
          meta.append(note);
        }
        const value = el('span', 'metric-row-value');
        value.textContent = measurementText(m) ?? '';
        const trailing = el('div', 'metric-row-trailing');
        trailing.append(value);
        row.append(meta, trailing);
        list.append(row);
      }
      listHost.append(list);
    }

    // --- Orchestration --------------------------------------------------
    function rebuild(): void {
      renderCurrentValue();
      if (isText) {
        rebuildTextList();
        return;
      }
      converted = convertedSeries();
      drawChart();
      renderStats();
      rebuildList();
    }

    renderPeriodControls();
    rebuild();

    // Track container width and re-render the chart responsively.
    let lastWidth = 0;
    const observer = new ResizeObserver(() => {
      const w = Math.round(chartHost.clientWidth);
      if (w > 0 && w !== lastWidth) {
        lastWidth = w;
        drawChart();
      }
    });
    observer.observe(chartHost);

    return () => observer.disconnect();
  },
};

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

function sourceName(ctx: AppContext, m: Measurement): string | undefined {
  if (!m.sourceId) return undefined;
  return ctx.data().sources.find((s) => s.id === m.sourceId)?.name;
}

/** A labelled field for the inline edit form. */
function field(text: string, input: HTMLElement): HTMLElement {
  const wrap = el('div', 'metric-edit-field');
  const label = el('label');
  label.textContent = text;
  wrap.append(label, input);
  return wrap;
}
