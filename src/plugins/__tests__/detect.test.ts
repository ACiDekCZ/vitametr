import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { detectFromText, detectFormat, isZip, type DetectedFormat } from '../detect.js';
import { buildZip } from '../import/__tests__/zip.test.js';

/** Head of a committed fixture as text (mirrors what the browser reads). */
function head(path: string): string {
  return readFileSync(new URL(`../../../${path}`, import.meta.url)).toString('latin1').slice(0, 64 * 1024);
}

/** Wrap bytes as a File (ArrayBuffer-backed) so the async path is covered too. */
function fileFromBytes(bytes: Buffer, name: string): File {
  const copy = new Uint8Array(new ArrayBuffer(bytes.length));
  copy.set(bytes);
  return new File([copy], name);
}

describe('detectFromText — signatures', () => {
  it('detects a PDF by its header', () => {
    expect(detectFromText('%PDF-1.7\n...', 'x.pdf')).toBe('pdf');
  });

  it('detects an encrypted PDF (header survives encryption)', () => {
    expect(detectFromText(head('test/fixtures/labs/foreign/lab-en-chemistry-encrypted.pdf'))).toBe('pdf');
  });

  it('detects HL7 v2 by the MSH segment', () => {
    expect(detectFromText('MSH|^~\\&|LAB|...\rPID|...', 'msg.txt')).toBe('hl7v2');
  });

  it('detects Apple Health export.xml', () => {
    expect(
      detectFromText('<?xml version="1.0"?>\n<!DOCTYPE HealthData>\n<HealthData locale="en">', 'export.xml'),
    ).toBe('apple-health');
  });

  it('detects a FHIR bundle (JSON) by resourceType', () => {
    expect(detectFromText(head('test/fixtures/fhir-bundle.json'), 'bundle.json')).toBe('fhir');
    expect(detectFromText('{\n  "resourceType": "Bundle",', 'b.json')).toBe('fhir');
  });

  it('detects a Vitametr backup (plain and encrypted)', () => {
    expect(detectFromText('{\n  "format": "vitametr-backup",', 'b.json')).toBe('json-backup');
    expect(detectFromText('{ "format": "vitametr-backup-encrypted", "ciphertext": "..." }', 'b.json')).toBe(
      'json-backup',
    );
  });

  it('detects CSV by a delimited header line', () => {
    expect(detectFromText(head('test/fixtures/labs/cz/lab-cs-semicolon.csv'), 'labs.csv')).toBe('csv');
    expect(detectFromText('date,metric,value\n2026-01-01,Glucose,5.2', 'x.csv')).toBe('csv');
  });

  it('prefers a Vitametr backup over the generic resourceType check', () => {
    // A backup that happened to mention resourceType in a note must still be a backup.
    expect(
      detectFromText('{ "format": "vitametr-backup", "note": "resourceType: x" }', 'b.json'),
    ).toBe('json-backup');
  });
});

describe('detectFromText — refusals (no wrong guess)', () => {
  it('returns undefined for unknown JSON', () => {
    expect(detectFromText('{ "hello": "world" }', 'x.json')).toBeUndefined();
  });

  it('returns undefined for unknown XML', () => {
    expect(detectFromText('<?xml version="1.0"?><foo/>', 'x.xml')).toBe('apple-health'); // .xml hint
    expect(detectFromText('<?xml version="1.0"?><foo/>', 'x.dat')).toBeUndefined();
  });

  it('returns undefined for free text with no delimiters', () => {
    expect(detectFromText('just some prose without structure', 'notes.txt')).toBeUndefined();
  });
});

describe('detectFromText — declarative import mappings', () => {
  const mappings = [{ id: 'm', sourceName: 'VZOR', detect: { anyOf: ['VZOR-LAB'] }, pattern: '(?<name>.+)' }];

  it('routes matching text to lab-text (before the CSV heuristic)', () => {
    // A ';'-separated sheet would otherwise look like CSV — the mapping wins.
    const text = 'VZOR-LAB 2026-03-15; Glukóza: 5,4 mmol/l (3,9-5,6)';
    expect(detectFromText(text, 'sheet.txt', mappings)).toBe('lab-text');
    // Without the mapping, the same text is treated as CSV (unchanged behaviour).
    expect(detectFromText(text, 'sheet.txt')).toBe('csv');
  });

  it('ignores mappings that do not match', () => {
    expect(detectFromText('unrelated prose', 'notes.txt', mappings)).toBeUndefined();
  });
});

describe('detectFormat — async file path', () => {
  it('classifies real fixture files', async () => {
    const cases: Array<[string, DetectedFormat]> = [
      ['test/fixtures/labs/foreign/lab-en-chemistry.pdf', 'pdf'],
      ['test/fixtures/fhir-bundle.json', 'fhir'],
      ['test/fixtures/labs/cz/lab-cs-semicolon.csv', 'csv'],
    ];
    for (const [path, expected] of cases) {
      const bytes = readFileSync(new URL(`../../../${path}`, import.meta.url));
      const f = fileFromBytes(bytes, path.split('/').pop()!);
      expect(await detectFormat(f)).toBe(expected);
    }
  });
});

describe('detectFormat — ZIP archives', () => {
  async function zipFile(entries: Parameters<typeof buildZip>[0], name = 'archive.zip'): Promise<File> {
    const blob = await buildZip(entries);
    return new File([await blob.arrayBuffer()], name, { type: 'application/zip' });
  }

  it('detects an Apple Health export .zip as apple-health', async () => {
    const f = await zipFile([
      { name: 'apple_health_export/export_cda.xml', data: new TextEncoder().encode('<x/>'), method: 8 },
      { name: 'apple_health_export/export.xml', data: new TextEncoder().encode('<HealthData/>'), method: 8 },
    ], 'export.zip');
    expect(await isZip(f)).toBe(true);
    expect(await detectFormat(f)).toBe('apple-health');
  });

  it('returns undefined for a generic zip (router decides on extraction)', async () => {
    const f = await zipFile([
      { name: 'labs.csv', data: new TextEncoder().encode('date,metric\n2026-01-01,Glucose'), method: 8 },
    ]);
    expect(await detectFormat(f)).toBeUndefined();
  });
});
