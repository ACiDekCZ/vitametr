import { describe, expect, it } from 'vitest';

import { createCatalog } from '../../core/catalog.js';
import { createImportPipeline, type ImportPipelineDeps } from '../../core/review.js';
import { PassphraseRequiredError, WrongPassphraseError } from '../../core/contracts.js';
import { CURRENT_SCHEMA_VERSION } from '../../core/types.js';
import type {
  Measurement,
  MeasurementId,
  MetricId,
  ProfileData,
  ProfileId,
  SourceId,
} from '../../core/types.js';
import { jsonBackupExportPlugin } from '../export/json-backup.js';
import { jsonBackupImportPlugin } from '../import/json-backup.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const PROFILE_ID = 'p1' as ProfileId;
const SRC = 'src-lab' as SourceId;

function measurement(over: Partial<Measurement>): Measurement {
  return {
    id: 'orig' as MeasurementId,
    profileId: PROFILE_ID,
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
    profile: { id: PROFILE_ID, name: 'Test', createdAt: '2026-01-01' },
    metrics: [],
    sources: [{ id: SRC, name: 'Synlab, s.r.o.', kind: 'lab' }],
    measurements: [
      measurement({ id: 'a' as MeasurementId, value: 5.4, takenAt: '2026-01-15', sourceId: SRC }),
      // censored operator value + reference range
      measurement({
        id: 'b' as MeasurementId,
        metricId: 'builtin:crp' as MetricId,
        value: 0.1,
        operator: '<',
        unit: 'mg/L',
        takenAt: '2026-02-20',
        refLow: 0,
        refHigh: 5,
        refText: '< 5,0',
        // note with delimiter, quotes, newline and accents
        note: 'Ranní odběr; "nalačno"\nkontrolní',
        sourceId: SRC,
      }),
      measurement({
        id: 'c' as MeasurementId,
        metricId: 'builtin:hemoglobin' as MetricId,
        value: 145,
        unit: 'g/L',
        takenAt: '2026-03-10T08:30',
        timePrecision: 'datetime',
      }),
    ],
    settings: { locale: 'cs' },
  };
}

function deps(): ImportPipelineDeps {
  let n = 0;
  return {
    newId: () => `restored-${++n}` as MeasurementId,
    now: () => '2026-07-21T10:00',
    profileId: PROFILE_ID,
  };
}

/** The fields a lossless restore must preserve (id/status/timestamps are re-derived). */
function meaningful(m: Measurement) {
  return {
    metricId: m.metricId,
    value: m.value,
    operator: m.operator,
    unit: m.unit,
    takenAt: m.takenAt,
    timePrecision: m.timePrecision,
    refLow: m.refLow,
    refHigh: m.refHigh,
    refText: m.refText,
    note: m.note,
    rawText: m.origin.rawText,
  };
}

async function fileFromBlob(blob: Blob, name: string): Promise<File> {
  const text = await blob.text();
  return new File([text], name, { type: blob.type });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('json backup round-trip', () => {
  it('restores the meaningful fields losslessly', async () => {
    const data = fixture();
    const catalog = createCatalog(data);

    const blob = await jsonBackupExportPlugin.export({}, {
      data,
      catalog,
      units: undefined as never,
      locale: 'cs',
    });
    const file = await fileFromBlob(blob, 'vitametr-backup.json');

    const proposals = await jsonBackupImportPlugin.parse({ kind: 'file', file }, { catalog });
    // source names are surfaced for the review UI to map back
    expect(proposals[0].sourceName).toBe('Synlab, s.r.o.');

    const pipeline = createImportPipeline(catalog, deps());
    const items = pipeline.prepare(proposals, { catalog });
    // every proposal resolves (metric ids came straight from the backup)
    expect(items.every((i) => i.resolvedMetricId !== undefined)).toBe(true);
    for (const item of items) item.decision = 'accept';

    const restored = pipeline.commit(items, { pluginId: 'json-backup' });

    expect(restored.map(meaningful)).toEqual(data.measurements.map(meaningful));
    // and the censored operator + special-character note survived
    const crp = restored.find((m) => m.metricId === 'builtin:crp');
    expect(crp?.operator).toBe('<');
    expect(crp?.note).toBe('Ranní odběr; "nalačno"\nkontrolní');
  });

  it('is a well-formed, versioned envelope', async () => {
    const data = fixture();
    const catalog = createCatalog(data);
    const blob = await jsonBackupExportPlugin.export({}, {
      data,
      catalog,
      units: undefined as never,
      locale: 'en',
    });
    const parsed = JSON.parse(await blob.text());
    expect(parsed.format).toBe('vitametr-backup');
    expect(parsed.backupVersion).toBe(1);
    expect(parsed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.sources).toHaveLength(1);
    expect(parsed.measurements).toHaveLength(3);
  });
});

describe('password-protected backup', () => {
  async function encryptedFile(password: string): Promise<File> {
    const data = fixture();
    const catalog = createCatalog(data);
    const blob = await jsonBackupExportPlugin.export(
      { password },
      { data, catalog, units: undefined as never, locale: 'cs' },
    );
    return fileFromBlob(blob, 'vitametr-backup.json');
  }

  it('emits an encrypted envelope that reveals no plaintext', async () => {
    const file = await encryptedFile('export-pw');
    const parsed = JSON.parse(await file.text());
    expect(parsed.format).toBe('vitametr-backup-encrypted');
    expect(parsed.backupVersion).toBe(1);
    expect(parsed.ciphertext).toBeTypeOf('string');
    // No measurement/source data leaks into the envelope.
    expect(parsed.measurements).toBeUndefined();
    expect(await file.text()).not.toContain('Synlab');
  });

  it('imports back with the correct password', async () => {
    const file = await encryptedFile('export-pw');
    const catalog = createCatalog(fixture());
    const proposals = await jsonBackupImportPlugin.parse(
      { kind: 'file', file },
      { catalog, password: 'export-pw' },
    );
    expect(proposals).toHaveLength(3);
    expect(proposals[0].sourceName).toBe('Synlab, s.r.o.');
  });

  it('signals PassphraseRequiredError when no password is given', async () => {
    const file = await encryptedFile('export-pw');
    const catalog = createCatalog(fixture());
    await expect(
      jsonBackupImportPlugin.parse({ kind: 'file', file }, { catalog }),
    ).rejects.toBeInstanceOf(PassphraseRequiredError);
  });

  it('rejects a wrong password with WrongPassphraseError', async () => {
    const file = await encryptedFile('export-pw');
    const catalog = createCatalog(fixture());
    await expect(
      jsonBackupImportPlugin.parse(
        { kind: 'file', file },
        { catalog, password: 'wrong' },
      ),
    ).rejects.toBeInstanceOf(WrongPassphraseError);
  });
});

describe('ExportSelection filtering', () => {
  const data = fixture();
  const catalog = createCatalog(data);

  async function measurementsFor(selection: Parameters<typeof jsonBackupExportPlugin.export>[0]) {
    const blob = await jsonBackupExportPlugin.export(selection, {
      data,
      catalog,
      units: undefined as never,
      locale: 'en',
    });
    return JSON.parse(await blob.text()).measurements as Measurement[];
  }

  it('filters by metric id', async () => {
    const out = await measurementsFor({ metricIds: ['builtin:crp' as MetricId] });
    expect(out).toHaveLength(1);
    expect(out[0].metricId).toBe('builtin:crp');
  });

  it('filters by date range (inclusive)', async () => {
    const out = await measurementsFor({ range: { from: '2026-02-01', to: '2026-02-28' } });
    expect(out).toHaveLength(1);
    expect(out[0].metricId).toBe('builtin:crp');
  });

  it('combines metric and range filters', async () => {
    const out = await measurementsFor({
      metricIds: ['builtin:glucose' as MetricId],
      range: { from: '2026-03-01' },
    });
    expect(out).toHaveLength(0);
  });
});
