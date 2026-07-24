import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createCatalog } from '../../../core/catalog.js';
import { CURRENT_SCHEMA_VERSION } from '../../../core/types.js';
import type { MetricId, ProfileData, ProfileId } from '../../../core/types.js';
import { fhirImportPlugin, observationsToProposals } from '../fhir.js';

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

function catalog() {
  return createCatalog(emptyProfile());
}

function loadBundle(): unknown {
  const path = fileURLToPath(
    new URL('../../../../test/fixtures/fhir-bundle.json', import.meta.url),
  );
  return JSON.parse(readFileSync(path, 'utf8'));
}

const CLOSE = 1e-9;

describe('observationsToProposals', () => {
  it('yields one proposal per numeric Observation in the bundle', () => {
    const proposals = observationsToProposals(loadBundle(), catalog());
    // All six observations carry a numeric valueQuantity.value, so none are skipped.
    expect(proposals).toHaveLength(6);
  });

  it('resolves glucose (LOINC 2345-7) with unit, reference range and date', () => {
    const proposals = observationsToProposals(loadBundle(), catalog());
    const glucose = proposals[0];
    expect(glucose.metric).toBe('builtin:glucose' as MetricId);
    expect(glucose.value).toBeCloseTo(5.4, 9);
    expect(glucose.unit).toBe('mmol/L');
    expect(glucose.refLow).toBeCloseTo(3.9, 9);
    expect(glucose.refHigh).toBeCloseTo(5.6, 9);
    // Timezone stripped, wall-clock date preserved.
    expect(glucose.takenAt?.startsWith('2023-02-10')).toBe(true);
    expect(glucose.confidence).toBe('high');
  });

  it('resolves LDL (13457-7) with a one-sided reference range', () => {
    const proposals = observationsToProposals(loadBundle(), catalog());
    const ldl = proposals[1];
    expect(ldl.metric).toBe('builtin:ldl-cholesterol' as MetricId);
    expect(ldl.refLow).toBeUndefined();
    expect(ldl.refHigh).toBeCloseTo(3.0, 9);
    expect(ldl.takenAt).toBe('2023-02-10');
    expect(ldl.timePrecision).toBe('date');
  });

  it('resolves HbA1c (4548-4) with unit mmol/mol', () => {
    const proposals = observationsToProposals(loadBundle(), catalog());
    const hba1c = proposals[2];
    expect(hba1c.metric).toBe('builtin:hba1c' as MetricId);
    expect(hba1c.unit).toBe('mmol/mol');
    expect(hba1c.value).toBeCloseTo(42, 9);
  });

  it('leaves an unmapped LOINC/text as unresolved with low confidence', () => {
    const proposals = observationsToProposals(loadBundle(), catalog());
    const mystery = proposals[4];
    expect(mystery.metric).toEqual({ unresolvedName: 'Mystery analyte' });
    expect(mystery.confidence).toBe('low');
  });

  it('maps a comparator to an operator (censored "< 0.1")', () => {
    const proposals = observationsToProposals(loadBundle(), catalog());
    const censored = proposals[5];
    expect(censored.metric).toBe('builtin:glucose' as MetricId);
    expect(censored.operator).toBe('<');
    expect(censored.value).toBeCloseTo(0.1, 9);
  });

  it('keeps the original code+value traceable in rawText', () => {
    const proposals = observationsToProposals(loadBundle(), catalog());
    expect(proposals[0].rawText).toContain('2345-7');
    expect(proposals[0].rawText).toContain('5.4');
  });

  it('accepts a single Observation not wrapped in a Bundle', () => {
    const single = {
      resourceType: 'Observation',
      code: { coding: [{ system: 'http://loinc.org', code: '2345-7' }] },
      effectiveDateTime: '2023-02-10',
      valueQuantity: { value: 5.4, code: 'mmol/L' },
    };
    const proposals = observationsToProposals(single, catalog());
    expect(proposals).toHaveLength(1);
    expect(proposals[0].metric).toBe('builtin:glucose' as MetricId);
    expect(proposals[0].value).toBeCloseTo(5.4, 9);
  });

  it('accepts a bare array of Observations', () => {
    const arr = [
      {
        resourceType: 'Observation',
        code: { coding: [{ system: 'http://loinc.org', code: '2345-7' }] },
        effectiveDateTime: '2023-02-10',
        valueQuantity: { value: 5.4, code: 'mmol/L' },
      },
      {
        resourceType: 'Observation',
        code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] },
        effectiveDateTime: '2023-08-14',
        valueQuantity: { value: 42, code: 'mmol/mol' },
      },
    ];
    const proposals = observationsToProposals(arr, catalog());
    expect(proposals).toHaveLength(2);
    expect(proposals[0].metric).toBe('builtin:glucose' as MetricId);
    expect(proposals[1].metric).toBe('builtin:hba1c' as MetricId);
  });

  it('collects Observations contained in a DiagnosticReport', () => {
    const report = {
      resourceType: 'DiagnosticReport',
      contained: [
        {
          resourceType: 'Observation',
          code: { coding: [{ system: 'http://loinc.org', code: '2345-7' }] },
          effectiveDateTime: '2023-02-10',
          valueQuantity: { value: 5.4, code: 'mmol/L' },
        },
      ],
    };
    const proposals = observationsToProposals(report, catalog());
    expect(proposals).toHaveLength(1);
    expect(proposals[0].metric).toBe('builtin:glucose' as MetricId);
  });

  it('skips Observations without a numeric valueQuantity', () => {
    const arr = [
      {
        resourceType: 'Observation',
        code: { text: 'Blood group' },
        valueString: 'O+',
      },
      {
        resourceType: 'Observation',
        code: { coding: [{ system: 'http://loinc.org', code: '2345-7' }] },
        effectiveDateTime: '2023-02-10',
        valueQuantity: { value: 5.4, code: 'mmol/L' },
      },
    ];
    const proposals = observationsToProposals(arr, catalog());
    expect(proposals).toHaveLength(1);
  });

  it('degrades gracefully on malformed input without throwing', () => {
    expect(observationsToProposals(null, catalog())).toEqual([]);
    expect(observationsToProposals(42, catalog())).toEqual([]);
    expect(observationsToProposals({ resourceType: 'Bundle' }, catalog())).toEqual([]);
  });
});

describe('fhirImportPlugin', () => {
  it('exposes the expected plugin metadata', () => {
    expect(fhirImportPlugin.id).toBe('fhir');
    expect(fhirImportPlugin.nameKey).toBe('import.fhir');
    expect(fhirImportPlugin.kind).toBe('file');
    expect(fhirImportPlugin.accepts).toContain('.json');
    expect(fhirImportPlugin.accepts).toContain('application/fhir+json');
  });

  it('parses an already-parsed data input', async () => {
    const proposals = await fhirImportPlugin.parse(
      { kind: 'data', data: loadBundle() },
      { catalog: catalog() },
    );
    expect(proposals).toHaveLength(6);
  });

  it('parses a file input via File.text()', async () => {
    const text = JSON.stringify(loadBundle());
    const file = new File([text], 'bundle.json', { type: 'application/fhir+json' });
    const proposals = await fhirImportPlugin.parse(
      { kind: 'file', file },
      { catalog: catalog() },
    );
    expect(proposals).toHaveLength(6);
  });
});
