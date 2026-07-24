/**
 * Metric-detail summary model (pure layer) — no DOM, no clock, no i18n.
 *
 * Computes the minimum / average / maximum of a shown series. Values arrive
 * already expressed in the display unit (the view converts before calling), so
 * this function only aggregates numbers and never converts or rounds — the view
 * rounds for display via its unit helpers. Deterministic and unit-testable.
 */

export interface SeriesStats {
  min: number;
  avg: number;
  max: number;
}

/**
 * Min / mean / max over `values`. Non-finite entries (NaN, ±Infinity) are
 * ignored. Returns `undefined` when there is nothing finite to aggregate, so
 * callers can hide the summary cards for an empty series.
 */
export function seriesStats(values: readonly number[]): SeriesStats | undefined {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    n += 1;
  }
  if (n === 0) return undefined;
  return { min, avg: sum / n, max };
}
