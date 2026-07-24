/**
 * Time series & trends (step K6b).
 *
 * Pure, dependency-free query functions over in-memory measurements. No DOM,
 * no storage, no clock: the caller supplies the current time as an ISO string
 * wherever "now" is needed (see `ageDays`). Every statement produced here is
 * strictly descriptive and data-backed — no thresholds, no medical claims
 * (architecture doc §11).
 *
 * Unit-aware comparisons (delta, trend) go through the injected `UnitsEngine`
 * so that molar/mass bridges and metric-specific conversions are honored; the
 * engine never guesses, and neither do these functions.
 */

import type { UnitsEngine } from './contracts.js';
import type { Measurement, Metric, MetricId, SourceId } from './types.js';

// ---------------------------------------------------------------------------
// Series selection
// ---------------------------------------------------------------------------

/**
 * All measurements of `metricId`, optionally clipped to an inclusive ISO date
 * range, sorted ascending by `takenAt`. Timestamps are compared as instants
 * (parsed), so differing time zones sort correctly.
 */
export function seriesFor(
  measurements: Measurement[],
  metricId: MetricId,
  opts?: { from?: string; to?: string },
): Measurement[] {
  const from = opts?.from !== undefined ? Date.parse(opts.from) : undefined;
  const to = opts?.to !== undefined ? Date.parse(opts.to) : undefined;

  return measurements
    .filter((m) => {
      if (m.metricId !== metricId) return false;
      if (from === undefined && to === undefined) return true;
      const t = Date.parse(m.takenAt);
      if (from !== undefined && t < from) return false;
      if (to !== undefined && t > to) return false;
      return true;
    })
    .sort((a, b) => Date.parse(a.takenAt) - Date.parse(b.takenAt));
}

/** Newest point of an ascending series (its last element). */
export function latest(series: Measurement[]): Measurement | undefined {
  return series.length > 0 ? series[series.length - 1] : undefined;
}

/** Second-newest point of an ascending series. */
export function previous(series: Measurement[]): Measurement | undefined {
  return series.length > 1 ? series[series.length - 2] : undefined;
}

// ---------------------------------------------------------------------------
// Delta
// ---------------------------------------------------------------------------

/**
 * Change of the latest point versus the previous one. The previous value is
 * converted into the latest point's unit before comparison, so mixed-unit
 * series still yield a meaningful delta when the metric permits conversion.
 *
 * A discriminated result: on success `{ ok: true, absolute, percent }`,
 * otherwise `{ ok: false, unavailable }` explaining the refusal:
 * - `insufficient-data` — fewer than two points;
 * - `operator`          — either point is censored (e.g. `< 0.1`), so no
 *                         single numeric delta is defensible;
 * - `not-convertible`   — the two units cannot be bridged for this metric.
 *
 * `percent` is the change relative to the (converted) previous value.
 */
export type DeltaResult =
  | { ok: true; absolute: number; percent: number }
  | { ok: false; unavailable: 'operator' | 'not-convertible' | 'insufficient-data' };

export function delta(series: Measurement[], units: UnitsEngine, metric: Metric): DeltaResult {
  const curr = latest(series);
  const prev = previous(series);
  if (curr === undefined || prev === undefined) {
    return { ok: false, unavailable: 'insufficient-data' };
  }
  if (curr.operator !== undefined || prev.operator !== undefined) {
    return { ok: false, unavailable: 'operator' };
  }
  if (curr.value === undefined || prev.value === undefined) {
    return { ok: false, unavailable: 'insufficient-data' };
  }

  const converted = units.convert(prev.value, prev.unit, curr.unit, metric);
  if (!converted.ok) {
    return { ok: false, unavailable: 'not-convertible' };
  }

  const prevValue = converted.value;
  const absolute = curr.value - prevValue;
  const percent =
    prevValue !== 0
      ? (absolute / prevValue) * 100
      : absolute === 0
        ? 0
        : absolute > 0
          ? Infinity
          : -Infinity;

  return { ok: true, absolute, percent };
}

// ---------------------------------------------------------------------------
// Reference-range position
// ---------------------------------------------------------------------------

/**
 * Position of a measurement relative to its OWN stated reference range (both
 * value and bounds are in the measurement's unit — no conversion involved).
 * `unknown` when neither bound is present. One-sided ranges are supported.
 */
/**
 * Display string of a qualitative measurement — the single text value, or the
 * comma-joined list for a 'multi' metric. Undefined for a numeric measurement.
 */
export function measurementText(m: {
  textValue?: string;
  textValues?: string[];
}): string | undefined {
  if (m.textValue !== undefined) return m.textValue;
  if (m.textValues !== undefined && m.textValues.length > 0) return m.textValues.join(', ');
  return undefined;
}

export function rangePosition(m: Measurement): 'below' | 'in-range' | 'above' | 'unknown' {
  if (m.value === undefined) return 'unknown'; // a text result has no numeric position
  if (m.refLow === undefined && m.refHigh === undefined) return 'unknown';
  if (m.refLow !== undefined && m.value < m.refLow) return 'below';
  if (m.refHigh !== undefined && m.value > m.refHigh) return 'above';
  return 'in-range';
}

// ---------------------------------------------------------------------------
// Age
// ---------------------------------------------------------------------------

/**
 * Whole days elapsed between a measurement's `takenAt` and the caller-supplied
 * current ISO instant (`nowIso`). The clock is never read here — the caller
 * owns "now". Negative if `takenAt` is in the future relative to `nowIso`.
 */
export function ageDays(m: Measurement, nowIso: string): number {
  const ms = Date.parse(nowIso) - Date.parse(m.takenAt);
  return Math.floor(ms / 86_400_000);
}

// ---------------------------------------------------------------------------
// Trend
// ---------------------------------------------------------------------------

/**
 * A purely descriptive shape of the series: `rising`, `falling`, `fluctuating`,
 * `flat`, or `insufficient` (< 2 usable points). Operator-carrying (censored)
 * points are ignored — they have no defensible numeric value. Values are
 * converted to the metric's canonical unit; points that cannot be converted are
 * dropped (the flag `mixedUnits` surfaces such situations to the UI separately).
 *
 * Method: a least-squares slope over (days-from-first, value) gives direction;
 * `flat` when the spread is negligible relative to the mean; `fluctuating` when
 * the net movement is small compared with the total up-and-down travel (a weak,
 * non-monotone signal). No thresholds carry any clinical meaning.
 */
export function trend(
  series: Measurement[],
  units: UnitsEngine,
  metric: Metric,
): 'rising' | 'falling' | 'fluctuating' | 'flat' | 'insufficient' {
  const points: { t: number; v: number }[] = [];
  for (const m of series) {
    if (m.operator !== undefined || m.value === undefined) continue;
    const conv = units.convert(m.value, m.unit, metric.canonicalUnit, metric);
    if (!conv.ok) continue;
    points.push({ t: Date.parse(m.takenAt), v: conv.value });
  }
  if (points.length < 2) return 'insufficient';

  const values = points.map((p) => p.v);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const spread = max - min;

  // Flat: no meaningful variation (both absolutely and relative to the mean).
  const flatEpsilon = Math.max(1e-9, Math.abs(mean) * 0.005);
  if (spread <= flatEpsilon) return 'flat';

  // Gross travel vs. net movement -> monotonicity / directionality.
  let gross = 0;
  for (let i = 1; i < values.length; i += 1) {
    gross += Math.abs(values[i] - values[i - 1]);
  }
  const net = values[values.length - 1] - values[0];
  const directionality = gross > 0 ? Math.abs(net) / gross : 0;
  if (directionality < 0.6) return 'fluctuating';

  // Least-squares slope for the direction. x is days from the first point;
  // fall back to the point index if every point shares a timestamp.
  const t0 = points[0].t;
  let xs = points.map((p) => (p.t - t0) / 86_400_000);
  if (xs.every((x) => x === xs[0])) {
    xs = points.map((_, i) => i);
  }
  const n = points.length;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = values.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((a, x, i) => a + x * values[i], 0);
  const sumXX = xs.reduce((a, x) => a + x * x, 0);
  const denom = n * sumXX - sumX * sumX;
  const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : net;

  return slope >= 0 ? 'rising' : 'falling';
}

// ---------------------------------------------------------------------------
// Timeline grouping
// ---------------------------------------------------------------------------

export interface EventGroup {
  /** Stable composite key: `${takenAt}|${sourceId ?? ''}`. */
  key: string;
  takenAt: string;
  sourceId?: SourceId;
  items: Measurement[];
}

/**
 * Group measurements into timeline events keyed by (takenAt + sourceId): the
 * same instant from the same source is one event (e.g. a single lab panel).
 * A missing source forms its own key. Sorted descending by time (newest first).
 */
export function groupByEvent(measurements: Measurement[]): EventGroup[] {
  const groups = new Map<string, EventGroup>();
  for (const m of measurements) {
    const key = `${m.takenAt}|${m.sourceId ?? ''}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { key, takenAt: m.takenAt, sourceId: m.sourceId, items: [] };
      groups.set(key, group);
    }
    group.items.push(m);
  }
  return [...groups.values()].sort((a, b) => Date.parse(b.takenAt) - Date.parse(a.takenAt));
}

// ---------------------------------------------------------------------------
// Unit-mixing flag
// ---------------------------------------------------------------------------

/** True when a series carries more than one distinct unit code. */
export function mixedUnits(series: Measurement[]): boolean {
  const seen = new Set<string>();
  for (const m of series) {
    seen.add(m.unit);
    if (seen.size > 1) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

/**
 * Clusters of likely duplicate records for one metric: identical metricId,
 * takenAt, value, and unit. Only clusters with two or more members are
 * returned; ordering follows first appearance. This flags candidates for the
 * UI to review — it never removes anything.
 */
export function duplicateCandidates(
  measurements: Measurement[],
  metricId: MetricId,
): Measurement[][] {
  const buckets = new Map<string, Measurement[]>();
  const order: string[] = [];
  for (const m of measurements) {
    if (m.metricId !== metricId) continue;
    const key = `${m.takenAt}|${m.value}|${m.unit}`;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = [];
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.push(m);
  }
  const clusters: Measurement[][] = [];
  for (const key of order) {
    const bucket = buckets.get(key);
    if (bucket !== undefined && bucket.length > 1) clusters.push(bucket);
  }
  return clusters;
}
