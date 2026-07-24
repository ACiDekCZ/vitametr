import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createCatalog } from '../../../core/catalog.js';
import { CURRENT_SCHEMA_VERSION } from '../../../core/types.js';
import type { MetricId, ProfileData, ProfileId } from '../../../core/types.js';
import {
  appleHealthImportPlugin,
  parseAppleHealthExport,
  parseAppleHealthStream,
  pickExportEntry,
} from '../apple-health.js';
import { buildZip } from './zip.test.js';

/** A ReadableStream that enqueues `text` in fixed-size byte chunks (forces
 * chunk boundaries to fall mid-tag). */
function chunkedStream(text: string, chunkSize: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let pos = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pos >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(pos, pos + chunkSize));
      pos += chunkSize;
    },
  });
}

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

function loadFixture(name = 'export-sample.xml'): string {
  const path = fileURLToPath(
    new URL(`../../../../test/fixtures/sources/apple-health/${name}`, import.meta.url),
  );
  return readFileSync(path, 'utf8');
}

const CLOSE = 1e-9;

describe('parseAppleHealthExport', () => {
  it('maps BodyMass records to body-weight with unit, date and high confidence', () => {
    const proposals = parseAppleHealthExport(loadFixture(), catalog());
    const weights = proposals.filter(
      (p) => p.metric === ('builtin:body-weight' as MetricId),
    );
    expect(weights).toHaveLength(2);

    const first = weights[0];
    expect(first.value).toBeCloseTo(82.5, CLOSE);
    expect(first.unit).toBe('kg');
    expect(first.takenAt).toBe('2023-02-10T08:00:00');
    expect(first.timePrecision).toBe('datetime');
    expect(first.confidence).toBe('high');

    expect(weights[1].value).toBeCloseTo(81.9, CLOSE);
  });

  it('carries the sourceName attribute', () => {
    const proposals = parseAppleHealthExport(loadFixture(), catalog());
    const first = proposals.find(
      (p) => p.metric === ('builtin:body-weight' as MetricId),
    );
    expect(first?.sourceName).toBe('Scale');
  });

  it('maps systolic and diastolic blood pressure', () => {
    const proposals = parseAppleHealthExport(loadFixture(), catalog());
    const sys = proposals.find(
      (p) => p.metric === ('builtin:bp-systolic' as MetricId),
    );
    const dia = proposals.find(
      (p) => p.metric === ('builtin:bp-diastolic' as MetricId),
    );
    expect(sys?.value).toBeCloseTo(128, CLOSE);
    expect(sys?.unit).toBe('mm[Hg]');
    expect(dia?.value).toBeCloseTo(82, CLOSE);
    expect(dia?.unit).toBe('mm[Hg]');
  });

  it('maps heart rate with count/min -> /min', () => {
    const proposals = parseAppleHealthExport(loadFixture(), catalog());
    const hr = proposals.find(
      (p) => p.metric === ('builtin:heart-rate' as MetricId),
    );
    expect(hr?.value).toBeCloseTo(68, CLOSE);
    expect(hr?.unit).toBe('/min');
  });

  it('maps blood glucose with the angle-bracket encoded mmol<L> -> mmol/L', () => {
    const proposals = parseAppleHealthExport(loadFixture(), catalog());
    const glucose = proposals.find(
      (p) => p.metric === ('builtin:glucose' as MetricId),
    );
    expect(glucose?.value).toBeCloseTo(5.4, CLOSE);
    expect(glucose?.unit).toBe('mmol/L');
  });

  it('multiplies OxygenSaturation fraction by 100 to get a percentage', () => {
    const proposals = parseAppleHealthExport(loadFixture(), catalog());
    const spo2 = proposals.find((p) => p.metric === ('builtin:spo2' as MetricId));
    expect(spo2?.value).toBeCloseTo(98, CLOSE);
    expect(spo2?.unit).toBe('%');
  });

  it('maps body temperature with degC -> Cel', () => {
    const proposals = parseAppleHealthExport(loadFixture(), catalog());
    const temp = proposals.find(
      (p) => p.metric === ('builtin:body-temperature' as MetricId),
    );
    expect(temp?.value).toBeCloseTo(36.6, CLOSE);
    expect(temp?.unit).toBe('Cel');
  });

  it('skips unmapped HealthKit types (no proposal emitted)', () => {
    const xml =
      '<HealthData>' +
      '<Record type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" unit="count" value="1234" startDate="2023-02-10 08:00:00 +0100"/>' +
      '<Record type="HKQuantityTypeIdentifierBodyMass" sourceName="Scale" unit="kg" value="82.5" startDate="2023-02-10 08:00:00 +0100"/>' +
      '</HealthData>';
    const proposals = parseAppleHealthExport(xml, catalog());
    expect(proposals).toHaveLength(1);
    expect(proposals[0].metric).toBe('builtin:body-weight' as MetricId);
  });

  it('keeps the original record traceable in rawText', () => {
    const proposals = parseAppleHealthExport(loadFixture(), catalog());
    const first = proposals[0];
    expect(first.rawText).toContain('HKQuantityTypeIdentifierBodyMass');
    expect(first.rawText).toContain('82.5');
  });

  it('degrades gracefully on malformed input without throwing', () => {
    expect(parseAppleHealthExport('', catalog())).toEqual([]);
    expect(parseAppleHealthExport('<not-xml', catalog())).toEqual([]);
    expect(
      parseAppleHealthExport('<Record type="" value="x"/>', catalog()),
    ).toEqual([]);
  });
});

describe('appleHealthImportPlugin', () => {
  it('exposes the expected plugin metadata', () => {
    expect(appleHealthImportPlugin.id).toBe('apple-health');
    expect(appleHealthImportPlugin.nameKey).toBe('import.apple-health');
    expect(appleHealthImportPlugin.kind).toBe('file');
    expect(appleHealthImportPlugin.accepts).toContain('.xml');
    expect(appleHealthImportPlugin.accepts).toContain('application/xml');
    expect(appleHealthImportPlugin.accepts).toContain('text/xml');
  });

  it('parses a file input via File.text()', async () => {
    const file = new File([loadFixture()], 'export.xml', { type: 'application/xml' });
    const proposals = await appleHealthImportPlugin.parse(
      { kind: 'file', file },
      { catalog: catalog() },
    );
    // Eight mapped records in the fixture.
    expect(proposals).toHaveLength(8);
  });
});

describe('parseAppleHealthExport — a real-shaped export (vitals amid fitness noise)', () => {
  const proposals = parseAppleHealthExport(loadFixture('export-mixed.xml'), catalog());
  const keysOf = (id: string) => proposals.filter((p) => p.metric === (id as MetricId));

  it('maps only the vitals/home types and skips the high-volume fitness types', () => {
    // 8 mapped types (body weight appears twice) → 9 proposals; the 10 activity /
    // BMI / height / sleep records must contribute NOTHING.
    expect(proposals).toHaveLength(9);
    for (const id of [
      'builtin:body-weight',
      'builtin:bp-systolic',
      'builtin:bp-diastolic',
      'builtin:heart-rate',
      'builtin:glucose',
      'builtin:spo2',
      'builtin:body-temperature',
      'builtin:waist',
    ]) {
      expect(keysOf(id).length).toBeGreaterThan(0);
    }
    // Nothing unresolved / no stray proposal from StepCount, DistanceWalking, etc.
    expect(proposals.every((p) => typeof p.metric === 'string')).toBe(true);
  });

  it("decodes Apple's entity-encoded molar unit and the 0..1 SpO2 fraction", () => {
    const glucose = keysOf('builtin:glucose')[0];
    expect(glucose?.unit).toBe('mmol/L'); // from unit="mmol&lt;L&gt;"
    expect(glucose?.value).toBeCloseTo(5.2, CLOSE);
    const spo2 = keysOf('builtin:spo2')[0];
    expect(spo2?.value).toBeCloseTo(97, CLOSE); // 0.97 fraction -> 97 %
  });
});

describe('parseAppleHealthStream — streaming scan', () => {
  it('matches parseAppleHealthExport on export-mixed.xml, byte-for-byte', async () => {
    const xml = loadFixture('export-mixed.xml');
    const expected = parseAppleHealthExport(xml, catalog());
    // Stream in small chunks to force chunk boundaries mid-<Record>.
    const streamed = await parseAppleHealthStream(chunkedStream(xml, 17), catalog());
    expect(streamed).toEqual(expected);
    expect(streamed).toHaveLength(9);
  });

  it('reassembles <Record> tags split across chunk boundaries (1-byte chunks)', async () => {
    const xml = loadFixture('export-mixed.xml');
    const expected = parseAppleHealthExport(xml, catalog());
    const streamed = await parseAppleHealthStream(chunkedStream(xml, 1), catalog());
    expect(streamed).toEqual(expected);
  });

  it('handles a large generated input (50k+ records) across boundaries', async () => {
    // Build a big export mixing one mapped type with several unmapped ones.
    const mapped =
      '<Record type="HKQuantityTypeIdentifierBodyMass" sourceName="Scale" unit="kg" value="80" startDate="2025-01-01 08:00:00 +0100"/>';
    const noise = [
      '<Record type="HKQuantityTypeIdentifierStepCount" unit="count" value="100" startDate="2025-01-01 08:00:00 +0100"/>',
      '<Record type="HKQuantityTypeIdentifierDistanceWalkingRunning" unit="km" value="1" startDate="2025-01-01 08:00:00 +0100"/>',
    ];
    const N = 50_000;
    const parts: string[] = ['<HealthData locale="en_US">'];
    for (let i = 0; i < N; i += 1) {
      parts.push(mapped, noise[i % noise.length]);
    }
    parts.push('</HealthData>');
    const xml = parts.join('\n');

    const streamed = await parseAppleHealthStream(chunkedStream(xml, 64), catalog());
    // Exactly the N mapped BodyMass records; the 2N noise records contribute none.
    expect(streamed).toHaveLength(N);
    expect(streamed.every((p) => p.metric === ('builtin:body-weight' as MetricId))).toBe(true);
  });
});

describe('pickExportEntry', () => {
  const entry = (name: string) => ({
    name,
    method: 8,
    compressedSize: 1,
    uncompressedSize: 1,
    localHeaderOffset: 0,
  });

  it('prefers apple_health_export/export.xml and never picks export_cda.xml', () => {
    const picked = pickExportEntry([
      entry('apple_health_export/export_cda.xml'),
      entry('apple_health_export/export.xml'),
    ]);
    expect(picked?.name).toBe('apple_health_export/export.xml');
  });

  it('falls back to a bare export.xml, still never the CDA file', () => {
    expect(pickExportEntry([entry('export_cda.xml')])).toBeUndefined();
    expect(pickExportEntry([entry('export.xml')])?.name).toBe('export.xml');
  });
});

describe('appleHealthImportPlugin — ZIP input', () => {
  it('accepts .zip and extracts only export.xml, ignoring export_cda.xml', async () => {
    const xml = loadFixture('export-mixed.xml');
    const zip = await buildZip([
      {
        name: 'apple_health_export/export_cda.xml',
        data: new TextEncoder().encode('<ClinicalDocument/>'),
        method: 8,
      },
      { name: 'apple_health_export/export.xml', data: new TextEncoder().encode(xml), method: 8 },
    ]);
    const file = new File([await zip.arrayBuffer()], 'export.zip', { type: 'application/zip' });
    const proposals = await appleHealthImportPlugin.parse(
      { kind: 'file', file },
      { catalog: catalog() },
    );
    expect(proposals).toHaveLength(9);
    expect(appleHealthImportPlugin.accepts).toContain('.zip');
  });

  it('streams a raw .xml File through the streaming path', async () => {
    const file = new File([loadFixture('export-mixed.xml')], 'export.xml', {
      type: 'application/xml',
    });
    const proposals = await appleHealthImportPlugin.parse(
      { kind: 'file', file },
      { catalog: catalog() },
    );
    expect(proposals).toHaveLength(9);
  });
});
