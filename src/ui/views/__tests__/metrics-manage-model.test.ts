import { describe, expect, it } from 'vitest';

import {
  applyMetricHidden,
  applyMetricRemoval,
  buildUserMetricSpec,
  isBuiltinMetric,
  isCustomMetric,
  isMetricRemovable,
  matchesQuery,
  measurementCounts,
  metricMeta,
  metricUsageCount,
  selectMetrics,
} from '../metrics-manage-model';
import type { Metric, MetricCategory, MetricId, ProfileData, ProfileId } from '../../../core/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function metric(
  id: string,
  category: MetricCategory,
  extra: Partial<Metric> = {},
): Metric {
  return {
    id: id as MetricId,
    aliases: [],
    category,
    valueType: 'number',
    canonicalUnit: 'mmol/L',
    units: ['mmol/L'],
    ...extra,
  };
}

const GLUCOSE = metric('builtin:glucose', 'lab', {
  key: 'glucose',
  nameKey: 'metric.glucose',
  aliases: ['Glykémie', 'Cukr'],
});
const WEIGHT = metric('builtin:body-weight', 'home', { key: 'body-weight' });
const STEPS = metric('user:1', 'wearable', { customName: 'Kroky', canonicalUnit: '', units: [] });

const displayName = (m: Metric): string => m.customName ?? m.key ?? m.id;

// ---------------------------------------------------------------------------
// isCustomMetric
// ---------------------------------------------------------------------------

describe('isCustomMetric', () => {
  it('is true only for metrics with a custom name', () => {
    expect(isCustomMetric(STEPS)).toBe(true);
    expect(isCustomMetric(GLUCOSE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// measurementCounts
// ---------------------------------------------------------------------------

describe('measurementCounts', () => {
  it('tallies measurements per metric id', () => {
    const counts = measurementCounts([
      { metricId: 'builtin:glucose' as MetricId },
      { metricId: 'builtin:glucose' as MetricId },
      { metricId: 'user:1' as MetricId },
    ]);
    expect(counts.get('builtin:glucose' as MetricId)).toBe(2);
    expect(counts.get('user:1' as MetricId)).toBe(1);
    expect(counts.get('builtin:body-weight' as MetricId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// matchesQuery
// ---------------------------------------------------------------------------

describe('matchesQuery', () => {
  it('matches an empty query against everything', () => {
    expect(matchesQuery(WEIGHT, '', displayName)).toBe(true);
  });

  it('matches across key and aliases, case- and diacritics-insensitive', () => {
    expect(matchesQuery(GLUCOSE, 'gluc')).toBe(true);
    expect(matchesQuery(GLUCOSE, 'glykemie')).toBe(true); // folds "Glykémie"
    expect(matchesQuery(GLUCOSE, 'CUKR')).toBe(true);
    expect(matchesQuery(GLUCOSE, 'weight')).toBe(false);
  });

  it('can also match the resolved display name', () => {
    expect(matchesQuery(STEPS, 'kroky', displayName)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// selectMetrics
// ---------------------------------------------------------------------------

describe('selectMetrics', () => {
  const metrics = [GLUCOSE, WEIGHT, STEPS];
  const counts = measurementCounts([
    { metricId: GLUCOSE.id },
    { metricId: STEPS.id },
  ]);

  it('"used" keeps only metrics with measurements', () => {
    const out = selectMetrics({ metrics, filter: 'used', query: '', counts, nameOf: displayName });
    expect(out.map((m) => m.id)).toEqual([GLUCOSE.id, STEPS.id]);
  });

  it('"all" keeps everything, in catalog order', () => {
    const out = selectMetrics({ metrics, filter: 'all', query: '', counts, nameOf: displayName });
    expect(out.map((m) => m.id)).toEqual([GLUCOSE.id, WEIGHT.id, STEPS.id]);
  });

  it('"custom" keeps only user-created metrics', () => {
    const out = selectMetrics({ metrics, filter: 'custom', query: '', counts, nameOf: displayName });
    expect(out.map((m) => m.id)).toEqual([STEPS.id]);
  });

  it('combines the filter with the search query', () => {
    const out = selectMetrics({
      metrics,
      filter: 'all',
      query: 'cukr',
      counts,
      nameOf: displayName,
    });
    expect(out.map((m) => m.id)).toEqual([GLUCOSE.id]);
  });

  it('narrows to a tag when one is given, combined with the rest', () => {
    const tagged = [
      metric('builtin:glucose', 'lab', { key: 'glucose', tags: ['blood', 'diabetes'] }),
      metric('builtin:creatinine', 'lab', { key: 'creatinine', tags: ['blood', 'kidney'] }),
      metric('builtin:body-weight', 'home', { key: 'body-weight', tags: ['vitals'] }),
    ];
    const emptyCounts = measurementCounts([]);
    const out = selectMetrics({
      metrics: tagged,
      filter: 'all',
      query: '',
      counts: emptyCounts,
      tag: 'blood',
    });
    expect(out.map((m) => m.key)).toEqual(['glucose', 'creatinine']);

    const kidney = selectMetrics({
      metrics: tagged,
      filter: 'all',
      query: '',
      counts: emptyCounts,
      tag: 'kidney',
    });
    expect(kidney.map((m) => m.key)).toEqual(['creatinine']);
  });
});

// ---------------------------------------------------------------------------
// metricMeta
// ---------------------------------------------------------------------------

describe('metricMeta', () => {
  it('reports "none" when there are no measurements', () => {
    expect(metricMeta(GLUCOSE, 0)).toEqual({ kind: 'none' });
  });

  it('reports the unit and count when measured', () => {
    expect(metricMeta(GLUCOSE, 3)).toEqual({ kind: 'counted', unit: 'mmol/L', count: 3 });
  });

  it('omits the unit for a unitless (qualitative) metric', () => {
    expect(metricMeta(STEPS, 2)).toEqual({ kind: 'counted', unit: undefined, count: 2 });
  });
});

// ---------------------------------------------------------------------------
// buildUserMetricSpec
// ---------------------------------------------------------------------------

describe('buildUserMetricSpec', () => {
  it('returns undefined for a blank name', () => {
    expect(buildUserMetricSpec({ name: '   ', valueType: 'number' })).toBeUndefined();
  });

  it('builds a number metric with its unit and the name as first alias', () => {
    const spec = buildUserMetricSpec({
      name: 'Resting HR',
      valueType: 'number',
      unit: 'bpm',
      aliases: 'RHR, pulse',
    });
    expect(spec).toEqual({
      customName: 'Resting HR',
      aliases: ['Resting HR', 'RHR', 'pulse'],
      category: 'custom',
      valueType: 'number',
      canonicalUnit: 'bpm',
      units: ['bpm'],
    });
  });

  it('builds a number metric with no unit when none is given', () => {
    const spec = buildUserMetricSpec({ name: 'Score', valueType: 'number' });
    expect(spec?.canonicalUnit).toBe('');
    expect(spec?.units).toEqual([]);
  });

  it('builds a text metric with no unit', () => {
    const spec = buildUserMetricSpec({ name: 'Mood note', valueType: 'text' });
    expect(spec).toMatchObject({ valueType: 'text', canonicalUnit: '', units: [] });
    expect(spec).not.toHaveProperty('enumValues');
  });

  it('builds an enum metric with its allowed values', () => {
    const spec = buildUserMetricSpec({
      name: 'Result',
      valueType: 'enum',
      enumValues: 'Negative, Positive',
    });
    expect(spec).toMatchObject({
      valueType: 'enum',
      enumValues: ['Negative', 'Positive'],
      canonicalUnit: '',
      units: [],
    });
  });

  it('attaches trimmed tags, dropping empties', () => {
    const spec = buildUserMetricSpec({
      name: 'Ferritin',
      valueType: 'number',
      tags: ' iron ,, blood ',
    });
    expect(spec?.tags).toEqual(['iron', 'blood']);
  });

  it('omits tags entirely when the field is blank', () => {
    const spec = buildUserMetricSpec({ name: 'Score', valueType: 'number', tags: '  ,  ' });
    expect(spec).not.toHaveProperty('tags');
  });

  it('keeps a valid LOINC and ignores an invalid one', () => {
    const valid = buildUserMetricSpec({ name: 'Glucose', valueType: 'number', loinc: '2345-7' });
    expect(valid?.externalCodes).toEqual({ loinc: '2345-7' });

    const invalid = buildUserMetricSpec({
      name: 'Glucose',
      valueType: 'number',
      loinc: 'not-a-loinc',
    });
    expect(invalid).not.toHaveProperty('externalCodes');
  });

  it('keeps a generic code pair only when both system and code are set', () => {
    const both = buildUserMetricSpec({
      name: 'Glucose',
      valueType: 'number',
      codeSystem: 'ACME',
      codeValue: '03123',
    });
    expect(both?.externalCodes).toEqual({ other: [{ system: 'ACME', code: '03123' }] });

    const systemOnly = buildUserMetricSpec({
      name: 'Glucose',
      valueType: 'number',
      codeSystem: 'ACME',
    });
    expect(systemOnly).not.toHaveProperty('externalCodes');
  });

  it('combines a valid LOINC and a generic pair into one externalCodes block', () => {
    const spec = buildUserMetricSpec({
      name: 'Glucose',
      valueType: 'number',
      loinc: '2345-7',
      codeSystem: 'ACME',
      codeValue: '03123',
    });
    expect(spec?.externalCodes).toEqual({
      loinc: '2345-7',
      other: [{ system: 'ACME', code: '03123' }],
    });
  });

  it('omits externalCodes when no codes are provided', () => {
    const spec = buildUserMetricSpec({ name: 'Score', valueType: 'number' });
    expect(spec).not.toHaveProperty('externalCodes');
  });

  // The chip editors (shared with the detail) hand the model already-split
  // LISTS instead of comma-separated strings: multiple aliases, multiple tags
  // and multiple generic code pairs, all added repeatedly in the add dialog.
  it('accepts aliases and tags as already-split lists', () => {
    const spec = buildUserMetricSpec({
      name: 'Ferritin',
      valueType: 'number',
      aliases: ['S-Ferritin', 'Ferr'],
      tags: ['iron', 'blood'],
    });
    expect(spec?.aliases).toEqual(['Ferritin', 'S-Ferritin', 'Ferr']);
    expect(spec?.tags).toEqual(['iron', 'blood']);
  });

  it('keeps multiple generic code pairs from the chip editor, dropping incomplete ones', () => {
    const spec = buildUserMetricSpec({
      name: 'Glucose',
      valueType: 'number',
      codePairs: [
        { system: 'ACME', code: '03123' },
        { system: 'NCLP', code: '01234' },
        { system: 'Empty', code: '   ' },
      ],
    });
    expect(spec?.externalCodes).toEqual({
      other: [
        { system: 'ACME', code: '03123' },
        { system: 'NCLP', code: '01234' },
      ],
    });
  });

  it('merges the code-pair list with the single system/value fallback', () => {
    const spec = buildUserMetricSpec({
      name: 'Glucose',
      valueType: 'number',
      loinc: '2345-7',
      codePairs: [{ system: 'ACME', code: '03123' }],
      codeSystem: 'NCLP',
      codeValue: '01234',
    });
    expect(spec?.externalCodes).toEqual({
      loinc: '2345-7',
      other: [
        { system: 'ACME', code: '03123' },
        { system: 'NCLP', code: '01234' },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// applyMetricHidden
// ---------------------------------------------------------------------------

function emptyProfile(): ProfileData {
  return {
    schemaVersion: 1,
    profile: { id: 'p1' as ProfileId, name: 'Test', createdAt: '2026-01-01' },
    metrics: [],
    sources: [],
    measurements: [],
    settings: {},
  };
}

describe('applyMetricHidden', () => {
  const builtin: Metric = {
    id: 'builtin:glucose' as MetricId,
    key: 'glucose',
    nameKey: 'metric.glucose',
    aliases: ['Glucose'],
    category: 'lab',
    valueType: 'number',
    canonicalUnit: 'mmol/L',
    units: ['mmol/L'],
  };

  it('appends an override for a built-in with no existing profile entry', () => {
    const data = emptyProfile();
    applyMetricHidden(data, builtin, true);
    expect(data.metrics).toHaveLength(1);
    expect(data.metrics[0].id).toBe('builtin:glucose');
    expect(data.metrics[0].hidden).toBe(true);
  });

  it('updates the flag in place when an entry already exists', () => {
    const data = emptyProfile();
    const userMetric: Metric = {
      id: 'user:1' as MetricId,
      customName: 'My metric',
      aliases: [],
      category: 'custom',
      valueType: 'number',
      canonicalUnit: 'mmol/L',
      units: ['mmol/L'],
      hidden: true,
    };
    data.metrics.push(userMetric);
    applyMetricHidden(data, userMetric, false);
    expect(data.metrics).toHaveLength(1);
    expect(data.metrics[0].hidden).toBe(false);
  });

  it('copies the aliases array so a later edit cannot mutate the source metric', () => {
    const data = emptyProfile();
    applyMetricHidden(data, builtin, true);
    // Mutating the stored override's aliases must not leak back into `builtin`.
    data.metrics[0].aliases.push('Cukr');
    expect(data.metrics[0].aliases).toEqual(['Glucose', 'Cukr']);
    expect(builtin.aliases).toEqual(['Glucose']);
  });
});

// ---------------------------------------------------------------------------
// Metrics (remove) — usage guard + removal
// ---------------------------------------------------------------------------

describe('metricUsageCount', () => {
  it('counts only measurements referencing the given metric', () => {
    const measurements = [
      { metricId: 'builtin:glucose' as MetricId },
      { metricId: 'builtin:glucose' as MetricId },
      { metricId: 'user:1' as MetricId },
    ];
    expect(metricUsageCount(measurements, 'builtin:glucose' as MetricId)).toBe(2);
    expect(metricUsageCount(measurements, 'user:1' as MetricId)).toBe(1);
    expect(metricUsageCount(measurements, 'user:2' as MetricId)).toBe(0);
  });
});

describe('isMetricRemovable', () => {
  it('is true only when the metric has zero measurements', () => {
    expect(isMetricRemovable(0)).toBe(true);
    expect(isMetricRemovable(1)).toBe(false);
    expect(isMetricRemovable(5)).toBe(false);
  });
});

describe('isBuiltinMetric', () => {
  it('distinguishes built-ins from user metrics by id', () => {
    expect(isBuiltinMetric(GLUCOSE)).toBe(true);
    expect(isBuiltinMetric(STEPS)).toBe(false);
  });
});

describe('applyMetricRemoval', () => {
  it('disables a built-in (dedup) without touching measurements', () => {
    const data = emptyProfile();
    data.measurements = [{ metricId: 'builtin:body-weight' } as never];
    applyMetricRemoval(data, GLUCOSE);
    applyMetricRemoval(data, GLUCOSE); // idempotent — no duplicate
    expect(data.disabledMetrics).toEqual(['builtin:glucose']);
    expect(data.measurements).toHaveLength(1);
  });

  it('drops a built-in override entry when disabling it', () => {
    const data = emptyProfile();
    data.metrics = [{ ...GLUCOSE, aliases: ['Glucose', 'Cukr'], hidden: true }];
    applyMetricRemoval(data, GLUCOSE);
    expect(data.metrics).toHaveLength(0);
    expect(data.disabledMetrics).toEqual(['builtin:glucose']);
  });

  it('deletes a user metric outright and never adds it to disabledMetrics', () => {
    const data = emptyProfile();
    data.metrics = [STEPS];
    applyMetricRemoval(data, STEPS);
    expect(data.metrics).toHaveLength(0);
    expect(data.disabledMetrics).toBeUndefined();
  });
});
