import { describe, expect, it } from 'vitest';

import { createCatalog } from '../../core/catalog.js';
import { createUnitsEngine } from '../../core/units.js';
import { CURRENT_SCHEMA_VERSION } from '../../core/types.js';
import type {
  MetricId,
  ProfileData,
  ProfileId,
} from '../../core/types.js';
import type { ExportContext, ImportContext } from '../../core/contracts.js';
import { exampleImportPlugin } from '../examples/example-import-plugin.js';
import { exampleExportPlugin } from '../examples/example-export-plugin.js';
import { exampleLabParser } from '../examples/example-lab-parser.js';

/** Fresh empty-ish profile so the catalog is just the built-in seed. */
function emptyProfile(): ProfileData {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    profile: { id: 'p1' as ProfileId, name: 'Test', createdAt: '2026-01-01' },
    metrics: [],
    sources: [],
    measurements: [],
    settings: {},
  };
}

function importCtx(): ImportContext {
  return { catalog: createCatalog(emptyProfile()) };
}

describe('example-import-plugin', () => {
  it('conforms to the ImportPlugin shape', () => {
    expect(exampleImportPlugin.id).toBe('example-text');
    expect(exampleImportPlugin.kind).toBe('file');
    expect(typeof exampleImportPlugin.parse).toBe('function');
  });

  it('parses a resolved metric fully (value, unit, date, high confidence)', async () => {
    const proposals = await exampleImportPlugin.parse(
      { kind: 'data', data: 'Glukóza = 5,4 mmol/l @ 2026-03-15' },
      importCtx(),
    );
    expect(proposals).toHaveLength(1);
    const [p] = proposals;
    expect(p.metric).toBe('builtin:glucose' as MetricId);
    expect(p.value).toBeCloseTo(5.4, 9);
    expect(p.unit).toBe('mmol/L');
    expect(p.takenAt).toBe('2026-03-15');
    expect(p.confidence).toBe('high');
  });

  it('never guesses: unknown metric passes through, unknown unit is dropped', async () => {
    const proposals = await exampleImportPlugin.parse(
      { kind: 'data', data: 'Wobblonium = 12 zorp @ 2026-03-15' },
      importCtx(),
    );
    expect(proposals).toHaveLength(1);
    const [p] = proposals;
    expect(p.metric).toEqual({ unresolvedName: 'Wobblonium' });
    expect(p.value).toBe(12);
    expect(p.unit).toBeUndefined();
    expect(p.confidence).toBe('low');
  });

  it('captures a leading censoring operator', async () => {
    const [p] = await exampleImportPlugin.parse(
      { kind: 'data', data: 'CRP = < 0,1 mg/l @ 2026-03-15' },
      importCtx(),
    );
    expect(p.operator).toBe('<');
    expect(p.value).toBeCloseTo(0.1, 9);
  });
});

describe('example-lab-parser', () => {
  const LINES = [
    'EXAMPLE-LAB REPORT',
    'Date: 2026-03-15',
    'Glukóza | 5,4 | mmol/l | 3,9-5,6',
    'Kreatinin | 78 | umol/l | 64-104',
  ];

  it('conforms to the LabParser shape and detects its own sheet', () => {
    expect(exampleLabParser.id).toBe('example-lab');
    expect(exampleLabParser.detect(LINES)).toBe(true);
    expect(exampleLabParser.detect(['Some other lab'])).toBe(false);
  });

  it('parses keyed rows with value, unit, range and the shared date', () => {
    const proposals = exampleLabParser.parse(LINES, createCatalog(emptyProfile()));
    expect(proposals).toHaveLength(2);
    const [glucose] = proposals;
    expect(glucose.metric).toBe('builtin:glucose' as MetricId);
    expect(glucose.value).toBeCloseTo(5.4, 9);
    expect(glucose.unit).toBe('mmol/L');
    expect(glucose.refLow).toBeCloseTo(3.9, 9);
    expect(glucose.refHigh).toBeCloseTo(5.6, 9);
    expect(glucose.takenAt).toBe('2026-03-15');
  });
});

describe('example-export-plugin', () => {
  function exportCtx(): ExportContext {
    const data = emptyProfile();
    return { data, catalog: createCatalog(data), units: createUnitsEngine(), locale: 'en' };
  }

  it('conforms to the ExportPlugin shape', () => {
    expect(exampleExportPlugin.id).toBe('example-summary');
    expect(exampleExportPlugin.fileExtension).toBe('txt');
    expect(typeof exampleExportPlugin.export).toBe('function');
  });

  it('produces a text Blob (empty selection => zero rows)', async () => {
    const blob = await exampleExportPlugin.export({}, exportCtx());
    expect(blob.type).toContain('text/plain');
    const text = await blob.text();
    expect(text).toContain('0 measurement(s)');
  });
});
