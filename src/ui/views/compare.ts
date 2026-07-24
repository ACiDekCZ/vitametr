/**
 * Compare over time (K8) — DOM layer.
 *
 * Lets the user pick several metrics that have data, filter by period, see each
 * metric's values over time as a small-multiple chart with its long-term trend,
 * read the Pearson correlation for a chosen pair (a descriptive association in
 * the user's own data — never causation, never medical advice, spec §11), and
 * export exactly the selected metrics + period as JSON or CSV.
 *
 * All domain reasoning lives in `compare-model.ts` and the pure `correlate` /
 * `series` core; this module only turns that data into DOM and translates keys
 * through `ctx.t`. Values (and reference bounds) are converted into each
 * metric's display unit HERE before ChartPoints are built — the chart layers
 * never convert (spec §2).
 *
 * Shared x-axis: all selected metrics' small multiples use ONE aligned time
 * domain (`sharedTimeDomain` from compare-model, passed to buildChartModel via
 * ChartConfig.timeDomain), so trends and associations line up by eye.
 */

import type { AppContext, View } from '../app-context';
import type { StringKey } from '../../i18n/index';
import type { Metric, MetricId } from '../../core/types';
import { seriesFor, trend } from '../../core/series';
import { correlate } from '../../core/correlate';
import { buildChartModel, type ChartConfig } from '../chart-model';
import { renderChart } from '../chart';
import { resolveDisplayUnit } from './overview-model';
import { exportPluginById } from '../../plugins/registry';
import type { ExportContext } from '../../core/contracts';
import {
  buildComparePoints,
  buildExportSelection,
  metricsWithData,
  periodRange,
  sharedTimeDomain,
  type ComparePeriod,
} from './compare-model';
import '../chart.css';
import './compare.css';

const SMALL_CHART_HEIGHT = 160;
const SMALL_CHART_PADDING = { top: 14, right: 12, bottom: 24, left: 44 };

// Same option set and labels as the metric-detail screen (3M / Rok / 5 let /
// Vše), rendered with the shared segmented control so the two screens match.
const PERIOD_OPTIONS: readonly { id: ComparePeriod; labelKey: StringKey }[] = [
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

export const compareView: View = {
  render(container: HTMLElement, ctx: AppContext): void | (() => void) {
    const metrics = metricsWithData(ctx.data().measurements, ctx.catalog());
    const selected = new Set<MetricId>();
    let period: ComparePeriod = 'all';
    // Updated on each paint so the shared ResizeObserver redraws the current host.
    let chartsHost: HTMLElement = el('div');

    function paint(): void {
      container.replaceChildren();
      container.append(textEl('h1', ctx.t('compare.title')));

      if (metrics.length === 0) {
        container.append(textEl('p', ctx.t('compare.noData'), 'muted'));
        return;
      }

      container.append(renderMetricPicker());
      container.append(renderPeriod());

      chartsHost = el('div', 'compare-charts');
      container.append(chartsHost);
      drawCharts();

      container.append(renderCorrelation());
      container.append(renderExport());
    }

    // --- Metric multi-select -------------------------------------------
    function renderMetricPicker(): HTMLElement {
      const section = el('section', 'compare-section');
      section.append(textEl('h2', ctx.t('compare.selectMetrics')));
      section.append(textEl('p', ctx.t('compare.pickHint'), 'muted compare-hint'));

      // Toggle CHIPs (same style as the timeline filters): active = dark pill,
      // inactive = surface pill with shadow. The chip's visible/accessible text
      // is exactly the metric name so it stays reachable by name.
      const list = el('div', 'compare-metric-list');
      list.setAttribute('role', 'group');
      list.setAttribute('aria-label', ctx.t('compare.selectMetrics'));
      for (const metric of metrics) {
        const on = selected.has(metric.id);
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = on ? 'chip is-active' : 'chip';
        chip.textContent = metricName(ctx, metric);
        chip.setAttribute('aria-pressed', String(on));
        chip.addEventListener('click', () => {
          if (selected.has(metric.id)) selected.delete(metric.id);
          else selected.add(metric.id);
          paint();
        });
        list.append(chip);
      }
      section.append(list);
      return section;
    }

    // --- Period filter --------------------------------------------------
    function renderPeriod(): HTMLElement {
      const section = el('section', 'compare-section');
      const label = el('label', 'compare-period-label');
      label.textContent = ctx.t('compare.period');
      section.append(label);

      const group = el('div', 'seg');
      for (const opt of PERIOD_OPTIONS) {
        const active = opt.id === period;
        const b = el('button', active ? 'seg-btn seg-btn--active' : 'seg-btn') as HTMLButtonElement;
        b.type = 'button';
        b.textContent = ctx.t(opt.labelKey);
        b.setAttribute('aria-pressed', String(active));
        b.addEventListener('click', () => {
          period = opt.id;
          paint();
        });
        group.append(b);
      }
      section.append(group);
      return section;
    }

    // --- Small-multiple charts -----------------------------------------
    function drawCharts(): void {
      chartsHost.replaceChildren();
      const chosen = metrics.filter((m) => selected.has(m.id));
      if (chosen.length === 0) {
        chartsHost.append(textEl('p', ctx.t('compare.pickHint'), 'muted'));
        return;
      }

      const data = ctx.data();
      const range = periodRange(period, ctx.now());
      const width = Math.max(240, Math.round(chartsHost.clientWidth) || 320);
      // One shared time axis across all selected metrics so the small multiples
      // line up and trends/associations are visible by eye.
      const timeDomain = sharedTimeDomain(
        data.measurements,
        chosen.map((m) => m.id),
        range,
      );

      for (const metric of chosen) {
        const displayUnit = resolveDisplayUnit(metric, data.settings, ctx.locale);
        const points = buildComparePoints(metric, data.measurements, ctx.units, displayUnit, range);

        const card = el('div', 'card compare-chart-card');

        const header = el('div', 'compare-chart-header');
        header.append(textEl('span', metricName(ctx, metric), 'compare-chart-name'));
        const series = seriesFor(data.measurements, metric.id, { from: range?.from, to: range?.to });
        const tr = trend(series, ctx.units, metric);
        if (tr !== 'insufficient') {
          header.append(textEl('span', ctx.t(TREND_KEY[tr]), 'compare-chart-trend muted'));
        }
        card.append(header);

        const host = el('div', 'compare-chart');
        card.append(host);
        chartsHost.append(card);

        const config: ChartConfig = {
          width,
          height: SMALL_CHART_HEIGHT,
          padding: SMALL_CHART_PADDING,
          unitLabel: unitDisplay(ctx, displayUnit),
          ...(timeDomain ? { timeDomain } : {}),
        };
        const model = buildChartModel(points, config);
        renderChart(host, model, {
          ariaLabel: `${metricName(ctx, metric)}, ${ctx.t('timeline.valuesCount', { count: points.length })}`,
        });
      }
    }

    // --- Correlation ----------------------------------------------------
    function renderCorrelation(): HTMLElement {
      const section = el('section', 'compare-section');
      section.append(textEl('h2', ctx.t('compare.correlation')));

      const chosen = metrics.filter((m) => selected.has(m.id));
      if (chosen.length < 2) {
        section.append(textEl('p', ctx.t('compare.needTwo'), 'muted'));
        return section;
      }
      if (chosen.length !== 2) {
        // Correlation is a pairwise statistic; ask the user to narrow to two.
        section.append(textEl('p', ctx.t('compare.needTwo'), 'muted'));
        return section;
      }

      const [a, b] = chosen;
      const nameA = metricName(ctx, a);
      const nameB = metricName(ctx, b);
      section.append(
        textEl('p', ctx.t('compare.correlationOf', { a: nameA, b: nameB }), 'compare-corr-of'),
      );

      const range = periodRange(period, ctx.now());
      const measurements = seriesInRange(ctx, range, [a.id, b.id]);
      const result = correlate(measurements, a, b, ctx.units);

      if (result.ok) {
        const strengthText =
          result.strength === 'none'
            ? ctx.t(`compare.strength.${result.strength}` as StringKey)
            : `${ctx.t(`compare.strength.${result.strength}` as StringKey)}, ${ctx.t(`compare.direction.${result.direction}` as StringKey)}`;
        section.append(
          textEl(
            'p',
            ctx.t('compare.correlationValue', {
              r: result.r.toFixed(2),
              strength: strengthText,
              n: result.n,
            }),
            'compare-corr-value',
          ),
        );
      } else {
        section.append(textEl('p', ctx.t('compare.correlationInsufficient'), 'muted'));
      }

      // Always framed: an association in the user's own data — not causation.
      section.append(textEl('p', ctx.t('compare.correlationHint'), 'muted compare-corr-hint'));
      return section;
    }

    // --- Selective export ----------------------------------------------
    function renderExport(): HTMLElement {
      const section = el('section', 'compare-section');
      section.append(textEl('h2', ctx.t('compare.export')));

      const disabled = selected.size === 0;

      const row = el('div', 'compare-export-actions');

      // The optional backup password is asked for at export time (never stored
      // or shown as a standing field): the JSON button opens an inline prompt.
      const pwHost = el('div');

      const jsonBtn = el('button', 'primary') as HTMLButtonElement;
      jsonBtn.type = 'button';
      jsonBtn.textContent = ctx.t('compare.exportJson');
      jsonBtn.disabled = disabled;
      jsonBtn.addEventListener('click', () => renderExportPasswordPrompt(pwHost));

      const csvBtn = el('button') as HTMLButtonElement;
      csvBtn.type = 'button';
      csvBtn.textContent = ctx.t('compare.exportCsv');
      csvBtn.disabled = disabled;
      csvBtn.addEventListener('click', () => void runExport('csv'));

      row.append(jsonBtn, csvBtn);
      section.append(row, pwHost);
      return section;
    }

    /**
     * Inline prompt asking (at export time) for an optional password to encrypt
     * the JSON backup — never stored or kept as a standing field. Empty = plain.
     */
    function renderExportPasswordPrompt(host: HTMLElement): void {
      host.replaceChildren();
      const box = el('div', 'compare-export-prompt');
      box.append(textEl('p', ctx.t('backup.passwordHint'), 'muted'));

      const pwField = el('div', 'field');
      const pwLabel = el('label');
      pwLabel.textContent = ctx.t('backup.password');
      const pwInput = document.createElement('input');
      pwInput.type = 'password';
      pwInput.setAttribute('aria-label', ctx.t('backup.password'));
      pwField.append(pwLabel, pwInput);

      const actions = el('div', 'compare-export-actions');
      const cancel = el('button') as HTMLButtonElement;
      cancel.type = 'button';
      cancel.textContent = ctx.t('common.cancel');
      cancel.addEventListener('click', () => host.replaceChildren());
      const confirm = el('button', 'primary') as HTMLButtonElement;
      confirm.type = 'button';
      confirm.textContent = ctx.t('settings.export');
      confirm.addEventListener('click', () => {
        const password = pwInput.value.trim() || undefined;
        host.replaceChildren();
        void runExport('json-backup', password);
      });
      actions.append(cancel, confirm);
      box.append(pwField, actions);
      host.append(box);
    }

    async function runExport(
      pluginId: 'json-backup' | 'csv',
      password?: string,
    ): Promise<void> {
      const plugin = exportPluginById(pluginId);
      if (!plugin || selected.size === 0) return;
      const selection = buildExportSelection([...selected], period, ctx.now());
      if (password) selection.password = password;
      const exportCtx: ExportContext = {
        data: ctx.data(),
        catalog: ctx.catalog(),
        units: ctx.units,
        locale: ctx.locale,
      };
      const blob = await plugin.export(selection, exportCtx);
      downloadBlob(blob, `vitametr-selected.${plugin.fileExtension}`);
    }

    paint();

    // Responsive redraw of the small multiples on container width changes.
    let lastWidth = 0;
    const observer = new ResizeObserver(() => {
      const w = Math.round(chartsHost.clientWidth);
      if (w > 0 && w !== lastWidth) {
        lastWidth = w;
        drawCharts();
      }
    });
    observer.observe(container);

    return () => observer.disconnect();
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Measurements of the given metrics within a period (for correlation). */
function seriesInRange(
  ctx: AppContext,
  range: ReturnType<typeof periodRange>,
  metricIds: MetricId[],
) {
  const out = [];
  for (const id of metricIds) {
    out.push(...seriesFor(ctx.data().measurements, id, { from: range?.from, to: range?.to }));
  }
  return out;
}

function metricName(ctx: AppContext, metric: Metric): string {
  if (metric.customName) return metric.customName;
  if (metric.nameKey) return ctx.t(metric.nameKey as StringKey);
  return metric.key ?? '';
}

function unitDisplay(ctx: AppContext, code: string): string {
  return ctx.units.getUnit(code)?.display ?? code;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

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
