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
  SourceId,
} from '../../core/types.js';
import type { ExportContext } from '../../core/contracts.js';
import { csvExportPlugin } from '../export/csv.js';

const SRC = 'src-lab' as SourceId;

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
    sources: [{ id: SRC, name: 'Synlab', kind: 'lab' }],
    measurements: [
      base({ id: 'a' as MeasurementId, value: 5.4, sourceId: SRC }),
      base({
        id: 'b' as MeasurementId,
        metricId: 'builtin:crp' as MetricId,
        value: 0.1,
        operator: '<',
        unit: 'mg/L',
        takenAt: '2026-02-20',
        refLow: 0,
        refHigh: 5,
        note: 'note; with delimiter and "quote"',
        sourceId: SRC,
      }),
    ],
    settings: {},
  };
}

function ctxFor(locale: 'cs' | 'en', useTags?: boolean): ExportContext {
  const data = fixture();
  if (useTags !== undefined) data.settings = { useTags };
  return { data, catalog: createCatalog(data), units: createUnitsEngine(), locale };
}

async function lines(
  locale: 'cs' | 'en',
  useTags?: boolean,
): Promise<{ text: string; rows: string[] }> {
  const blob = await csvExportPlugin.export({}, ctxFor(locale, useTags));
  const text = await blob.text();
  return { text, rows: text.split('\r\n') };
}

describe('csv export', () => {
  it('emits a UTF-8 BOM', async () => {
    // Blob.text() decodes UTF-8 and strips a leading BOM, so inspect raw bytes.
    const blob = await csvExportPlugin.export({}, ctxFor('cs'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('uses ";" and a decimal comma for Czech', async () => {
    const { rows } = await lines('cs');
    const header = rows[0].replace(/^﻿/, '');
    expect(header).toBe('metric;value;unit;operator;takenAt;refLow;refHigh;source;note;tags');
    // glucose row: name translated, value 5,4, tags 'blood diabetes' in the trailing column
    expect(rows[1]).toBe('Glukóza;5,4;mmol/L;;2026-01-15;;;Synlab;;blood diabetes');
  });

  it('uses "," and a decimal point for English', async () => {
    const { rows } = await lines('en');
    const header = rows[0].replace(/^﻿/, '');
    expect(header).toBe('metric,value,unit,operator,takenAt,refLow,refHigh,source,note,tags');
    expect(rows[1]).toBe('Glucose,5.4,mmol/L,,2026-01-15,,,Synlab,,blood diabetes');
  });

  it('snapshot mode: one row per metric with a "# stav k" metadata line first', async () => {
    // Two glucose measurements → snapshot keeps only the latest at/before the date.
    const data = fixture();
    data.measurements.push(
      base({ id: 'a2' as MeasurementId, value: 6.1, takenAt: '2026-03-10', sourceId: SRC }),
    );
    const ctx: ExportContext = {
      data,
      catalog: createCatalog(data),
      units: createUnitsEngine(),
      locale: 'en',
    };
    const blob = await csvExportPlugin.export(
      { mode: 'snapshot', asOfIso: '2026-02-25' },
      ctx,
    );
    const rows = (await blob.text()).split('\r\n');
    expect(rows[0].replace(/^﻿/, '')).toBe('# stav k 2026-02-25');
    expect(rows[1].replace(/^﻿/, '')).toBe(
      'metric,value,unit,operator,takenAt,refLow,refHigh,source,note,tags',
    );
    // glucose latest ≤ date is the Jan 15 value (5.4), not the Mar 10 one.
    const body = rows.slice(2).filter((r) => r.length > 0);
    const glucose = body.find((r) => r.startsWith('Glucose'));
    expect(glucose).toContain('Glucose,5.4,mmol/L,,2026-01-15');
    // CRP measured Feb 20 ≤ date → present; exactly one glucose + one crp row.
    expect(body).toHaveLength(2);
  });

  it('renders operator and reference ranges', async () => {
    const { rows } = await lines('en');
    // crp row: operator '<', refLow 0, refHigh 5
    expect(rows[2].startsWith('CRP,0.1,mg/L,<,2026-02-20,0,5,Synlab,')).toBe(true);
  });

  it('quotes fields containing the delimiter or a quote (RFC 4180)', async () => {
    // In Czech the note contains ';' (the delimiter) and a '"'; the quoted note is
    // followed by the trailing tags column (crp → 'blood').
    const { rows } = await lines('cs');
    expect(rows[2].endsWith('"note; with delimiter and ""quote""";blood')).toBe(true);
  });

  it('appends a "tags" column with the metric tags when tags are enabled', async () => {
    const { rows } = await lines('en', true);
    const header = rows[0].replace(/^﻿/, '');
    expect(header.endsWith(',tags')).toBe(true);
    // glucose is tagged blood + diabetes (space-joined in one cell)
    expect(rows[1].endsWith(',blood diabetes')).toBe(true);
  });

  it('omits the tags column entirely when tags are disabled', async () => {
    const { rows } = await lines('en', false);
    const header = rows[0].replace(/^﻿/, '');
    expect(header).toBe('metric,value,unit,operator,takenAt,refLow,refHigh,source,note');
    // Row is unchanged from the base format — no trailing tags cell.
    expect(rows[1]).toBe('Glucose,5.4,mmol/L,,2026-01-15,,,Synlab,');
  });
});
