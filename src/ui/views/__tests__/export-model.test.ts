import { describe, expect, it } from 'vitest';

import { createCatalog } from '../../../core/catalog';
import { CURRENT_SCHEMA_VERSION } from '../../../core/types';
import type {
  Measurement,
  MeasurementId,
  MetricId,
  ProfileData,
  ProfileId,
} from '../../../core/types';
import {
  EXPORT_FORMATS,
  applyExtension,
  buildExportBaseName,
  buildExportFilename,
  buildExportSelection,
  buildMetricItems,
  buildPackBaseName,
  buildSnapshotBaseName,
  canExport,
  formatById,
  isInteropFormat,
  metricMatchesQuery,
  periodOptions,
  periodToRange,
  sanitizeFilename,
} from '../export-model';

function base(over: Partial<Measurement>): Measurement {
  return {
    id: 'a' as MeasurementId,
    profileId: 'p1' as ProfileId,
    metricId: 'builtin:glucose' as MetricId,
    value: 5.4,
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

function fixture(): ProfileData {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    profile: { id: 'p1' as ProfileId, name: 'Test', createdAt: '2026-01-01' },
    metrics: [],
    sources: [],
    measurements: [
      base({ id: 'a' as MeasurementId }),
      base({ id: 'b' as MeasurementId, takenAt: '2026-02-01' }),
      base({ id: 'c' as MeasurementId, metricId: 'builtin:crp' as MetricId, unit: 'mg/L' }),
    ],
    settings: {},
  };
}

const NOW = '2026-07-23T12:00:00.000Z';

describe('export formats', () => {
  it('offers only interop formats — never the json backup', () => {
    const ids = EXPORT_FORMATS.map((f) => f.id);
    expect(ids).toEqual(['csv', 'fhir', 'report']);
    expect(ids).not.toContain('json-backup');
  });

  it('isInteropFormat is true for the tiles and false for json-backup', () => {
    expect(isInteropFormat('csv')).toBe(true);
    expect(isInteropFormat('fhir')).toBe(true);
    expect(isInteropFormat('report')).toBe(true);
    expect(isInteropFormat('json-backup')).toBe(false);
  });

  it('formatById resolves the report tile to an html extension', () => {
    expect(formatById('report')?.extension).toBe('html');
    expect(formatById('nope')).toBeUndefined();
  });
});

describe('period → range', () => {
  it('lists the four presets', () => {
    expect(periodOptions().map((o) => o.id)).toEqual(['3m', 'year', '5y', 'all']);
  });

  it('"all" maps to no range', () => {
    expect(periodToRange('all', NOW)).toBeUndefined();
  });

  it('bounded periods set only a lower bound', () => {
    const y = periodToRange('year', NOW);
    expect(y?.from).toBe('2025-07-23T12:00:00.000Z');
    expect(y?.to).toBeUndefined();
    const q = periodToRange('3m', NOW);
    expect(q?.from).toBe('2026-04-23T12:00:00.000Z');
  });
});

describe('buildMetricItems', () => {
  it('lists metrics that have data, with record counts, sorted by name', () => {
    const data = fixture();
    const items = buildMetricItems(data.measurements, createCatalog(data));
    expect(items).toHaveLength(2);
    // 'CRP' sorts before 'glucose' key ('builtin:crp' < 'builtin:glucose').
    const byId = new Map(items.map((i) => [i.metricId, i.count]));
    expect(byId.get('builtin:glucose' as MetricId)).toBe(2);
    expect(byId.get('builtin:crp' as MetricId)).toBe(1);
  });
});

describe('metricMatchesQuery', () => {
  it('is diacritics- and case-insensitive; empty query matches all', () => {
    expect(metricMatchesQuery('Glukóza', 'gluk')).toBe(true);
    expect(metricMatchesQuery('Glukóza', 'GLUKO')).toBe(true);
    expect(metricMatchesQuery('Glukóza', 'xyz')).toBe(false);
    expect(metricMatchesQuery('anything', '  ')).toBe(true);
  });
});

describe('selection + filename', () => {
  it('builds an ExportSelection with the metric ids and a period range', () => {
    const sel = buildExportSelection(['builtin:glucose' as MetricId], 'year', NOW);
    expect(sel.metricIds).toEqual(['builtin:glucose']);
    expect(sel.range?.from).toBe('2025-07-23T12:00:00.000Z');
    expect(sel.password).toBeUndefined();
  });

  it('omits the range for the "all" period', () => {
    const sel = buildExportSelection(['builtin:glucose' as MetricId], 'all', NOW);
    expect(sel.range).toBeUndefined();
  });

  it('builds a snapshot selection with mode + as-of date (no range)', () => {
    const sel = buildExportSelection(['builtin:glucose' as MetricId], 'year', NOW, {
      mode: 'snapshot',
      asOfIso: '2025-01-01',
    });
    expect(sel.mode).toBe('snapshot');
    expect(sel.asOfIso).toBe('2025-01-01');
    expect(sel.range).toBeUndefined();
    expect(sel.metricIds).toEqual(['builtin:glucose']);
  });

  it('snapshot mode defaults the as-of date to the injected now day', () => {
    const sel = buildExportSelection(['builtin:glucose' as MetricId], 'all', NOW, {
      mode: 'snapshot',
    });
    expect(sel.mode).toBe('snapshot');
    expect(sel.asOfIso).toBe('2026-07-23');
  });

  it('range mode is unchanged when opts is omitted (no mode/asOf)', () => {
    const sel = buildExportSelection(['builtin:glucose' as MetricId], 'year', NOW);
    expect(sel.mode).toBeUndefined();
    expect(sel.asOfIso).toBeUndefined();
    expect(sel.range?.from).toBe('2025-07-23T12:00:00.000Z');
  });

  it('canExport requires at least one metric', () => {
    expect(canExport([])).toBe(false);
    expect(canExport(['builtin:glucose' as MetricId])).toBe(true);
  });

  it('builds a dated filename per extension', () => {
    expect(buildExportFilename('csv', NOW)).toBe('vitametr-export-2026-07-23.csv');
    expect(buildExportFilename('html')).toBe('vitametr-export.html');
  });
});

describe('editable filename helpers', () => {
  it('pre-fills a dated base name (no extension), dropping the date when absent', () => {
    expect(buildExportBaseName(NOW)).toBe('vitametr-export-2026-07-23');
    expect(buildExportBaseName()).toBe('vitametr-export');
    expect(buildPackBaseName(NOW)).toBe('vitametr-pack-2026-07-23');
    expect(buildPackBaseName('not-a-date')).toBe('vitametr-pack');
    expect(buildSnapshotBaseName('2025-01-01')).toBe('vitametr-stav-2025-01-01');
    expect(buildSnapshotBaseName()).toBe('vitametr-stav');
  });

  it('sanitizeFilename strips path separators, control chars and leading dots', () => {
    expect(sanitizeFilename('my/lab\\report', 'fallback')).toBe('mylabreport');
    expect(sanitizeFilename('...hidden', 'fallback')).toBe('hidden');
    expect(sanitizeFilename('../../etc/passwd', 'fallback')).toBe('etcpasswd');
    expect(sanitizeFilename('a\tbc', 'fallback')).toBe('abc');
    expect(sanitizeFilename('  spaced name  ', 'fallback')).toBe('spaced name');
  });

  it('sanitizeFilename falls back when nothing usable remains', () => {
    expect(sanitizeFilename('', 'vitametr-pack')).toBe('vitametr-pack');
    expect(sanitizeFilename('   ', 'vitametr-pack')).toBe('vitametr-pack');
    expect(sanitizeFilename('...', 'vitametr-pack')).toBe('vitametr-pack');
    expect(sanitizeFilename('/\\', 'vitametr-pack')).toBe('vitametr-pack');
  });

  it('applyExtension appends once, respecting a user-typed extension (case-insensitive)', () => {
    expect(applyExtension('vitametr-pack', 'json')).toBe('vitametr-pack.json');
    expect(applyExtension('vitametr-pack.json', 'json')).toBe('vitametr-pack.json');
    expect(applyExtension('report.JSON', 'json')).toBe('report.JSON');
    expect(applyExtension('data.csv', 'json')).toBe('data.csv.json');
  });
});
