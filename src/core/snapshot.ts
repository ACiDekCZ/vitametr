/**
 * As-of-date snapshot resolver (pure, DOM- and clock-free).
 *
 * A snapshot is the SINGLE latest measurement of each metric taken at or before
 * a reference date — the "state as of" view, as opposed to a range of all
 * measurements in a window. It is shared by the export "Stav k datu" mode, the
 * snapshot report and (later) the Overview time-travel: one resolver, one
 * definition of "latest known value at a date".
 *
 * The reference `asOfIso` is treated DAY-INCLUSIVE: a bare date `2026-07-23`
 * includes everything up to `2026-07-23T23:59:59.999`, so a measurement taken
 * anywhere on that calendar day still qualifies. Comparison is by parsed instant
 * (not insertion order); the day boundary is anchored to UTC so the result does
 * not depend on the runtime time zone. A metric with no measurement at/before the
 * date is OMITTED from the result.
 */

import type { Measurement, MetricId } from './types.js';

/**
 * Inclusive upper bound (ms) for the calendar day of `asOfIso`. The date part is
 * anchored to UTC end-of-day so bare-date measurements (parsed as UTC midnight)
 * compare consistently regardless of the runtime time zone. Returns NaN when the
 * date part is unparseable.
 */
export function endOfDayMs(asOfIso: string): number {
  const day = asOfIso.slice(0, 10);
  return Date.parse(`${day}T23:59:59.999Z`);
}

/**
 * For each metric in `metricIds` (or every metric present when `metricIds` is
 * omitted), the single latest measurement with `takenAt` at or before the end of
 * the `asOfIso` day. Metrics without any qualifying measurement are omitted.
 * Returns a flat list — one measurement per qualifying metric — in first-seen
 * metric order.
 */
export function snapshotMeasurements(
  measurements: readonly Measurement[],
  metricIds: readonly MetricId[] | undefined,
  asOfIso: string,
): Measurement[] {
  const cutoff = endOfDayMs(asOfIso);
  if (Number.isNaN(cutoff)) return [];
  const wanted = metricIds ? new Set(metricIds) : undefined;

  const best = new Map<MetricId, { m: Measurement; t: number }>();
  for (const m of measurements) {
    if (wanted && !wanted.has(m.metricId)) continue;
    const t = Date.parse(m.takenAt);
    if (Number.isNaN(t) || t > cutoff) continue;
    const cur = best.get(m.metricId);
    if (cur === undefined || t > cur.t) best.set(m.metricId, { m, t });
  }
  return [...best.values()].map((b) => b.m);
}
