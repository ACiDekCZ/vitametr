import { describe, expect, it } from 'vitest';

import {
  buildImportRecord,
  importsNewestFirst,
  measurementsForImport,
  metricsCreatedByImport,
  removeImport,
  removeImportAndMetrics,
  stampImportId,
  unusedMetricsCreatedByImport,
} from '../imports.js';
import { CURRENT_SCHEMA_VERSION } from '../types.js';
import type {
  ImportRecord,
  Measurement,
  MeasurementId,
  Metric,
  MetricId,
  ProfileData,
  ProfileId,
} from '../types.js';

function measurement(id: string, importId?: string, metricId = 'glucose'): Measurement {
  return {
    id: id as MeasurementId,
    profileId: 'p1' as ProfileId,
    metricId: metricId as MetricId,
    value: 5,
    unit: 'mmol/L',
    takenAt: '2026-07-21',
    timePrecision: 'date',
    status: 'confirmed',
    origin: { pluginId: 'pdf' },
    ...(importId !== undefined ? { importId } : {}),
    createdAt: '2026-07-21T10:00',
    modifiedAt: '2026-07-21T10:00',
  };
}

function metric(id: string, origin?: Metric['origin']): Metric {
  return {
    id: id as MetricId,
    customName: id,
    aliases: [],
    category: 'custom',
    valueType: 'number',
    canonicalUnit: 'mmol/L',
    units: ['mmol/L'],
    ...(origin !== undefined ? { origin } : {}),
  };
}

function profile(
  measurements: Measurement[],
  imports: ImportRecord[],
  metrics: Metric[] = [],
): ProfileData {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    profile: { id: 'p1' as ProfileId, name: 'Test', createdAt: '2026-07-21' },
    metrics,
    sources: [],
    measurements,
    imports,
    settings: {},
  };
}

describe('buildImportRecord', () => {
  it('keeps required fields and drops absent optionals', () => {
    const rec = buildImportRecord({
      id: 'imp1',
      importedAt: '2026-07-21T10:00',
      pluginId: 'pdf',
      count: 3,
    });
    expect(rec).toEqual({
      id: 'imp1',
      importedAt: '2026-07-21T10:00',
      pluginId: 'pdf',
      count: 3,
    });
    expect('fileName' in rec).toBe(false);
    expect('sourceName' in rec).toBe(false);
  });

  it('includes fileName and sourceName when provided', () => {
    const rec = buildImportRecord({
      id: 'imp1',
      importedAt: '2026-07-21T10:00',
      pluginId: 'pdf',
      fileName: 'labs.pdf',
      sourceName: 'Synlab',
      count: 1,
    });
    expect(rec.fileName).toBe('labs.pdf');
    expect(rec.sourceName).toBe('Synlab');
  });
});

describe('stampImportId', () => {
  it('stamps importId without mutating inputs', () => {
    const input = [measurement('m1'), measurement('m2')];
    const out = stampImportId(input, 'imp1');
    expect(out.map((m) => m.importId)).toEqual(['imp1', 'imp1']);
    // Inputs untouched.
    expect(input[0].importId).toBeUndefined();
    expect(out[0]).not.toBe(input[0]);
  });
});

describe('measurementsForImport', () => {
  it('returns only measurements with the matching importId', () => {
    const ms = [measurement('m1', 'imp1'), measurement('m2', 'imp2'), measurement('m3', 'imp1')];
    expect(measurementsForImport(ms, 'imp1').map((m) => m.id)).toEqual(['m1', 'm3']);
  });
});

describe('importsNewestFirst', () => {
  it('orders by importedAt descending, id as tiebreaker', () => {
    const older = buildImportRecord({ id: 'a', importedAt: '2026-07-20T09:00', pluginId: 'pdf', count: 1 });
    const newer = buildImportRecord({ id: 'b', importedAt: '2026-07-21T09:00', pluginId: 'pdf', count: 1 });
    const sameTimeHi = buildImportRecord({ id: 'z', importedAt: '2026-07-21T09:00', pluginId: 'pdf', count: 1 });
    const sorted = importsNewestFirst([older, newer, sameTimeHi]);
    expect(sorted.map((r) => r.id)).toEqual(['z', 'b', 'a']);
  });

  it('does not mutate the input array', () => {
    const input = [
      buildImportRecord({ id: 'a', importedAt: '2026-07-20T09:00', pluginId: 'pdf', count: 1 }),
      buildImportRecord({ id: 'b', importedAt: '2026-07-21T09:00', pluginId: 'pdf', count: 1 }),
    ];
    importsNewestFirst(input);
    expect(input.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('removeImport', () => {
  it('removes an import and all its measurements, returning the removed count', () => {
    const data = profile(
      [measurement('m1', 'imp1'), measurement('m2', 'imp2'), measurement('m3', 'imp1')],
      [
        buildImportRecord({ id: 'imp1', importedAt: '2026-07-21T10:00', pluginId: 'pdf', count: 2 }),
        buildImportRecord({ id: 'imp2', importedAt: '2026-07-21T11:00', pluginId: 'csv', count: 1 }),
      ],
    );
    const removed = removeImport(data, 'imp1');
    expect(removed).toBe(2);
    expect(data.measurements.map((m) => m.id)).toEqual(['m2']);
    expect(data.imports?.map((r) => r.id)).toEqual(['imp2']);
  });

  it('is a no-op for an unknown id', () => {
    const data = profile([measurement('m1', 'imp1')], [
      buildImportRecord({ id: 'imp1', importedAt: '2026-07-21T10:00', pluginId: 'pdf', count: 1 }),
    ]);
    const removed = removeImport(data, 'nope');
    expect(removed).toBe(0);
    expect(data.measurements).toHaveLength(1);
    expect(data.imports).toHaveLength(1);
  });

  it('handles missing imports array gracefully', () => {
    const data = profile([measurement('m1', 'imp1')], []);
    delete data.imports;
    const removed = removeImport(data, 'imp1');
    expect(removed).toBe(1);
    expect(data.measurements).toHaveLength(0);
  });
});

describe('metricsCreatedByImport', () => {
  it('returns metrics whose origin.importId matches, never built-in/manual/pack', () => {
    const data = profile(
      [],
      [],
      [
        metric('custom-a', { kind: 'import', importId: 'imp1' }),
        metric('custom-b', { kind: 'import', importId: 'imp2' }),
        metric('custom-c', { kind: 'manual' }),
        metric('custom-d', { kind: 'pack' }),
        metric('built-in'), // no origin
      ],
    );
    expect(metricsCreatedByImport(data, 'imp1').map((m) => m.id)).toEqual(['custom-a']);
  });
});

describe('unusedMetricsCreatedByImport', () => {
  it('lists a metric created by the import and used only by it', () => {
    const data = profile(
      [measurement('m1', 'imp1', 'custom-a')],
      [buildImportRecord({ id: 'imp1', importedAt: '2026-07-21T10:00', pluginId: 'pdf', count: 1 })],
      [metric('custom-a', { kind: 'import', importId: 'imp1' })],
    );
    expect(unusedMetricsCreatedByImport(data, 'imp1').map((m) => m.id)).toEqual(['custom-a']);
  });

  it('does NOT list a created metric also used by another source', () => {
    const data = profile(
      [
        measurement('m1', 'imp1', 'custom-a'),
        measurement('m2', 'imp2', 'custom-a'), // another import references it
      ],
      [
        buildImportRecord({ id: 'imp1', importedAt: '2026-07-21T10:00', pluginId: 'pdf', count: 1 }),
        buildImportRecord({ id: 'imp2', importedAt: '2026-07-21T11:00', pluginId: 'csv', count: 1 }),
      ],
      [metric('custom-a', { kind: 'import', importId: 'imp1' })],
    );
    expect(unusedMetricsCreatedByImport(data, 'imp1')).toEqual([]);
  });

  it('never lists a built-in metric', () => {
    const data = profile(
      [measurement('m1', 'imp1', 'glucose')],
      [buildImportRecord({ id: 'imp1', importedAt: '2026-07-21T10:00', pluginId: 'pdf', count: 1 })],
      [metric('glucose')], // no origin
    );
    expect(unusedMetricsCreatedByImport(data, 'imp1')).toEqual([]);
  });
});

describe('removeImportAndMetrics', () => {
  it('removes measurements + the unused created metrics when removeMetrics is true', () => {
    const data = profile(
      [measurement('m1', 'imp1', 'custom-a'), measurement('m2', 'imp2', 'glucose')],
      [
        buildImportRecord({ id: 'imp1', importedAt: '2026-07-21T10:00', pluginId: 'pdf', count: 1 }),
        buildImportRecord({ id: 'imp2', importedAt: '2026-07-21T11:00', pluginId: 'csv', count: 1 }),
      ],
      [metric('custom-a', { kind: 'import', importId: 'imp1' }), metric('glucose')],
    );
    const result = removeImportAndMetrics(data, 'imp1', true);
    expect(result).toEqual({ measurements: 1, metrics: 1 });
    expect(data.measurements.map((m) => m.id)).toEqual(['m2']);
    expect(data.metrics.map((m) => m.id)).toEqual(['glucose']);
    expect(data.imports?.map((r) => r.id)).toEqual(['imp2']);
  });

  it('leaves metrics in place when removeMetrics is false', () => {
    const data = profile(
      [measurement('m1', 'imp1', 'custom-a')],
      [buildImportRecord({ id: 'imp1', importedAt: '2026-07-21T10:00', pluginId: 'pdf', count: 1 })],
      [metric('custom-a', { kind: 'import', importId: 'imp1' })],
    );
    const result = removeImportAndMetrics(data, 'imp1', false);
    expect(result).toEqual({ measurements: 1, metrics: 0 });
    expect(data.metrics.map((m) => m.id)).toEqual(['custom-a']);
  });

  it('never deletes a created metric still used by another source', () => {
    const data = profile(
      [measurement('m1', 'imp1', 'custom-a'), measurement('m2', 'imp2', 'custom-a')],
      [
        buildImportRecord({ id: 'imp1', importedAt: '2026-07-21T10:00', pluginId: 'pdf', count: 1 }),
        buildImportRecord({ id: 'imp2', importedAt: '2026-07-21T11:00', pluginId: 'csv', count: 1 }),
      ],
      [metric('custom-a', { kind: 'import', importId: 'imp1' })],
    );
    const result = removeImportAndMetrics(data, 'imp1', true);
    expect(result).toEqual({ measurements: 1, metrics: 0 });
    expect(data.metrics.map((m) => m.id)).toEqual(['custom-a']);
    expect(data.measurements.map((m) => m.id)).toEqual(['m2']);
  });
});
