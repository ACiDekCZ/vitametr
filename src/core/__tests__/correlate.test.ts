import { describe, expect, it } from 'vitest';
import { correlate, pairByDay, pearson, MIN_PAIRS } from '../correlate';
import { createUnitsEngine } from '../units';
import { createCatalog } from '../catalog';
import type { Measurement, MeasurementId, MetricId, ProfileData, ProfileId } from '../types';

const units = createUnitsEngine();
const catalog = createCatalog({
  schemaVersion: 1,
  profile: { id: 'p' as ProfileId, name: 'p', createdAt: '2020-01-01T00:00:00Z' },
  metrics: [],
  sources: [],
  measurements: [],
  settings: {},
});
const glucose = catalog.byKey('glucose')!;
const weight = catalog.byKey('body-weight')!;

let seq = 0;
function m(metricId: MetricId, value: number, unit: string, day: string): Measurement {
  return {
    id: `m${seq++}` as MeasurementId,
    profileId: 'p' as ProfileId,
    metricId,
    value,
    unit,
    takenAt: `${day}T08:00:00`,
    timePrecision: 'date',
    status: 'confirmed',
    origin: { pluginId: 'test' },
    createdAt: `${day}T08:00:00`,
    modifiedAt: `${day}T08:00:00`,
  };
}

describe('pearson', () => {
  it('is +1 for a perfect positive line', () => {
    const r = pearson([
      { day: 'd1', a: 1, b: 2 },
      { day: 'd2', a: 2, b: 4 },
      { day: 'd3', a: 3, b: 6 },
    ]);
    expect(r).toBeCloseTo(1, 6);
  });
  it('is -1 for a perfect negative line', () => {
    const r = pearson([
      { day: 'd1', a: 1, b: 6 },
      { day: 'd2', a: 2, b: 4 },
      { day: 'd3', a: 3, b: 2 },
    ]);
    expect(r).toBeCloseTo(-1, 6);
  });
  it('is undefined with no variance', () => {
    expect(pearson([{ day: 'd1', a: 5, b: 1 }, { day: 'd2', a: 5, b: 2 }])).toBeUndefined();
  });
});

describe('pairByDay', () => {
  it('pairs only days where both metrics have a value; takes the latest per day', () => {
    const measurements = [
      m(glucose.id, 5.0, 'mmol/L', '2025-01-01'),
      m(weight.id, 80, 'kg', '2025-01-01'),
      m(glucose.id, 5.5, 'mmol/L', '2025-02-01'), // no weight this day → dropped
      m(weight.id, 79, 'kg', '2025-03-01'), // no glucose this day → dropped
    ];
    const pairs = pairByDay(measurements, glucose, weight, units);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ day: '2025-01-01', a: 5.0, b: 80 });
  });

  it('converts to canonical units before pairing', () => {
    // glucose canonical is mmol/L; a mg/dL entry must convert.
    const measurements = [
      m(glucose.id, 90, 'mg/dL', '2025-01-01'), // 90/18.02 ≈ 4.995 mmol/L
      m(weight.id, 80, 'kg', '2025-01-01'),
    ];
    const pairs = pairByDay(measurements, glucose, weight, units);
    expect(pairs[0].a).toBeCloseTo(90 / 18.02, 2);
  });
});

describe('correlate', () => {
  it('reports insufficient data below the minimum pair count', () => {
    const measurements = [
      m(glucose.id, 5, 'mmol/L', '2025-01-01'),
      m(weight.id, 80, 'kg', '2025-01-01'),
    ];
    const res = correlate(measurements, glucose, weight, units);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.n).toBeLessThan(MIN_PAIRS);
  });

  it('computes a strong positive correlation', () => {
    const days = ['2025-01-01', '2025-02-01', '2025-03-01', '2025-04-01'];
    const measurements = days.flatMap((d, i) => [
      m(glucose.id, 5 + i * 0.5, 'mmol/L', d),
      m(weight.id, 80 + i * 2, 'kg', d),
    ]);
    const res = correlate(measurements, glucose, weight, units);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.r).toBeCloseTo(1, 6);
      expect(res.strength).toBe('strong');
      expect(res.direction).toBe('positive');
      expect(res.n).toBe(4);
    }
  });
});
