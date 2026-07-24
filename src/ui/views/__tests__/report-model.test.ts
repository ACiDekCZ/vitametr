import { describe, expect, it } from 'vitest';
import { buildReport, composeReportTitle, STALE_DAYS } from '../report-model';
import { createCatalog } from '../../../core/catalog';
import { createUnitsEngine } from '../../../core/units';
import type { Measurement, MeasurementId, MetricId, ProfileData, ProfileId } from '../../../core/types';

const units = createUnitsEngine();
const NOW = '2026-01-15T00:00:00.000Z';

function measurement(
  m: Omit<Partial<Measurement>, 'metricId' | 'value' | 'takenAt'> & {
    metricId: string;
    value: number;
    takenAt: string;
  },
): Measurement {
  return {
    id: (m.id ?? `m-${Math.round(m.value * 1000)}-${m.takenAt}`) as MeasurementId,
    profileId: 'p' as ProfileId,
    metricId: m.metricId as MetricId,
    value: m.value,
    unit: m.unit ?? 'mmol/L',
    takenAt: m.takenAt,
    timePrecision: 'date',
    refLow: m.refLow,
    refHigh: m.refHigh,
    status: 'confirmed',
    origin: { pluginId: 'test' },
    createdAt: m.takenAt,
    modifiedAt: m.takenAt,
  };
}

function profile(measurements: Measurement[]): ProfileData {
  return {
    schemaVersion: 1,
    profile: { id: 'p' as ProfileId, name: 'Tester', createdAt: '2020-01-01T00:00:00Z' },
    metrics: [],
    sources: [],
    measurements,
    settings: {},
  };
}

describe('buildReport', () => {
  it('summarizes metrics into categories with latest value, delta and trend', () => {
    const data = profile([
      measurement({ metricId: 'builtin:glucose', value: 5.2, takenAt: '2025-06-01', refLow: 3.9, refHigh: 5.6 }),
      measurement({ metricId: 'builtin:glucose', value: 5.5, takenAt: '2025-12-01', refLow: 3.9, refHigh: 5.6 }),
    ]);
    // Czech locale → glucose displayed in mmol/L (its canonical/preferred unit).
    const model = buildReport(data, createCatalog(data), units, 'cs', NOW);

    expect(model.totalMetrics).toBe(1);
    expect(model.totalRecords).toBe(2);
    const lab = model.categories.find((c) => c.category === 'lab');
    expect(lab).toBeDefined();
    const row = lab!.rows.find((r) => r.metricId === ('builtin:glucose' as MetricId))!;
    expect(row.unit).toBe('mmol/L');
    expect(row.value).toBeCloseTo(5.5, 6);
    expect(row.rangeState).toBe('in-range');
    expect(row.deltaKind).toBe('up');
    expect(row.deltaAmount).toBeCloseTo(0.3, 6);
    expect(row.count).toBe(2);
  });

  it('flags an out-of-range latest value for attention', () => {
    const data = profile([
      measurement({ metricId: 'builtin:glucose', value: 7.0, takenAt: '2025-12-20', refLow: 3.9, refHigh: 5.6 }),
    ]);
    const model = buildReport(data, createCatalog(data), units, 'en', NOW);
    expect(model.categories[0].rows[0].rangeState).toBe('above');
    expect(model.attention.some((a) => a.reason === 'out-of-range')).toBe(true);
  });

  it('flags a long-unmeasured value as stale', () => {
    // ~400 days before NOW.
    const data = profile([
      measurement({ metricId: 'builtin:body-weight', value: 80, unit: 'kg', takenAt: '2024-12-01' }),
    ]);
    const model = buildReport(data, createCatalog(data), units, 'en', NOW);
    const stale = model.attention.find((a) => a.reason === 'stale');
    expect(stale).toBeDefined();
    expect(stale!.days).toBeGreaterThanOrEqual(STALE_DAYS);
  });

  it('is empty when there are no measurements', () => {
    const data = profile([]);
    const model = buildReport(data, createCatalog(data), units, 'en', NOW);
    expect(model.totalMetrics).toBe(0);
    expect(model.categories).toEqual([]);
    expect(model.attention).toEqual([]);
  });

  it('restricts the report to a metricId subset', () => {
    const data = profile([
      measurement({ metricId: 'builtin:glucose', value: 5.2, takenAt: '2025-12-01', refLow: 3.9, refHigh: 5.6 }),
      measurement({ metricId: 'builtin:hemoglobin', value: 140, unit: 'g/L', takenAt: '2025-12-01' }),
    ]);
    const catalog = createCatalog(data);
    const full = buildReport(data, catalog, units, 'cs', NOW);
    expect(full.totalMetrics).toBe(2);

    const subset = buildReport(data, catalog, units, 'cs', NOW, ['builtin:glucose' as MetricId]);
    expect(subset.totalMetrics).toBe(1);
    const allRows = subset.categories.flatMap((c) => c.rows);
    expect(allRows.map((r) => r.metricId)).toEqual(['builtin:glucose']);
  });

  it('an empty subset yields nothing', () => {
    const data = profile([
      measurement({ metricId: 'builtin:glucose', value: 5.2, takenAt: '2025-12-01' }),
    ]);
    const model = buildReport(data, createCatalog(data), units, 'cs', NOW, []);
    expect(model.totalMetrics).toBe(0);
    expect(model.categories).toEqual([]);
  });
});

describe('composeReportTitle', () => {
  it('appends a subset label with an em dash', () => {
    expect(composeReportTitle('Stav k 1. 1. 2025', 'Lipidy')).toBe('Stav k 1. 1. 2025 — Lipidy');
  });

  it('returns the base unchanged without a label', () => {
    expect(composeReportTitle('Zdravotní souhrn')).toBe('Zdravotní souhrn');
    expect(composeReportTitle('Zdravotní souhrn', undefined)).toBe('Zdravotní souhrn');
  });
});
