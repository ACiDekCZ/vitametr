/**
 * Compare-over-time screen (K8) — DOM-free view model.
 *
 * Pure functions that turn the profile's measurements plus a metric selection
 * and a period into the plain data shapes the compare view renders: the metrics
 * that actually have data, the shared time window across a selection, the
 * per-metric display-unit ChartPoints, and the ExportSelection for selective
 * export. No DOM, no i18n, no clock: the caller supplies "now" as an ISO string
 * (compare view uses ctx.now()) and all unit-aware work goes through the
 * injected UnitsEngine.
 */

import type { Catalog, ExportSelection, UnitsEngine } from '../../core/contracts';
import type { Measurement, Metric, MetricId } from '../../core/types';
import { seriesFor } from '../../core/series';
import type { ChartPoint } from '../chart-model';

/** Period filter, mirroring the metric-detail screen (3M / year / 5y / all). */
export type ComparePeriod = '3m' | 'all' | 'year' | '5y';

/** An inclusive `takenAt` window; `undefined` means "no bound" (all data). */
export type CompareRange = ExportSelection['range'];

/**
 * Inclusive `from` bound for a period, relative to `nowIso`. Returns
 * `undefined` for the "all" period (no lower bound). `new Date(nowIso)` parses
 * the caller-supplied instant — the wall clock is never read here.
 */
export function periodCutoff(period: ComparePeriod, nowIso: string): string | undefined {
  if (period === 'all') return undefined;
  const d = new Date(nowIso);
  if (period === '3m') d.setMonth(d.getMonth() - 3);
  else d.setFullYear(d.getFullYear() - (period === 'year' ? 1 : 5));
  return d.toISOString();
}

/** The `from`/`to` range for a period (only a lower bound is ever set). */
export function periodRange(period: ComparePeriod, nowIso: string): CompareRange {
  const from = periodCutoff(period, nowIso);
  return from !== undefined ? { from } : undefined;
}

/**
 * Metrics that have at least one measurement, in catalog order. These are the
 * only metrics offered for comparison (a metric with no data cannot be charted
 * or correlated).
 */
export function metricsWithData(measurements: Measurement[], catalog: Catalog): Metric[] {
  return catalog.all().filter((metric) => seriesFor(measurements, metric.id).length > 0);
}

/**
 * The smallest/largest measurement instant (ms) across ALL of `metricIds`
 * within `range`, or `undefined` when the selection has no data in the window.
 * This is the domain every small-multiple chart WOULD share so trends line up
 * by eye (see the view for the current charting limitation).
 */
export function sharedTimeDomain(
  measurements: Measurement[],
  metricIds: MetricId[],
  range: CompareRange,
): [number, number] | undefined {
  let min = Infinity;
  let max = -Infinity;
  for (const id of metricIds) {
    for (const m of seriesFor(measurements, id, { from: range?.from, to: range?.to })) {
      const t = Date.parse(m.takenAt);
      if (t < min) min = t;
      if (t > max) max = t;
    }
  }
  return Number.isFinite(min) ? [min, max] : undefined;
}

/**
 * ChartPoints for one metric over `range`, each value AND its reference bounds
 * converted into `displayUnit` (points that cannot be converted are dropped —
 * never charted in the wrong unit). Ascending by time (seriesFor sorts).
 */
export function buildComparePoints(
  metric: Metric,
  measurements: Measurement[],
  units: UnitsEngine,
  displayUnit: string,
  range: CompareRange,
): ChartPoint[] {
  const series = seriesFor(measurements, metric.id, { from: range?.from, to: range?.to });
  const points: ChartPoint[] = [];
  for (const m of series) {
    const conv = units.convertMeasurement(m, displayUnit, metric);
    if (!conv) continue;
    points.push({
      t: Date.parse(m.takenAt),
      value: conv.value,
      operator: m.operator,
      refLow: conv.refLow,
      refHigh: conv.refHigh,
    });
  }
  return points;
}

/**
 * Export selection for the current metric choice and period: the selected
 * metric ids and a `from` range for a bounded period (omitted for "all", so
 * the whole history is exported). The export plugins already honor this shape.
 */
export function buildExportSelection(
  metricIds: MetricId[],
  period: ComparePeriod,
  nowIso: string,
): ExportSelection {
  const range = periodRange(period, nowIso);
  return { metricIds: [...metricIds], range };
}
