import { describe, expect, it } from 'vitest';

import { createCatalog } from '../../core/catalog.js';
import { createImportPipeline, type ImportPipelineDeps } from '../../core/review.js';
import { CURRENT_SCHEMA_VERSION } from '../../core/types.js';
import type { MeasurementId, MetricId, ProfileData, ProfileId, SourceId } from '../../core/types.js';
import { manualImportPlugin, type ManualEntryInput } from '../import/manual.js';

function emptyProfile(): ProfileData {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    profile: { id: 'p1' as ProfileId, name: 'Test', createdAt: '2026-07-21' },
    metrics: [],
    sources: [],
    measurements: [],
    settings: {},
  };
}

function deps(): ImportPipelineDeps {
  let n = 0;
  return {
    newId: () => `m${++n}` as MeasurementId,
    now: () => '2026-07-21T10:00',
    profileId: 'p1' as ProfileId,
  };
}

describe('manual import plugin', () => {
  const catalog = createCatalog(emptyProfile());

  it('is an interactive plugin', () => {
    expect(manualImportPlugin.kind).toBe('interactive');
    expect(manualImportPlugin.id).toBe('manual');
  });

  it('turns a single filled field into one confirmed measurement', async () => {
    const form: ManualEntryInput = {
      takenAt: '2026-07-20',
      sourceName: 'Home',
      fields: [{ metric: 'builtin:body-weight' as MetricId, value: 78.5, unit: 'kg' }],
    };
    const proposals = await manualImportPlugin.parse({ kind: 'data', data: form }, { catalog });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].confidence).toBe('high');

    const pipeline = createImportPipeline(catalog, deps());
    const items = pipeline.prepare(proposals, { catalog });
    items.forEach((i) => (i.decision = 'accept'));
    const [m] = pipeline.commit(items, { pluginId: 'manual' });

    expect(m.metricId).toBe('builtin:body-weight');
    expect(m.value).toBe(78.5);
    expect(m.unit).toBe('kg');
    expect(m.status).toBe('confirmed');
    expect(m.takenAt).toBe('2026-07-20');
    expect(m.timePrecision).toBe('date');
  });

  it('emits a blood-pressure group as 3 measurements sharing time and source', async () => {
    const form: ManualEntryInput = {
      takenAt: '2026-07-21T07:15',
      timePrecision: 'datetime',
      sourceName: 'Home monitor',
      fields: [
        { metric: 'builtin:bp-systolic' as MetricId, value: 128, unit: 'mmHg' },
        { metric: 'builtin:bp-diastolic' as MetricId, value: 82, unit: 'mmHg' },
        { metric: 'builtin:heart-rate' as MetricId, value: 64, unit: 'bpm' },
      ],
    };
    const proposals = await manualImportPlugin.parse({ kind: 'data', data: form }, { catalog });
    expect(proposals).toHaveLength(3);
    expect(proposals.every((p) => p.confidence === 'high')).toBe(true);

    const pipeline = createImportPipeline(catalog, deps());
    const items = pipeline.prepare(proposals, { catalog });
    items.forEach((i) => (i.decision = 'accept'));
    const out = pipeline.commit(items, {
      pluginId: 'manual',
      sourceId: 'src-home' as SourceId,
    });

    expect(out).toHaveLength(3);
    // unit spellings normalized to UCUM codes
    expect(out.map((m) => m.unit)).toEqual(['mm[Hg]', 'mm[Hg]', '/min']);
    // all three share the same time and source
    expect(new Set(out.map((m) => m.takenAt))).toEqual(new Set(['2026-07-21T07:15']));
    expect(new Set(out.map((m) => m.sourceId))).toEqual(new Set(['src-home']));
    expect(out.every((m) => m.status === 'confirmed')).toBe(true);
  });

  it('routes an unresolved metric name to review instead of guessing', async () => {
    const form: ManualEntryInput = {
      fields: [{ metric: { unresolvedName: 'My custom thing' }, value: 3, unit: 'kg' }],
    };
    const proposals = await manualImportPlugin.parse({ kind: 'data', data: form }, { catalog });
    const pipeline = createImportPipeline(catalog, deps());
    const [item] = pipeline.prepare(proposals, { catalog });
    expect(item.resolvedMetricId).toBeUndefined();
    // even if force-accepted, an unresolved item stores nothing
    item.decision = 'accept';
    expect(pipeline.commit([item], { pluginId: 'manual' })).toEqual([]);
  });

  it('rejects non-data input', async () => {
    await expect(
      manualImportPlugin.parse(
        { kind: 'file', file: new File(['x'], 'f.txt') },
        { catalog },
      ),
    ).rejects.toThrow();
  });
});
