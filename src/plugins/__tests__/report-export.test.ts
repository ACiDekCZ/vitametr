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
import { reportExportPlugin } from '../export/report.js';

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
    profile: { id: 'p1' as ProfileId, name: 'Test <b>Person</b>', createdAt: '2026-01-01' },
    metrics: [],
    sources: [],
    measurements: [
      base({ id: 'a' as MeasurementId, value: 5.4 }),
      base({
        id: 'b' as MeasurementId,
        metricId: 'builtin:crp' as MetricId,
        value: 12,
        unit: 'mg/L',
        refLow: 0,
        refHigh: 5,
        takenAt: '2026-02-20',
      }),
    ],
    settings: {},
  };
}

function ctxFor(data: ProfileData): ExportContext {
  return {
    data,
    catalog: createCatalog(data),
    units: createUnitsEngine(),
    locale: 'en',
    nowIso: '2026-03-01T00:00',
  };
}

async function html(selection: ExportSelection, data = fixture()): Promise<string> {
  const blob = await reportExportPlugin.export(selection, ctxFor(data));
  return blob.text();
}

function fixtureWithSettings(over: Partial<ProfileData['settings']>): ProfileData {
  const data = fixture();
  data.settings = { ...data.settings, ...over };
  return data;
}

describe('report export', () => {
  it('emits a self-contained HTML document', async () => {
    const out = await html({});
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(out).toContain('<style>');
    expect(out).toContain('</html>');
  });

  it('contains no external references (no network)', async () => {
    const out = await html({});
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).not.toContain('<link');
    expect(out).not.toMatch(/\ssrc=/);
    expect(out).not.toContain('<script');
  });

  it('includes the selected metrics with values and reference ranges', async () => {
    const out = await html({});
    expect(out).toContain('Glucose');
    expect(out).toContain('CRP');
    // CRP is above its 0–5 range → an out-of-range badge is rendered.
    expect(out).toContain('out-of-range');
  });

  it('escapes user text (the profile name is not raw markup)', async () => {
    const out = await html({});
    expect(out).not.toContain('<b>Person</b>');
    expect(out).toContain('&lt;b&gt;Person&lt;/b&gt;');
  });

  it('renders localized tag chips for a tagged metric when tags are enabled', async () => {
    const out = await html({});
    // glucose is auto-tagged blood + diabetes → localized chip labels.
    expect(out).toContain('class="tag"');
    expect(out).toContain('>Blood<');
    expect(out).toContain('>Diabetes<');
  });

  it('renders no tag chips when tags are disabled', async () => {
    const out = await html({}, fixtureWithSettings({ useTags: false }));
    expect(out).not.toContain('class="tag"');
    expect(out).not.toContain('>Diabetes<');
  });

  it('honors metricIds — only the selected metric appears', async () => {
    const out = await html({ metricIds: ['builtin:glucose' as MetricId] });
    expect(out).toContain('Glucose');
    expect(out).not.toContain('CRP');
  });

  it('snapshot mode: a "State as of" title and one row per metric', async () => {
    const out = await html({ mode: 'snapshot', asOfIso: '2026-03-01' });
    expect(out).toContain('State as of');
    // Snapshot table carries a Source column header.
    expect(out).toContain('>Source<');
    // Both metrics have a value at/before the date.
    expect(out).toContain('Glucose');
    expect(out).toContain('CRP');
  });

  it('snapshot mode omits a metric with no value at the date', async () => {
    // As-of before CRP's Feb 20 measurement → CRP drops out; glucose (Jan 15) stays.
    const out = await html({ mode: 'snapshot', asOfIso: '2026-01-20' });
    expect(out).toContain('Glucose');
    expect(out).not.toContain('CRP');
  });

  it('snapshot mode adds a descriptive age note for values older than a year', async () => {
    // As-of far in the future → glucose (Jan 2026) is well over a year old.
    const out = await html({ mode: 'snapshot', asOfIso: '2028-06-01' });
    expect(out).toContain('months ago');
  });
});
