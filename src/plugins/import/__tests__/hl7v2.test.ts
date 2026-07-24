import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createCatalog } from '../../../core/catalog.js';
import { CURRENT_SCHEMA_VERSION } from '../../../core/types.js';
import type { MetricId, ProfileData, ProfileId } from '../../../core/types.js';
import { hl7v2ImportPlugin, parseHl7Oru } from '../hl7v2.js';

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

function loadMessage(): string {
  const path = fileURLToPath(
    new URL('../../../../test/fixtures/sources/hl7v2/oru-sample.hl7', import.meta.url),
  );
  return readFileSync(path, 'utf8');
}

const CLOSE = 9;

describe('parseHl7Oru', () => {
  it('yields one proposal per numeric OBX in the message', () => {
    const proposals = parseHl7Oru(loadMessage(), catalog());
    // Glucose, Cholesterol total, LDL, Creatinine, TSH — all NM.
    expect(proposals).toHaveLength(5);
  });

  it('resolves glucose (LOINC 2345-7) with unit, reference range and OBR-7 date', () => {
    const proposals = parseHl7Oru(loadMessage(), catalog());
    const glucose = proposals[0];
    expect(glucose.metric).toBe('builtin:glucose' as MetricId);
    expect(glucose.value).toBeCloseTo(5.4, CLOSE);
    expect(glucose.unit).toBe('mmol/L');
    expect(glucose.refLow).toBeCloseTo(3.9, CLOSE);
    expect(glucose.refHigh).toBeCloseTo(5.6, CLOSE);
    // OBR-7 '20230210074500' -> full datetime with seconds.
    expect(glucose.takenAt).toBe('2023-02-10T07:45:00');
    expect(glucose.timePrecision).toBe('datetime');
    expect(glucose.confidence).toBe('high');
  });

  it('resolves total cholesterol (2093-3) with a "0-5.0" range', () => {
    const proposals = parseHl7Oru(loadMessage(), catalog());
    const chol = proposals[1];
    expect(chol.metric).toBe('builtin:total-cholesterol' as MetricId);
    expect(chol.refLow).toBeCloseTo(0, CLOSE);
    expect(chol.refHigh).toBeCloseTo(5.0, CLOSE);
  });

  it('resolves creatinine (2160-0) with unit umol/L', () => {
    const proposals = parseHl7Oru(loadMessage(), catalog());
    const crea = proposals[3];
    expect(crea.metric).toBe('builtin:creatinine' as MetricId);
    expect(crea.unit).toBe('umol/L');
  });

  it('resolves TSH (3016-3), normalizing mIU/L to m[IU]/L', () => {
    const proposals = parseHl7Oru(loadMessage(), catalog());
    const tsh = proposals[4];
    expect(tsh.metric).toBe('builtin:tsh' as MetricId);
    expect(tsh.unit).toBe('m[IU]/L');
  });

  it('keeps the original OBX line traceable in rawText', () => {
    const proposals = parseHl7Oru(loadMessage(), catalog());
    expect(proposals[0].rawText).toContain('2345-7');
    expect(proposals[0].rawText).toContain('5.4');
  });

  it('parses a one-sided "<X" reference range into refHigh only', () => {
    const message = [
      'MSH|^~\\&|LIS|Lab|EHR|Clinic|20230210084500||ORU^R01|M1|P|2.5.1',
      'OBR|1||ORD1|panel^Panel^LN|||20230210074500',
      'OBX|1|NM|3016-3^TSH^LN||2.1|mIU/L|<4.2|N|||F',
    ].join('\n');
    const proposals = parseHl7Oru(message, catalog());
    expect(proposals).toHaveLength(1);
    expect(proposals[0].refLow).toBeUndefined();
    expect(proposals[0].refHigh).toBeCloseTo(4.2, CLOSE);
  });

  it('captures a censoring operator from OBX-5', () => {
    const message = [
      'MSH|^~\\&|LIS|Lab|EHR|Clinic|20230210084500||ORU^R01|M1|P|2.5.1',
      'OBR|1||ORD1|panel^Panel^LN|||20230210074500',
      'OBX|1|NM|3016-3^TSH^LN||<0.01|mIU/L|0.27-4.2|L|||F',
    ].join('\n');
    const proposals = parseHl7Oru(message, catalog());
    expect(proposals[0].operator).toBe('<');
    expect(proposals[0].value).toBeCloseTo(0.01, CLOSE);
  });

  it('prefers OBX-14 over the message datetime when present', () => {
    const message = [
      'MSH|^~\\&|LIS|Lab|EHR|Clinic|20230210084500||ORU^R01|M1|P|2.5.1',
      'OBR|1||ORD1|panel^Panel^LN|||20230210074500',
      'OBX|1|NM|2345-7^Glucose^LN||5.4|mmol/L|3.9-5.6|N|||F|||20221101093000',
    ].join('\n');
    const proposals = parseHl7Oru(message, catalog());
    expect(proposals[0].takenAt).toBe('2022-11-01T09:30:00');
  });

  it('falls back to MSH-7 (date only) when OBR-7 is absent', () => {
    const message = [
      'MSH|^~\\&|LIS|Lab|EHR|Clinic|20230210||ORU^R01|M1|P|2.5.1',
      'OBR|1||ORD1|panel^Panel^LN',
      'OBX|1|NM|2345-7^Glucose^LN||5.4|mmol/L|3.9-5.6|N|||F',
    ].join('\n');
    const proposals = parseHl7Oru(message, catalog());
    expect(proposals[0].takenAt).toBe('2023-02-10');
    expect(proposals[0].timePrecision).toBe('date');
  });

  it('skips non-numeric OBX value types (TX produces no proposal)', () => {
    const message = [
      'MSH|^~\\&|LIS|Lab|EHR|Clinic|20230210084500||ORU^R01|M1|P|2.5.1',
      'OBR|1||ORD1|panel^Panel^LN|||20230210074500',
      'OBX|1|TX|11529-5^Report^LN||Sample slightly hemolyzed|||||F',
      'OBX|2|NM|2345-7^Glucose^LN||5.4|mmol/L|3.9-5.6|N|||F',
    ].join('\n');
    const proposals = parseHl7Oru(message, catalog());
    expect(proposals).toHaveLength(1);
    expect(proposals[0].metric).toBe('builtin:glucose' as MetricId);
  });

  it('leaves an unknown LOINC unresolved with low confidence', () => {
    const message = [
      'MSH|^~\\&|LIS|Lab|EHR|Clinic|20230210084500||ORU^R01|M1|P|2.5.1',
      'OBR|1||ORD1|panel^Panel^LN|||20230210074500',
      'OBX|1|NM|99999-9^Mystery analyte^LN||1.23|mmol/L|0-2|N|||F',
    ].join('\n');
    const proposals = parseHl7Oru(message, catalog());
    expect(proposals).toHaveLength(1);
    expect(proposals[0].metric).toEqual({ unresolvedName: 'Mystery analyte' });
    expect(proposals[0].confidence).toBe('low');
  });

  it('resolves a non-LOINC coding system via the text alias', () => {
    const message = [
      'MSH|^~\\&|LIS|Lab|EHR|Clinic|20230210084500||ORU^R01|M1|P|2.5.1',
      'OBR|1||ORD1|panel^Panel^LN|||20230210074500',
      'OBX|1|NM|GLU^Glucose^L||5.4|mmol/L|3.9-5.6|N|||F',
    ].join('\n');
    const proposals = parseHl7Oru(message, catalog());
    expect(proposals[0].metric).toBe('builtin:glucose' as MetricId);
  });

  it('degrades gracefully on malformed input without throwing', () => {
    expect(parseHl7Oru('', catalog())).toEqual([]);
    expect(parseHl7Oru('not a hl7 message at all', catalog())).toEqual([]);
    expect(parseHl7Oru('OBX|1|NM', catalog())).toEqual([]);
  });

  it('splits segments on CR, LF or CRLF', () => {
    const message =
      'MSH|^~\\&|LIS|Lab|EHR|Clinic|20230210084500||ORU^R01|M1|P|2.5.1\r' +
      'OBR|1||ORD1|panel^Panel^LN|||20230210074500\r\n' +
      'OBX|1|NM|2345-7^Glucose^LN||5.4|mmol/L|3.9-5.6|N|||F\n';
    const proposals = parseHl7Oru(message, catalog());
    expect(proposals).toHaveLength(1);
  });
});

describe('hl7v2ImportPlugin', () => {
  it('exposes the expected plugin metadata', () => {
    expect(hl7v2ImportPlugin.id).toBe('hl7v2');
    expect(hl7v2ImportPlugin.nameKey).toBe('import.hl7v2');
    expect(hl7v2ImportPlugin.kind).toBe('file');
    expect(hl7v2ImportPlugin.accepts).toContain('.hl7');
    expect(hl7v2ImportPlugin.accepts).toContain('application/hl7-v2');
  });

  it('parses a file input via File.text()', async () => {
    const file = new File([loadMessage()], 'oru.hl7', { type: 'application/hl7-v2' });
    const proposals = await hl7v2ImportPlugin.parse(
      { kind: 'file', file },
      { catalog: catalog() },
    );
    expect(proposals).toHaveLength(5);
    expect(proposals[0].metric).toBe('builtin:glucose' as MetricId);
  });
});
