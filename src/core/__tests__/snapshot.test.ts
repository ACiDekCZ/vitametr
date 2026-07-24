import { describe, expect, it } from 'vitest';

import { snapshotMeasurements } from '../snapshot.js';
import type {
  Measurement,
  MeasurementId,
  MetricId,
  ProfileId,
} from '../types.js';

function m(over: Partial<Measurement>): Measurement {
  return {
    id: 'a' as MeasurementId,
    profileId: 'p1' as ProfileId,
    metricId: 'builtin:glucose' as MetricId,
    value: 5,
    unit: 'mmol/L',
    takenAt: '2026-01-15',
    timePrecision: 'date',
    status: 'confirmed',
    origin: { pluginId: 'manual' },
    createdAt: '2026-01-15T00:00',
    modifiedAt: '2026-01-15T00:00',
    ...over,
  };
}

const GLUCOSE = 'builtin:glucose' as MetricId;
const CRP = 'builtin:crp' as MetricId;

describe('snapshotMeasurements', () => {
  it('picks the latest measurement at or before the as-of date (between two)', () => {
    const ms = [
      m({ id: 'a' as MeasurementId, takenAt: '2026-01-10', value: 4 }),
      m({ id: 'b' as MeasurementId, takenAt: '2026-02-01', value: 6 }),
    ];
    // As-of 2026-01-20 is between the two → the earlier (Jan 10) is the latest ≤ date.
    const snap = snapshotMeasurements(ms, [GLUCOSE], '2026-01-20');
    expect(snap).toHaveLength(1);
    expect(snap[0].id).toBe('a');
    expect(snap[0].value).toBe(4);
  });

  it('omits a metric whose first measurement is after the as-of date', () => {
    const ms = [m({ id: 'a' as MeasurementId, takenAt: '2026-02-01' })];
    expect(snapshotMeasurements(ms, [GLUCOSE], '2026-01-01')).toEqual([]);
  });

  it('is day-inclusive: a measurement anywhere on the as-of day qualifies (to 23:59:59)', () => {
    const ms = [
      m({ id: 'end' as MeasurementId, takenAt: '2026-07-23T23:59:59.000Z', value: 9 }),
      m({ id: 'next' as MeasurementId, takenAt: '2026-07-24T00:00:00.000Z', value: 10 }),
    ];
    const snap = snapshotMeasurements(ms, [GLUCOSE], '2026-07-23');
    expect(snap).toHaveLength(1);
    expect(snap[0].id).toBe('end');
  });

  it('excludes a measurement dated the day after the as-of date', () => {
    const ms = [m({ id: 'next' as MeasurementId, takenAt: '2026-07-24' })];
    expect(snapshotMeasurements(ms, [GLUCOSE], '2026-07-23')).toEqual([]);
  });

  it('returns nothing for a metric that has no measurements', () => {
    const ms = [m({ id: 'a' as MeasurementId, metricId: GLUCOSE, takenAt: '2026-01-10' })];
    expect(snapshotMeasurements(ms, [CRP], '2026-07-23')).toEqual([]);
  });

  it('resolves multiple metrics independently (one row each, mixed availability)', () => {
    const ms = [
      m({ id: 'g1' as MeasurementId, metricId: GLUCOSE, takenAt: '2026-01-10', value: 4 }),
      m({ id: 'g2' as MeasurementId, metricId: GLUCOSE, takenAt: '2026-03-10', value: 7 }),
      m({ id: 'c1' as MeasurementId, metricId: CRP, takenAt: '2026-02-10', value: 3, unit: 'mg/L' }),
      m({ id: 'c2' as MeasurementId, metricId: CRP, takenAt: '2026-06-10', value: 8, unit: 'mg/L' }),
    ];
    // As-of 2026-02-15: glucose latest is Jan 10 (Mar 10 is later), CRP latest is Feb 10.
    const snap = snapshotMeasurements(ms, [GLUCOSE, CRP], '2026-02-15');
    const byMetric = new Map(snap.map((s) => [s.metricId, s]));
    expect(byMetric.get(GLUCOSE)?.id).toBe('g1');
    expect(byMetric.get(CRP)?.id).toBe('c1');
    expect(snap).toHaveLength(2);
  });

  it('compares by time, not insertion order', () => {
    // Newer measurement inserted first; older second.
    const ms = [
      m({ id: 'new' as MeasurementId, takenAt: '2026-03-01', value: 8 }),
      m({ id: 'old' as MeasurementId, takenAt: '2026-01-01', value: 3 }),
    ];
    const snap = snapshotMeasurements(ms, [GLUCOSE], '2026-07-23');
    expect(snap[0].id).toBe('new');
  });

  it('defaults to every present metric when metricIds is omitted', () => {
    const ms = [
      m({ id: 'g' as MeasurementId, metricId: GLUCOSE, takenAt: '2026-01-10' }),
      m({ id: 'c' as MeasurementId, metricId: CRP, takenAt: '2026-01-10', unit: 'mg/L' }),
    ];
    const snap = snapshotMeasurements(ms, undefined, '2026-07-23');
    expect(new Set(snap.map((s) => s.metricId))).toEqual(new Set([GLUCOSE, CRP]));
  });
});
