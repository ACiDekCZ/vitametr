/**
 * Correlation between two of the user's own metrics over time (pure).
 *
 * Pairs measurements of two metrics by calendar day (each day's latest value),
 * converts both to their canonical unit, and computes the Pearson correlation
 * coefficient. This is a DESCRIPTIVE statistic about the user's own recorded
 * data — an association, NOT causation and NOT medical advice (spec §11). The
 * UI must frame it that way.
 */

import type { UnitsEngine } from './contracts';
import type { Measurement, Metric } from './types';

export interface CorrelationPair {
  day: string; // YYYY-MM-DD
  a: number; // metric A value in its canonical unit
  b: number; // metric B value in its canonical unit
}

export type CorrelationStrength = 'none' | 'weak' | 'moderate' | 'strong';

export type CorrelationResult =
  | { ok: true; n: number; r: number; strength: CorrelationStrength; direction: 'positive' | 'negative'; pairs: CorrelationPair[] }
  | { ok: false; reason: 'insufficient-data'; n: number };

/** Minimum paired points for a meaningful coefficient. */
export const MIN_PAIRS = 3;

/** Latest canonical value per calendar day for one metric. */
function dailyCanonical(
  measurements: Measurement[],
  metric: Metric,
  units: UnitsEngine,
): Map<string, number> {
  const byDay = new Map<string, { takenAt: string; value: number }>();
  for (const m of measurements) {
    if (m.metricId !== metric.id) continue;
    if (m.operator !== undefined || m.value === undefined) continue; // censored / text excluded
    const conv = units.convert(m.value, m.unit, metric.canonicalUnit, metric);
    if (!conv.ok) continue;
    const day = m.takenAt.slice(0, 10);
    const prev = byDay.get(day);
    if (!prev || m.takenAt > prev.takenAt) byDay.set(day, { takenAt: m.takenAt, value: conv.value });
  }
  const out = new Map<string, number>();
  for (const [day, v] of byDay) out.set(day, v.value);
  return out;
}

/** Pair two metrics on days where both have a value. */
export function pairByDay(
  measurements: Measurement[],
  metricA: Metric,
  metricB: Metric,
  units: UnitsEngine,
): CorrelationPair[] {
  const a = dailyCanonical(measurements, metricA, units);
  const b = dailyCanonical(measurements, metricB, units);
  const pairs: CorrelationPair[] = [];
  for (const [day, av] of a) {
    const bv = b.get(day);
    if (bv !== undefined) pairs.push({ day, a: av, b: bv });
  }
  pairs.sort((x, y) => x.day.localeCompare(y.day));
  return pairs;
}

/** Pearson correlation coefficient; undefined when a series has zero variance. */
export function pearson(pairs: CorrelationPair[]): number | undefined {
  const n = pairs.length;
  if (n < 2) return undefined;
  let sa = 0;
  let sb = 0;
  for (const p of pairs) {
    sa += p.a;
    sb += p.b;
  }
  const ma = sa / n;
  const mb = sb / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (const p of pairs) {
    const da = p.a - ma;
    const db = p.b - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va === 0 || vb === 0) return undefined; // no variance → undefined
  return cov / Math.sqrt(va * vb);
}

function classify(r: number): CorrelationStrength {
  const abs = Math.abs(r);
  if (abs < 0.2) return 'none';
  if (abs < 0.4) return 'weak';
  if (abs < 0.7) return 'moderate';
  return 'strong';
}

/**
 * Correlate two metrics over the user's data. Returns a descriptive result or
 * an insufficient-data marker (fewer than {@link MIN_PAIRS} paired days, or no
 * variance).
 */
export function correlate(
  measurements: Measurement[],
  metricA: Metric,
  metricB: Metric,
  units: UnitsEngine,
): CorrelationResult {
  const pairs = pairByDay(measurements, metricA, metricB, units);
  if (pairs.length < MIN_PAIRS) {
    return { ok: false, reason: 'insufficient-data', n: pairs.length };
  }
  const r = pearson(pairs);
  if (r === undefined) {
    return { ok: false, reason: 'insufficient-data', n: pairs.length };
  }
  return {
    ok: true,
    n: pairs.length,
    r,
    strength: classify(r),
    direction: r >= 0 ? 'positive' : 'negative',
    pairs,
  };
}
