/**
 * Unit tests for the DOM-free entry logic (K8c).
 */

import { describe, it, expect } from 'vitest';
import { createCatalog } from '../../../core/catalog';
import { createUnitsEngine } from '../../../core/units';
import type { Metric, ProfileData, ProfileId } from '../../../core/types';
import type { MetricId } from '../../../core/types';
import {
  buildManualInput,
  defaultUnitFor,
  filterMetrics,
  metricsInGroup,
  recentMetricIds,
  resolveMetricSelection,
  validateField,
  type EntryFormInput,
} from '../entry-model';

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

const catalog = createCatalog(emptyProfile());
const units = createUnitsEngine();

function metricId(key: string) {
  const m = catalog.byKey(key);
  if (!m) throw new Error(`missing metric ${key}`);
  return m.id;
}

describe('filterMetrics', () => {
  it('finds a metric by an alias substring', () => {
    const hits = filterMetrics('gluc', catalog);
    expect(hits.some((m) => m.key === 'glucose')).toBe(true);
  });

  it('returns suggestions (capped) for an empty query', () => {
    const hits = filterMetrics('', catalog, undefined, 5);
    expect(hits.length).toBe(5);
  });

  it('returns nothing for a query that matches no metric', () => {
    expect(filterMetrics('zzzznotathing', catalog)).toHaveLength(0);
  });
});

describe('resolveMetricSelection', () => {
  it('resolves a known alias to a metric id', () => {
    const result = resolveMetricSelection('Glucose', catalog);
    expect('metricId' in result && result.metricId).toBe(metricId('glucose'));
  });

  it('flags an unknown metric as unresolved (never guesses)', () => {
    const result = resolveMetricSelection('Wibble factor', catalog);
    expect(result).toEqual({ unresolvedName: 'Wibble factor' });
  });
});

describe('validateField', () => {
  const glucose = catalog.byKey('glucose');

  it('accepts a plain number', () => {
    const v = validateField('5.4', glucose, { unit: 'mmol/L', units });
    expect(v).toMatchObject({ ok: true, value: 5.4, warning: false });
  });

  it('rejects a non-number', () => {
    expect(validateField('abc', glucose)).toEqual({ ok: false });
  });

  it('accepts any non-empty string for a text metric', () => {
    const textMetric: Metric = {
      id: 'custom:result' as MetricId,
      customName: 'Výsledek',
      aliases: [],
      category: 'custom',
      valueType: 'text',
      canonicalUnit: '',
      units: [],
    };
    expect(validateField('Negativní', textMetric)).toMatchObject({ ok: true, text: 'Negativní' });
    expect(validateField('   ', textMetric)).toEqual({ ok: false });
  });

  it('rejects an empty value', () => {
    expect(validateField('   ', glucose)).toEqual({ ok: false });
  });

  it('parses a censoring operator', () => {
    const v = validateField('< 0.1', glucose, { unit: 'mmol/L', units });
    expect(v).toMatchObject({ ok: true, value: 0.1, operator: '<' });
  });

  it('warns on an out-of-typical-range value (non-blocking)', () => {
    // glucose typicalRange high is 30 mmol/L; 900 is a unit mix-up.
    const v = validateField('900', glucose, { unit: 'mmol/L', units });
    expect(v).toMatchObject({ ok: true, warning: true });
  });

  it('checks the range after converting from the entered unit', () => {
    // 100 mg/dL ~= 5.55 mmol/L — well inside range, must not warn.
    const v = validateField('100', glucose, { unit: 'mg/dL', units });
    expect(v).toMatchObject({ ok: true, warning: false });
  });
});

describe('defaultUnitFor', () => {
  it('prefers the last-used unit when the metric supports it', () => {
    const glucose = catalog.byKey('glucose')!;
    expect(defaultUnitFor(glucose, 'en', 'mg/dL')).toBe('mg/dL');
  });

  it('falls back to the locale-preferred unit', () => {
    const glucose = catalog.byKey('glucose')!;
    expect(defaultUnitFor(glucose, 'cs')).toBe('mmol/L');
  });
});

describe('recentMetricIds', () => {
  const mk = (metricId: string, takenAt: string) => ({
    metricId: metricId as MetricId,
    takenAt,
  });

  it('returns nothing for no measurements', () => {
    expect(recentMetricIds([])).toEqual([]);
  });

  it('orders distinct metrics by their latest takenAt (newest first)', () => {
    const ms = [
      mk('a', '2026-01-01'),
      mk('b', '2026-03-01'),
      mk('a', '2026-05-01'), // a's latest beats b
      mk('c', '2026-02-01'),
    ];
    expect(recentMetricIds(ms)).toEqual(['a', 'b', 'c']);
  });

  it('caps the result at the requested limit', () => {
    const ms = [
      mk('a', '2026-01-05'),
      mk('b', '2026-01-04'),
      mk('c', '2026-01-03'),
      mk('d', '2026-01-02'),
    ];
    expect(recentMetricIds(ms, 2)).toEqual(['a', 'b']);
  });
});

describe('metricsInGroup + buildManualInput (blood pressure)', () => {
  it('groups systolic, diastolic and pulse', () => {
    const group = metricsInGroup(catalog, 'blood-pressure');
    const keys = group.map((m) => m.key);
    expect(keys).toEqual(
      expect.arrayContaining(['bp-systolic', 'bp-diastolic', 'heart-rate']),
    );
    expect(group).toHaveLength(3);
  });

  it('builds 3 fields sharing one takenAt and source', () => {
    const form: EntryFormInput = {
      date: '2026-07-21',
      time: '08:30',
      sourceName: 'Home',
      fields: [
        { metric: metricId('bp-systolic'), rawValue: '120', unit: 'mm[Hg]' },
        { metric: metricId('bp-diastolic'), rawValue: '80', unit: 'mm[Hg]' },
        { metric: metricId('heart-rate'), rawValue: '64', unit: '/min' },
      ],
    };
    const input = buildManualInput(form);

    expect(input.fields).toHaveLength(3);
    expect(input.takenAt).toBe('2026-07-21T08:30');
    expect(input.timePrecision).toBe('datetime');
    expect(input.sourceName).toBe('Home');
    expect(input.fields.map((f) => f.value)).toEqual([120, 80, 64]);
  });
});

describe('buildManualInput', () => {
  it('builds a text field (textValue, no numeric parse) for a text-typed row', () => {
    const input = buildManualInput({
      date: '2026-07-22',
      fields: [
        { metric: 'custom:result' as MetricId, rawValue: '  Negativní ', valueType: 'text' },
      ],
    });
    expect(input.fields).toEqual([{ metric: 'custom:result', textValue: 'Negativní' }]);
  });

  it('carries operator, unit and reference range per field', () => {
    const form: EntryFormInput = {
      date: '2026-07-21',
      fields: [
        {
          metric: metricId('crp'),
          rawValue: '< 0.5',
          unit: 'mg/L',
          refLow: '0',
          refHigh: '5',
          note: 'fasting',
        },
      ],
    };
    const input = buildManualInput(form);

    expect(input.takenAt).toBe('2026-07-21');
    expect(input.timePrecision).toBe('date');
    expect(input.fields[0]).toMatchObject({
      value: 0.5,
      operator: '<',
      unit: 'mg/L',
      refLow: 0,
      refHigh: 5,
      note: 'fasting',
    });
  });

  it('skips empty and non-numeric rows', () => {
    const form: EntryFormInput = {
      date: '2026-07-21',
      fields: [
        { metric: metricId('glucose'), rawValue: '' },
        { metric: metricId('glucose'), rawValue: 'not a number' },
        { metric: metricId('glucose'), rawValue: '5.4' },
      ],
    };
    const input = buildManualInput(form);
    expect(input.fields).toHaveLength(1);
    expect(input.fields[0].value).toBe(5.4);
  });

  it('keeps an unresolved metric box so the pipeline can route it to review', () => {
    const form: EntryFormInput = {
      date: '2026-07-21',
      fields: [{ metric: { unresolvedName: 'Mystery marker' }, rawValue: '7' }],
    };
    const input = buildManualInput(form);
    expect(input.fields[0].metric).toEqual({ unresolvedName: 'Mystery marker' });
  });

  it('omits takenAt when the date is empty (pipeline falls back to now)', () => {
    const form: EntryFormInput = {
      date: '',
      fields: [{ metric: metricId('glucose'), rawValue: '5' }],
    };
    const input = buildManualInput(form);
    expect(input.takenAt).toBeUndefined();
  });
});
