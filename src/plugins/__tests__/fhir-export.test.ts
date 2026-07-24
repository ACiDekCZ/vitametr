import { describe, expect, it } from 'vitest';

import { createCatalog } from '../../core/catalog.js';
import { createUnitsEngine } from '../../core/units.js';
import { CURRENT_SCHEMA_VERSION } from '../../core/types.js';
import type {
  Measurement,
  MeasurementId,
  MetricId,
  ProfileData,
  ProfileId,
} from '../../core/types.js';
import type { ExportContext, ExportSelection } from '../../core/contracts.js';
import { fhirExportPlugin } from '../export/fhir.js';
import { observationsToProposals } from '../import/fhir.js';

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
      base({ id: 'a' as MeasurementId, value: 5.4, refLow: 3.9, refHigh: 5.6 }),
      base({
        id: 'b' as MeasurementId,
        metricId: 'builtin:crp' as MetricId,
        value: 0.1,
        operator: '<',
        unit: 'mg/L',
        takenAt: '2026-02-20',
      }),
    ],
    settings: {},
  };
}

function ctxFor(data: ProfileData): ExportContext {
  return { data, catalog: createCatalog(data), units: createUnitsEngine(), locale: 'en' };
}

function fixtureWithSettings(over: Partial<ProfileData['settings']>): ProfileData {
  const data = fixture();
  data.settings = { ...data.settings, ...over };
  return data;
}

async function bundleFor(selection: ExportSelection, data = fixture()): Promise<any> {
  const blob = await fhirExportPlugin.export(selection, ctxFor(data));
  return JSON.parse(await blob.text());
}

describe('fhir export', () => {
  it('emits a FHIR R4 collection Bundle of Observations', async () => {
    const bundle = await bundleFor({});
    expect(bundle.resourceType).toBe('Bundle');
    expect(bundle.type).toBe('collection');
    expect(bundle.entry).toHaveLength(2);
    const obs = bundle.entry[0].resource;
    expect(obs.resourceType).toBe('Observation');
    expect(obs.status).toBe('final');
  });

  it('adds a LOINC coding + display for a metric with an external code', async () => {
    const bundle = await bundleFor({});
    const glucose = bundle.entry[0].resource;
    expect(glucose.code.text).toBe('Glucose');
    expect(glucose.code.coding[0].system).toBe('http://loinc.org');
    expect(typeof glucose.code.coding[0].code).toBe('string');
    expect(glucose.valueQuantity.value).toBeCloseTo(5.4, 9);
    expect(glucose.valueQuantity.unit).toBe('mmol/L');
    expect(glucose.effectiveDateTime).toBe('2026-01-15');
    expect(glucose.referenceRange[0].low.value).toBeCloseTo(3.9, 9);
    expect(glucose.referenceRange[0].high.value).toBeCloseTo(5.6, 9);
  });

  it('carries the comparator for a censored value', async () => {
    const bundle = await bundleFor({});
    const crp = bundle.entry[1].resource;
    expect(crp.valueQuantity.comparator).toBe('<');
  });

  it('honors metricIds + range', async () => {
    const bundle = await bundleFor({
      metricIds: ['builtin:glucose' as MetricId],
      range: { from: '2026-01-01', to: '2026-01-31' },
    });
    expect(bundle.entry).toHaveLength(1);
    expect(bundle.entry[0].resource.code.text).toBe('Glucose');
  });

  it('emits a category with a Vitametr tag coding for a tagged metric', async () => {
    const bundle = await bundleFor({});
    // glucose is auto-tagged blood + diabetes.
    const glucose = bundle.entry[0].resource;
    expect(glucose.category).toHaveLength(1);
    const codes = glucose.category[0].coding.map((c: any) => c.code);
    expect(codes).toContain('blood');
    expect(codes).toContain('diabetes');
    expect(glucose.category[0].coding[0].system).toBe('https://vitametr.app/fhir/tag');
    expect(glucose.category[0].coding[0].display).toBe(glucose.category[0].coding[0].code);
  });

  it('omits category when tags are disabled', async () => {
    const bundle = await bundleFor({}, fixtureWithSettings({ useTags: false }));
    expect(bundle.entry[0].resource.category).toBeUndefined();
    expect(bundle.entry[1].resource.category).toBeUndefined();
  });

  it('round-trips: the exported Observations are recognized by the FHIR import', async () => {
    const data = fixture();
    const bundle = await bundleFor({}, data);
    const proposals = observationsToProposals(bundle, createCatalog(data));
    expect(proposals).toHaveLength(2);
    const glucose = proposals[0];
    expect(glucose.metric).toBe('builtin:glucose' as MetricId);
    expect(glucose.value).toBeCloseTo(5.4, 9);
    expect(glucose.unit).toBe('mmol/L');
    expect(glucose.refLow).toBeCloseTo(3.9, 9);
    expect(glucose.refHigh).toBeCloseTo(5.6, 9);
  });
});
