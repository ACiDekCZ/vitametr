import { describe, expect, it } from 'vitest';

import {
  buildComparePoints,
  buildExportSelection,
  metricsWithData,
  periodCutoff,
  periodRange,
  sharedTimeDomain,
} from '../compare-model';
import { createUnitsEngine } from '../../../core/units';
import type { Catalog } from '../../../core/contracts';
import type {
  Measurement,
  MeasurementId,
  Metric,
  MetricId,
  ProfileId,
} from '../../../core/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const units = createUnitsEngine();
const NOW = '2026-07-21T12:00:00Z';

function metric(partial: Partial<Metric> & Pick<Metric, 'id' | 'canonicalUnit' | 'units'>): Metric {
  return {
    aliases: [],
    category: 'lab',
    valueType: 'number',
    ...partial,
  };
}

const glucose = metric({
  id: 'builtin:glucose' as MetricId,
  nameKey: 'metric.glucose',
  canonicalUnit: 'mmol/L',
  units: ['mmol/L', 'mg/dL'],
  molarMass: 180.16,
  preferredUnitByLocale: { cs: 'mmol/L', en: 'mg/dL' },
});

const weight = metric({
  id: 'builtin:weight' as MetricId,
  nameKey: 'metric.weight',
  canonicalUnit: 'kg',
  units: ['kg'],
});

const empty = metric({
  id: 'builtin:empty' as MetricId,
  nameKey: 'metric.empty',
  canonicalUnit: 'kg',
  units: ['kg'],
});

let seq = 0;
function m(partial: {
  metricId: MetricId;
  value: number;
  unit?: string;
  takenAt: string;
}): Measurement {
  seq += 1;
  return {
    id: `meas-${seq}` as MeasurementId,
    profileId: 'p1' as ProfileId,
    metricId: partial.metricId,
    value: partial.value,
    unit: partial.unit ?? 'mmol/L',
    takenAt: partial.takenAt,
    timePrecision: 'datetime',
    status: 'confirmed',
    origin: { pluginId: 'manual' },
    createdAt: partial.takenAt,
    modifiedAt: partial.takenAt,
  };
}

/** Minimal Catalog stub — metricsWithData only needs `all()`. */
function catalogOf(metrics: Metric[]): Catalog {
  return { all: () => metrics } as unknown as Catalog;
}

const measurements: Measurement[] = [
  m({ metricId: glucose.id, value: 5.0, unit: 'mmol/L', takenAt: '2020-01-01T08:00:00Z' }),
  m({ metricId: glucose.id, value: 5.6, unit: 'mmol/L', takenAt: '2026-01-10T08:00:00Z' }),
  m({ metricId: glucose.id, value: 6.0, unit: 'mmol/L', takenAt: '2026-07-01T08:00:00Z' }),
  m({ metricId: weight.id, value: 80, unit: 'kg', takenAt: '2026-03-15T08:00:00Z' }),
  m({ metricId: weight.id, value: 79, unit: 'kg', takenAt: '2026-07-05T08:00:00Z' }),
];

// ---------------------------------------------------------------------------
// metricsWithData
// ---------------------------------------------------------------------------

describe('metricsWithData', () => {
  it('keeps only metrics that have at least one measurement, in catalog order', () => {
    const catalog = catalogOf([glucose, empty, weight]);
    const result = metricsWithData(measurements, catalog);
    expect(result.map((x) => x.id)).toEqual([glucose.id, weight.id]);
  });

  it('returns nothing when no metric has data', () => {
    expect(metricsWithData([], catalogOf([glucose, weight]))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// periodCutoff / periodRange
// ---------------------------------------------------------------------------

describe('periodCutoff', () => {
  it('has no cutoff for "all"', () => {
    expect(periodCutoff('all', NOW)).toBeUndefined();
  });

  it('subtracts three months for "3m"', () => {
    expect(periodCutoff('3m', NOW)).toBe('2026-04-21T12:00:00.000Z');
  });

  it('subtracts one year for "year"', () => {
    expect(periodCutoff('year', NOW)).toBe('2025-07-21T12:00:00.000Z');
  });

  it('subtracts five years for "5y"', () => {
    expect(periodCutoff('5y', NOW)).toBe('2021-07-21T12:00:00.000Z');
  });

  it('periodRange wraps the cutoff as a from-bound (undefined for "all")', () => {
    expect(periodRange('all', NOW)).toBeUndefined();
    expect(periodRange('year', NOW)).toEqual({ from: '2025-07-21T12:00:00.000Z' });
  });
});

// ---------------------------------------------------------------------------
// sharedTimeDomain
// ---------------------------------------------------------------------------

describe('sharedTimeDomain', () => {
  it('spans the min/max instant across ALL selected metrics', () => {
    const domain = sharedTimeDomain(measurements, [glucose.id, weight.id], undefined);
    expect(domain).toEqual([
      Date.parse('2020-01-01T08:00:00Z'),
      Date.parse('2026-07-05T08:00:00Z'),
    ]);
  });

  it('respects the period range (drops points before the cutoff)', () => {
    const range = periodRange('year', NOW); // from 2025-07-21
    const domain = sharedTimeDomain(measurements, [glucose.id, weight.id], range);
    expect(domain).toEqual([
      Date.parse('2026-01-10T08:00:00Z'),
      Date.parse('2026-07-05T08:00:00Z'),
    ]);
  });

  it('is undefined when the selection has no data in the window', () => {
    expect(sharedTimeDomain(measurements, [empty.id], undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildComparePoints
// ---------------------------------------------------------------------------

describe('buildComparePoints', () => {
  it('returns ascending points converted to the display unit', () => {
    const points = buildComparePoints(glucose, measurements, units, 'mmol/L', undefined);
    expect(points.map((p) => p.value)).toEqual([5.0, 5.6, 6.0]);
    expect(points.map((p) => p.t)).toEqual([
      Date.parse('2020-01-01T08:00:00Z'),
      Date.parse('2026-01-10T08:00:00Z'),
      Date.parse('2026-07-01T08:00:00Z'),
    ]);
  });

  it('converts values into the chosen display unit', () => {
    // 5 mmol/L glucose -> ~90.08 mg/dL.
    const points = buildComparePoints(glucose, measurements, units, 'mg/dL', undefined);
    expect(points[0].value).toBeCloseTo(90.08, 1);
  });

  it('filters by the period range', () => {
    const range = periodRange('year', NOW);
    const points = buildComparePoints(glucose, measurements, units, 'mmol/L', range);
    expect(points.map((p) => p.value)).toEqual([5.6, 6.0]);
  });
});

// ---------------------------------------------------------------------------
// buildExportSelection
// ---------------------------------------------------------------------------

describe('buildExportSelection', () => {
  it('carries the selected metric ids and no range for "all"', () => {
    const sel = buildExportSelection([glucose.id, weight.id], 'all', NOW);
    expect(sel.metricIds).toEqual([glucose.id, weight.id]);
    expect(sel.range).toBeUndefined();
  });

  it('sets a from-range for a bounded period', () => {
    const sel = buildExportSelection([glucose.id], 'year', NOW);
    expect(sel.metricIds).toEqual([glucose.id]);
    expect(sel.range).toEqual({ from: '2025-07-21T12:00:00.000Z' });
  });

  it('copies the metric ids (not a live reference to the selection)', () => {
    const ids = [glucose.id];
    const sel = buildExportSelection(ids, 'all', NOW);
    ids.push(weight.id);
    expect(sel.metricIds).toEqual([glucose.id]);
  });
});
