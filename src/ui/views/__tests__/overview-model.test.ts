import { describe, expect, it } from 'vitest';

import {
  buildOverviewCard,
  buildOverviewEntries,
  defaultLayout,
  filterOverviewEntries,
  formatRange,
  groupOverviewEntries,
  isOverviewFiltered,
  rangeBarPosition,
  resolveDisplayUnit,
  sparklinePath,
  subsetLabelSpec,
  type FilterableEntry,
} from '../overview-model';
import { WATCHED_TAG } from '../../../core/tags';
import { createUnitsEngine } from '../../../core/units';
import type {
  Measurement,
  MeasurementId,
  Metric,
  MetricId,
  Operator,
  ProfileId,
  ProfileSettings,
} from '../../../core/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const units = createUnitsEngine();
const NOW = '2026-07-21T12:00:00Z';

function metric(partial: Partial<Metric> & Pick<Metric, 'canonicalUnit' | 'units'>): Metric {
  return {
    id: 'builtin:test' as MetricId,
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
  precision: { 'mmol/L': 1, 'mg/dL': 0 },
  preferredUnitByLocale: { cs: 'mmol/L', en: 'mg/dL' },
});

let seq = 0;

function m(partial: {
  metricId?: MetricId;
  value: number;
  unit?: string;
  takenAt: string;
  operator?: Operator;
  refLow?: number;
  refHigh?: number;
}): Measurement {
  seq += 1;
  return {
    id: `meas-${seq}` as MeasurementId,
    profileId: 'p1' as ProfileId,
    metricId: partial.metricId ?? glucose.id,
    value: partial.value,
    operator: partial.operator,
    unit: partial.unit ?? 'mmol/L',
    takenAt: partial.takenAt,
    timePrecision: 'datetime',
    refLow: partial.refLow,
    refHigh: partial.refHigh,
    status: 'confirmed',
    origin: { pluginId: 'manual' },
    createdAt: partial.takenAt,
    modifiedAt: partial.takenAt,
  };
}

const emptySettings: ProfileSettings = {};

// ---------------------------------------------------------------------------
// resolveDisplayUnit
// ---------------------------------------------------------------------------

describe('resolveDisplayUnit', () => {
  it('falls back to the locale preference, then canonical', () => {
    expect(resolveDisplayUnit(glucose, emptySettings, 'en')).toBe('mg/dL');
    expect(resolveDisplayUnit(glucose, emptySettings, 'cs')).toBe('mmol/L');
    const noPref = metric({ canonicalUnit: 'mmol/L', units: ['mmol/L'] });
    expect(resolveDisplayUnit(noPref, emptySettings, 'en')).toBe('mmol/L');
  });

  it("'auto' unit system follows the locale (today's behavior)", () => {
    const settings: ProfileSettings = { unitSystem: 'auto' };
    expect(resolveDisplayUnit(glucose, settings, 'cs')).toBe('mmol/L');
    expect(resolveDisplayUnit(glucose, settings, 'en')).toBe('mg/dL');
  });

  it("'si' yields the SI unit regardless of locale", () => {
    const settings: ProfileSettings = { unitSystem: 'si' };
    expect(resolveDisplayUnit(glucose, settings, 'en')).toBe('mmol/L');
    expect(resolveDisplayUnit(glucose, settings, 'cs')).toBe('mmol/L');
  });

  it("'us' yields the US unit regardless of locale", () => {
    const settings: ProfileSettings = { unitSystem: 'us' };
    expect(resolveDisplayUnit(glucose, settings, 'cs')).toBe('mg/dL');
    expect(resolveDisplayUnit(glucose, settings, 'en')).toBe('mg/dL');
  });

  it('falls to canonical for a metric with no locale preference under si/us', () => {
    const tsh = metric({ canonicalUnit: 'mIU/L', units: ['mIU/L'] }); // no preferredUnitByLocale
    expect(resolveDisplayUnit(tsh, { unitSystem: 'si' }, 'en')).toBe('mIU/L');
    expect(resolveDisplayUnit(tsh, { unitSystem: 'us' }, 'cs')).toBe('mIU/L');
  });

  it('ignores a unit-system unit the metric does not support (→ canonical)', () => {
    // A metric whose seed preferences point at codes not in `units`: unusable,
    // so si/us both fall back to the canonical unit.
    const odd = metric({
      canonicalUnit: 'mmol/L',
      units: ['mmol/L'],
      preferredUnitByLocale: { cs: 'g/L', en: 'mg/dL' },
    });
    expect(resolveDisplayUnit(odd, { unitSystem: 'si' }, 'en')).toBe('mmol/L');
    expect(resolveDisplayUnit(odd, { unitSystem: 'us' }, 'cs')).toBe('mmol/L');
  });
});

// ---------------------------------------------------------------------------
// buildOverviewCard
// ---------------------------------------------------------------------------

describe('buildOverviewCard', () => {
  it('returns undefined when the metric has no measurements', () => {
    const card = buildOverviewCard(glucose, [], units, 'cs', 'mmol/L', NOW);
    expect(card).toBeUndefined();
  });

  it('reports the latest value and an upward delta in the display unit', () => {
    const data = [
      m({ value: 5.0, takenAt: '2026-07-01T08:00:00Z' }),
      m({ value: 5.6, takenAt: '2026-07-20T08:00:00Z' }),
    ];
    const card = buildOverviewCard(glucose, data, units, 'cs', 'mmol/L', NOW);
    expect(card).toBeDefined();
    expect(card!.value.value).toBeCloseTo(5.6, 5);
    expect(card!.value.unitCode).toBe('mmol/L');
    expect(card!.deltaKind).toBe('up');
    expect(card!.deltaAmount?.value).toBeCloseTo(0.6, 5);
    expect(card!.deltaAmount?.unitCode).toBe('mmol/L');
    expect(card!.ageDays).toBe(1); // 2026-07-20 -> 2026-07-21
    expect(card!.nameKey).toBe('metric.glucose');
  });

  it('reports a downward delta', () => {
    const data = [
      m({ value: 6.0, takenAt: '2026-07-01T08:00:00Z' }),
      m({ value: 5.4, takenAt: '2026-07-20T08:00:00Z' }),
    ];
    const card = buildOverviewCard(glucose, data, units, 'cs', 'mmol/L', NOW);
    expect(card!.deltaKind).toBe('down');
    expect(card!.deltaAmount?.value).toBeCloseTo(0.6, 5);
  });

  it('flags a value above its reference range', () => {
    const data = [m({ value: 7.5, takenAt: '2026-07-20T08:00:00Z', refLow: 3.9, refHigh: 5.6 })];
    const card = buildOverviewCard(glucose, data, units, 'cs', 'mmol/L', NOW);
    expect(card!.rangeState).toBe('above');
    expect(card!.outOfRange).toBe(true);
  });

  it('flags a value below its reference range', () => {
    const data = [m({ value: 3.0, takenAt: '2026-07-20T08:00:00Z', refLow: 3.9, refHigh: 5.6 })];
    const card = buildOverviewCard(glucose, data, units, 'cs', 'mmol/L', NOW);
    expect(card!.rangeState).toBe('below');
    expect(card!.outOfRange).toBe(true);
  });

  it('reports in-range values', () => {
    const data = [m({ value: 5.0, takenAt: '2026-07-20T08:00:00Z', refLow: 3.9, refHigh: 5.6 })];
    const card = buildOverviewCard(glucose, data, units, 'cs', 'mmol/L', NOW);
    expect(card!.rangeState).toBe('in-range');
    expect(card!.outOfRange).toBe(false);
  });

  it('reports unknown range when no bounds are present', () => {
    const data = [m({ value: 5.0, takenAt: '2026-07-20T08:00:00Z' })];
    const card = buildOverviewCard(glucose, data, units, 'cs', 'mmol/L', NOW);
    expect(card!.rangeState).toBe('unknown');
    expect(card!.outOfRange).toBe(false);
  });

  it('has no delta for a single measurement', () => {
    const data = [m({ value: 5.0, takenAt: '2026-07-20T08:00:00Z' })];
    const card = buildOverviewCard(glucose, data, units, 'cs', 'mmol/L', NOW);
    expect(card!.deltaKind).toBe('none');
    expect(card!.deltaAmount).toBeUndefined();
  });

  it('has no numeric delta when the latest value is censored by an operator', () => {
    const data = [
      m({ value: 0.5, takenAt: '2026-07-01T08:00:00Z' }),
      m({ value: 0.1, takenAt: '2026-07-20T08:00:00Z', operator: '<' }),
    ];
    const card = buildOverviewCard(glucose, data, units, 'cs', 'mmol/L', NOW);
    expect(card!.value.operator).toBe('<');
    expect(card!.deltaKind).toBe('none');
    expect(card!.deltaAmount).toBeUndefined();
  });

  it('reports "same" when the latest value is unchanged', () => {
    const data = [
      m({ value: 5.0, takenAt: '2026-07-01T08:00:00Z' }),
      m({ value: 5.0, takenAt: '2026-07-20T08:00:00Z' }),
    ];
    const card = buildOverviewCard(glucose, data, units, 'cs', 'mmol/L', NOW);
    expect(card!.deltaKind).toBe('same');
    expect(card!.deltaAmount).toBeUndefined();
  });

  it('converts the latest value to the requested display unit', () => {
    // 5 mmol/L glucose -> ~90.08 mg/dL, rounded to 0 decimals -> 90.
    const data = [m({ value: 5.0, unit: 'mmol/L', takenAt: '2026-07-20T08:00:00Z' })];
    const card = buildOverviewCard(glucose, data, units, 'en', 'mg/dL', NOW);
    expect(card!.value.unitCode).toBe('mg/dL');
    expect(card!.value.value).toBe(90);
  });

  it('computes the delta magnitude in the display unit for mixed source units', () => {
    // previous 90 mg/dL (=~4.997 mmol/L), latest 6 mmol/L; shown in mmol/L.
    const data = [
      m({ value: 90, unit: 'mg/dL', takenAt: '2026-07-01T08:00:00Z' }),
      m({ value: 6.0, unit: 'mmol/L', takenAt: '2026-07-20T08:00:00Z' }),
    ];
    const card = buildOverviewCard(glucose, data, units, 'cs', 'mmol/L', NOW);
    expect(card!.deltaKind).toBe('up');
    // 6 - (90 mg/dL in mmol/L ~= 4.9967) ~= 1.0, rounded to 1 decimal.
    expect(card!.deltaAmount?.unitCode).toBe('mmol/L');
    expect(card!.deltaAmount?.value).toBeCloseTo(1.0, 1);
  });

  it('falls back to the measurement unit when the display unit is not convertible', () => {
    const arb = metric({
      id: 'builtin:arb' as MetricId,
      canonicalUnit: 'mmol/L',
      units: ['mmol/L', 'kg'],
    });
    const data = [m({ metricId: arb.id, value: 5.0, unit: 'mmol/L', takenAt: '2026-07-20T08:00:00Z' })];
    const card = buildOverviewCard(arb, data, units, 'cs', 'kg', NOW);
    expect(card!.value.unitCode).toBe('mmol/L');
    expect(card!.value.value).toBeCloseTo(5.0, 5);
  });

  it('exposes the series and reference bounds in the effective display unit', () => {
    const data = [
      m({ value: 5.0, takenAt: '2026-07-01T08:00:00Z', refLow: 3.9, refHigh: 5.6 }),
      m({ value: 5.4, takenAt: '2026-07-20T08:00:00Z', refLow: 3.9, refHigh: 5.6 }),
    ];
    const card = buildOverviewCard(glucose, data, units, 'cs', 'mmol/L', NOW);
    expect(card!.series).toEqual([5.0, 5.4]);
    expect(card!.refLow).toBeCloseTo(3.9, 5);
    expect(card!.refHigh).toBeCloseTo(5.6, 5);
  });

  it('converts the series and reference bounds into the display unit', () => {
    const data = [m({ value: 5.0, unit: 'mmol/L', takenAt: '2026-07-20T08:00:00Z', refLow: 3.9, refHigh: 5.6 })];
    const card = buildOverviewCard(glucose, data, units, 'en', 'mg/dL', NOW);
    // 5 mmol/L -> ~90 mg/dL; bounds convert the same way.
    expect(card!.series[0]).toBeCloseTo(90.08, 1);
    expect(card!.refLow).toBeCloseTo(70.26, 1);
    expect(card!.refHigh).toBeCloseTo(100.89, 1);
  });

  it('leaves the reference bounds undefined when the measurement has none', () => {
    const data = [m({ value: 5.0, takenAt: '2026-07-20T08:00:00Z' })];
    const card = buildOverviewCard(glucose, data, units, 'cs', 'mmol/L', NOW);
    expect(card!.refLow).toBeUndefined();
    expect(card!.refHigh).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildOverviewEntries (time-travel snapshot entry set)
// ---------------------------------------------------------------------------

const weight = metric({
  id: 'builtin:weight' as MetricId,
  nameKey: 'metric.weight',
  canonicalUnit: 'kg',
  units: ['kg'],
});

describe('buildOverviewEntries', () => {
  // Glucose measured Jan + Jun; weight measured only in Jun.
  const data = [
    m({ value: 5.0, takenAt: '2026-01-01T08:00:00Z' }),
    m({ value: 6.0, takenAt: '2026-06-01T08:00:00Z' }),
    m({ metricId: weight.id, value: 80, unit: 'kg', takenAt: '2026-06-15T08:00:00Z' }),
  ];
  const metrics = [glucose, weight];

  it('live mode (no as-of): one defined entry per metric, in input order', () => {
    const entries = buildOverviewEntries(metrics, data, units, emptySettings, 'cs', NOW);
    expect(entries.map((e) => e.metric.id)).toEqual([glucose.id, weight.id]);
    expect(entries[0].model?.value.value).toBeCloseTo(6.0, 5); // latest glucose
    expect(entries[1].model?.value.value).toBeCloseTo(80, 5);
  });

  it('shows the value at/before the date and marks later-only metrics empty', () => {
    // As of 1 Mar: glucose = its Jan value; weight has no value yet → empty.
    const entries = buildOverviewEntries(
      metrics,
      data,
      units,
      emptySettings,
      'cs',
      '2026-03-01',
      '2026-03-01',
    );
    expect(entries.map((e) => e.metric.id)).toEqual([glucose.id, weight.id]);
    expect(entries[0].model).toBeDefined();
    expect(entries[0].model?.value.value).toBeCloseTo(5.0, 5); // Jan, not Jun
    expect(entries[1].model).toBeUndefined(); // weight empty at that date
  });

  it('is day-inclusive to 23:59:59 of the as-of day', () => {
    const sameDay = [m({ value: 4.2, takenAt: '2026-03-01T20:00:00Z' })];
    const entries = buildOverviewEntries(
      [glucose],
      sameDay,
      units,
      emptySettings,
      'cs',
      '2026-03-01',
      '2026-03-01',
    );
    expect(entries[0].model?.value.value).toBeCloseTo(4.2, 5);
  });

  it('marks a metric empty before its first measurement (kept, not dropped)', () => {
    const entries = buildOverviewEntries(
      metrics,
      data,
      units,
      emptySettings,
      'cs',
      '2025-12-31',
      '2025-12-31',
    );
    expect(entries.map((e) => e.metric.id)).toEqual([glucose.id, weight.id]);
    expect(entries[0].model).toBeUndefined();
    expect(entries[1].model).toBeUndefined();
  });

  it('omits metrics with no measurement at all', () => {
    const entries = buildOverviewEntries(metrics, [], units, emptySettings, 'cs', NOW);
    expect(entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// sparklinePath
// ---------------------------------------------------------------------------

describe('sparklinePath', () => {
  it('returns undefined for fewer than two points', () => {
    expect(sparklinePath([], 100, 36)).toBeUndefined();
    expect(sparklinePath([5], 100, 36)).toBeUndefined();
  });

  it('spreads points evenly across the width and inverts the y axis', () => {
    // Ascending values -> the last point is the highest (smallest y).
    const spark = sparklinePath([1, 2, 3], 100, 36, 4)!;
    expect(spark.points).toBe('4,32 50,18 96,4');
    expect(spark.last).toEqual({ x: 96, y: 4 });
  });

  it('centres a flat series vertically', () => {
    const spark = sparklinePath([7, 7, 7], 100, 36, 4)!;
    // innerH = 28, centred -> y = 4 + 14 = 18 for every point.
    expect(spark.points).toBe('4,18 50,18 96,18');
    expect(spark.last).toEqual({ x: 96, y: 18 });
  });
});

// ---------------------------------------------------------------------------
// rangeBarPosition
// ---------------------------------------------------------------------------

describe('rangeBarPosition', () => {
  it('returns undefined when there is no reference range', () => {
    expect(rangeBarPosition(5, undefined, undefined)).toBeUndefined();
  });

  it('centres a two-sided range (below 0–25%, above 75–100%)', () => {
    const bar = rangeBarPosition(5.6, 3.9, 5.6)!;
    expect(bar.zonePercents.belowEnd).toBe(25);
    expect(bar.zonePercents.aboveStart).toBe(75);
    // refHigh sits exactly at the above boundary.
    expect(bar.markerPercent).toBe(75);
  });

  it('places a mid-range value inside the in-range band', () => {
    const bar = rangeBarPosition(4.75, 3.9, 5.6)!;
    // Midpoint of the range -> centre of the track.
    expect(bar.markerPercent).toBe(50);
  });

  it('clamps a far out-of-range value to the track', () => {
    expect(rangeBarPosition(100, 3.9, 5.6)!.markerPercent).toBe(100);
    expect(rangeBarPosition(-100, 3.9, 5.6)!.markerPercent).toBe(0);
  });

  it('drops the below zone for an upper-only range and anchors refHigh at 75%', () => {
    const bar = rangeBarPosition(128, undefined, 140)!;
    expect(bar.zonePercents.belowEnd).toBe(0);
    expect(bar.zonePercents.aboveStart).toBe(75);
    // 128 / (140 / 0.75) = 68.6%
    expect(bar.markerPercent).toBeCloseTo(68.6, 1);
  });

  it('drops the above zone for a lower-only range and anchors refLow at 25%', () => {
    const bar = rangeBarPosition(50, 50, undefined)!;
    expect(bar.zonePercents.belowEnd).toBe(25);
    expect(bar.zonePercents.aboveStart).toBe(100);
    expect(bar.markerPercent).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// formatRange
// ---------------------------------------------------------------------------

describe('formatRange', () => {
  const fmt = (n: number): string => n.toFixed(1);
  const NBSP = ' '; // a one-sided range glues the operator to the number

  it('joins a two-sided range with an en-dash', () => {
    expect(formatRange(4, 5.8, fmt)).toBe('4.0–5.8');
  });

  it('renders a lower-only range as "≥ low"', () => {
    expect(formatRange(4, undefined, fmt)).toBe(`≥${NBSP}4.0`);
  });

  it('renders an upper-only range as "≤ high"', () => {
    expect(formatRange(undefined, 5.8, fmt)).toBe(`≤${NBSP}5.8`);
  });

  it('renders no bounds as an em-dash', () => {
    expect(formatRange(undefined, undefined, fmt)).toBe('—');
  });

  it('formats both bounds through the supplied formatter (unit conversion is the caller\'s job)', () => {
    // A formatter standing in for a different display unit: both bounds pass through it.
    const asMgdl = (n: number): string => `${Math.round(n * 18)}`;
    expect(formatRange(4, 5.8, asMgdl)).toBe('72–104');
  });
});

// ---------------------------------------------------------------------------
// Layout resolution + filtering / grouping
// ---------------------------------------------------------------------------

describe('defaultLayout', () => {
  it('is the card grid at every width (the list is an explicit opt-in)', () => {
    expect(defaultLayout()).toBe('grid');
  });
});

interface Row extends FilterableEntry {
  id: string;
}

const rows: Row[] = [
  { id: 'glucose', name: 'Glucose', tags: ['blood', 'diabetes'] },
  { id: 'hba1c', name: 'HbA1c', tags: ['blood', 'diabetes'] },
  { id: 'hemoglobin', name: 'Hemoglobin', tags: ['blood', 'cbc'] },
  { id: 'weight', name: 'Body weight', tags: ['vitals'] },
  { id: 'note', name: 'Urine colour', tags: [] },
];

describe('filterOverviewEntries', () => {
  it('matches all with an empty query and no tag', () => {
    expect(filterOverviewEntries(rows, { query: '', activeTag: undefined })).toEqual(rows);
  });

  it('filters by name, case- and diacritics-insensitively', () => {
    const out = filterOverviewEntries(rows, { query: 'glu', activeTag: undefined });
    expect(out.map((r) => r.id)).toEqual(['glucose']);
  });

  it('filters by tag', () => {
    const out = filterOverviewEntries(rows, { query: '', activeTag: 'diabetes' });
    expect(out.map((r) => r.id)).toEqual(['glucose', 'hba1c']);
  });

  it('combines query and tag', () => {
    const out = filterOverviewEntries(rows, { query: 'hb', activeTag: 'diabetes' });
    expect(out.map((r) => r.id)).toEqual(['hba1c']);
  });

  it('preserves the input order', () => {
    const out = filterOverviewEntries(rows, { query: '', activeTag: 'blood' });
    expect(out.map((r) => r.id)).toEqual(['glucose', 'hba1c', 'hemoglobin']);
  });

  it('handles a qualitative (empty-tag) entry by name', () => {
    const out = filterOverviewEntries(rows, { query: 'colour', activeTag: undefined });
    expect(out.map((r) => r.id)).toEqual(['note']);
  });

  it('the print subset is exactly the filtered set (same source of truth)', () => {
    const filter = { query: '', activeTag: 'diabetes' };
    const filtered = filterOverviewEntries(rows, filter);
    // What the overview would hand to the report is the ids of that same list.
    expect(filtered.map((r) => r.id)).toEqual(['glucose', 'hba1c']);
  });
});

describe('isOverviewFiltered', () => {
  it('is false with an empty query and no tag', () => {
    expect(isOverviewFiltered({ query: '', activeTag: undefined })).toBe(false);
    expect(isOverviewFiltered({ query: '   ', activeTag: undefined })).toBe(false);
  });

  it('is true with a query or a tag', () => {
    expect(isOverviewFiltered({ query: 'glu', activeTag: undefined })).toBe(true);
    expect(isOverviewFiltered({ query: '', activeTag: 'blood' })).toBe(true);
    expect(isOverviewFiltered({ query: 'glu', activeTag: 'blood' })).toBe(true);
  });
});

describe('subsetLabelSpec', () => {
  it('names a lone tag filter by that tag', () => {
    expect(subsetLabelSpec({ query: '', activeTag: 'diabetes' }, 2)).toEqual({
      kind: 'tag',
      tag: 'diabetes',
    });
  });

  it('falls back to a count for a text query (with or without a tag)', () => {
    expect(subsetLabelSpec({ query: 'glu', activeTag: undefined }, 1)).toEqual({
      kind: 'count',
      count: 1,
    });
    expect(subsetLabelSpec({ query: 'hb', activeTag: 'diabetes' }, 1)).toEqual({
      kind: 'count',
      count: 1,
    });
  });
});

describe('groupOverviewEntries', () => {
  it('groups by primary tag under the fixed group order when tags are on', () => {
    const groups = groupOverviewEntries(rows, { useTags: true, activeTag: undefined });
    // cbc precedes diabetes precedes vitals precedes other (fixed GROUP_ORDER).
    expect(groups.map((g) => g.tag)).toEqual(['cbc', 'diabetes', 'vitals', 'other']);
    const diabetes = groups.find((g) => g.tag === 'diabetes')!;
    expect(diabetes.entries.map((r) => r.id)).toEqual(['glucose', 'hba1c']);
  });

  it('returns a single flat block when a tag filter is active', () => {
    const filtered = filterOverviewEntries(rows, { query: '', activeTag: 'diabetes' });
    const groups = groupOverviewEntries(filtered, { useTags: true, activeTag: 'diabetes' });
    expect(groups).toHaveLength(1);
    expect(groups[0].tag).toBeNull();
    expect(groups[0].entries.map((r) => r.id)).toEqual(['glucose', 'hba1c']);
  });

  it('returns a single flat block when tags are off', () => {
    const groups = groupOverviewEntries(rows, { useTags: false, activeTag: undefined });
    expect(groups).toHaveLength(1);
    expect(groups[0].tag).toBeNull();
    expect(groups[0].entries.map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });

  describe('allTags', () => {
    const allTagRows: Row[] = [
      { id: 'chol', name: 'Cholesterol', tags: ['lipids', 'my-tag'] },
      { id: 'trig', name: 'Triglycerides', tags: ['my-tag'] },
      { id: 'note', name: 'Urine colour', tags: [] },
    ];

    it('buckets an entry under every tag it carries, ordered by orderTags', () => {
      const groups = groupOverviewEntries(allTagRows, {
        useTags: true,
        activeTag: undefined,
        allTags: true,
      });
      // lipids (GROUP_ORDER) precedes the custom "my-tag", which precedes "other".
      expect(groups.map((g) => g.tag)).toEqual(['lipids', 'my-tag', 'other']);
      // The multi-tag entry appears in BOTH the lipids and my-tag groups.
      expect(groups.find((g) => g.tag === 'lipids')!.entries.map((r) => r.id)).toEqual(['chol']);
      expect(groups.find((g) => g.tag === 'my-tag')!.entries.map((r) => r.id)).toEqual([
        'chol',
        'trig',
      ]);
      // An untagged entry lands in the "other" group.
      expect(groups.find((g) => g.tag === 'other')!.entries.map((r) => r.id)).toEqual(['note']);
    });

    it('falls back to a single primary group per entry when allTags is off', () => {
      const groups = groupOverviewEntries(allTagRows, {
        useTags: true,
        activeTag: undefined,
        allTags: false,
      });
      // Cholesterol appears only under its primary (panel) tag "lipids", not "my-tag".
      const lipids = groups.find((g) => g.tag === 'lipids')!;
      expect(lipids.entries.map((r) => r.id)).toEqual(['chol']);
      // Its custom tag is not promoted to its own section here.
      const myTag = groups.find((g) => g.tag === 'my-tag')!;
      expect(myTag.entries.map((r) => r.id)).toEqual(['trig']);
      // Every entry lands in exactly one group.
      const total = groups.reduce((n, g) => n + g.entries.length, 0);
      expect(total).toBe(allTagRows.length);
    });

    it('ignores allTags when a tag filter is active (single flat block)', () => {
      const groups = groupOverviewEntries(allTagRows, {
        useTags: true,
        activeTag: 'my-tag',
        allTags: true,
      });
      expect(groups).toHaveLength(1);
      expect(groups[0].tag).toBeNull();
    });
  });

  describe('watched group', () => {
    const watchedRows: Row[] = [
      { id: 'glucose', name: 'Glucose', tags: ['blood', 'diabetes', WATCHED_TAG] },
      { id: 'hba1c', name: 'HbA1c', tags: ['blood', 'diabetes'] },
      { id: 'chol', name: 'Cholesterol', tags: ['lipids', WATCHED_TAG] },
    ];

    it('surfaces a watched group FIRST holding all watched entries in primary mode', () => {
      const groups = groupOverviewEntries(watchedRows, { useTags: true, activeTag: undefined });
      expect(groups[0].tag).toBe(WATCHED_TAG);
      expect(groups[0].entries.map((r) => r.id)).toEqual(['glucose', 'chol']);
      // The watched entries STILL appear in their category groups.
      expect(groups.find((g) => g.tag === 'diabetes')!.entries.map((r) => r.id)).toEqual([
        'glucose',
        'hba1c',
      ]);
      expect(groups.find((g) => g.tag === 'lipids')!.entries.map((r) => r.id)).toEqual(['chol']);
      // Exactly one watched group.
      expect(groups.filter((g) => g.tag === WATCHED_TAG)).toHaveLength(1);
    });

    it('surfaces a single watched group FIRST in allTags mode too', () => {
      const groups = groupOverviewEntries(watchedRows, {
        useTags: true,
        activeTag: undefined,
        allTags: true,
      });
      expect(groups[0].tag).toBe(WATCHED_TAG);
      expect(groups[0].entries.map((r) => r.id)).toEqual(['glucose', 'chol']);
      expect(groups.filter((g) => g.tag === WATCHED_TAG)).toHaveLength(1);
      // Category groups still carry the watched metrics.
      expect(groups.find((g) => g.tag === 'lipids')!.entries.map((r) => r.id)).toEqual(['chol']);
    });

    it('adds no watched group when nothing is watched', () => {
      const groups = groupOverviewEntries(
        [{ id: 'hba1c', name: 'HbA1c', tags: ['blood', 'diabetes'] }],
        { useTags: true, activeTag: undefined },
      );
      expect(groups.some((g) => g.tag === WATCHED_TAG)).toBe(false);
    });

    it('has no watched group under an active tag filter (single flat block)', () => {
      const groups = groupOverviewEntries(watchedRows, {
        useTags: true,
        activeTag: 'diabetes',
      });
      expect(groups).toHaveLength(1);
      expect(groups[0].tag).toBeNull();
    });
  });
});
