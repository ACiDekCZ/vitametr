import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildProposals, guessMapping, isMappingComplete, parseCsv } from '../csv';
import type { CsvMapping, CsvTable } from '../csv';
import { createCatalog } from '../catalog';
import { CURRENT_SCHEMA_VERSION } from '../types';
import type { MetricId, ProfileData, ProfileId } from '../types';
import type { Catalog } from '../contracts';

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

function fixture(name: string): string {
  return readFileSync(new URL(`../../../test/fixtures/${name}`, import.meta.url), 'utf8');
}

const SYNTHEA = fixture('synthea-observations.csv');
const LAB_CS = fixture('labs/cz/lab-cs-semicolon.csv');

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

function catalog(): Catalog {
  return createCatalog(emptyProfile());
}

// ---------------------------------------------------------------------------
// parseCsv
// ---------------------------------------------------------------------------

describe('parseCsv', () => {
  it('parses comma-delimited text', () => {
    const t = parseCsv('a,b,c\n1,2,3');
    expect(t.delimiter).toBe(',');
    expect(t.headers).toEqual(['a', 'b', 'c']);
    expect(t.rows).toEqual([['1', '2', '3']]);
  });

  it('auto-detects the semicolon delimiter', () => {
    const t = parseCsv('a;b;c\n1;2;3');
    expect(t.delimiter).toBe(';');
    expect(t.headers).toEqual(['a', 'b', 'c']);
    expect(t.rows).toEqual([['1', '2', '3']]);
  });

  it('auto-detects the tab delimiter', () => {
    const t = parseCsv('a\tb\tc\n1\t2\t3');
    expect(t.delimiter).toBe('\t');
    expect(t.headers).toEqual(['a', 'b', 'c']);
    expect(t.rows).toEqual([['1', '2', '3']]);
  });

  it('handles a quoted field containing the delimiter and an escaped ""', () => {
    const t = parseCsv('name,note\n"Smith, John","He said ""hi"""');
    expect(t.headers).toEqual(['name', 'note']);
    expect(t.rows).toEqual([['Smith, John', 'He said "hi"']]);
  });

  it('handles a quoted field containing a newline', () => {
    const t = parseCsv('a,b\n"line1\nline2",x');
    expect(t.rows).toEqual([['line1\nline2', 'x']]);
  });

  it('treats CRLF and LF line endings the same', () => {
    const lf = parseCsv('a,b\n1,2\n3,4');
    const crlf = parseCsv('a,b\r\n1,2\r\n3,4');
    expect(crlf.headers).toEqual(lf.headers);
    expect(crlf.rows).toEqual(lf.rows);
    expect(crlf.rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('returns an empty table for empty input', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [], delimiter: ',' });
  });

  it('pads a short row and truncates a long row to the header width', () => {
    const t = parseCsv('a,b,c\n1,2\n4,5,6,7');
    expect(t.rows).toEqual([
      ['1', '2', ''],
      ['4', '5', '6'],
    ]);
  });

  it('parses the Synthea fixture with a comma delimiter', () => {
    const t = parseCsv(SYNTHEA);
    expect(t.delimiter).toBe(',');
    expect(t.headers).toEqual(['PATIENT', 'DATE', 'CODE', 'DESCRIPTION', 'VALUE', 'UNITS', 'TYPE']);
    expect(t.rows).toHaveLength(11);
  });

  it('parses the Czech fixture with a semicolon delimiter', () => {
    const t = parseCsv(LAB_CS);
    expect(t.delimiter).toBe(';');
    expect(t.headers).toHaveLength(8);
    expect(t.rows).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// guessMapping
// ---------------------------------------------------------------------------

describe('guessMapping', () => {
  it('recognizes the Synthea header', () => {
    const { headers } = parseCsv(SYNTHEA);
    expect(guessMapping(headers)).toEqual([
      undefined, // PATIENT
      'date', // DATE
      'loinc', // CODE
      'metric', // DESCRIPTION
      'value', // VALUE
      'unit', // UNITS
      undefined, // TYPE
    ]);
  });

  it('recognizes the Czech header (diacritics-insensitive)', () => {
    const { headers } = parseCsv(LAB_CS);
    expect(guessMapping(headers)).toEqual([
      'metric', // Veličina
      'value', // Hodnota
      'unit', // Jednotka
      'date', // Datum
      'refLow', // Dolní mez
      'refHigh', // Horní mez
      'source', // Zdroj
      'note', // Poznámka
    ]);
  });

  it('leaves unmatched headers undefined and maps a field only once', () => {
    const mapping = guessMapping(['value', 'hodnota', 'random']);
    expect(mapping).toEqual(['value', undefined, undefined]);
  });
});

// ---------------------------------------------------------------------------
// isMappingComplete
// ---------------------------------------------------------------------------

describe('isMappingComplete', () => {
  it('is true for both fixtures guessed mappings', () => {
    expect(isMappingComplete(guessMapping(parseCsv(SYNTHEA).headers))).toBe(true);
    expect(isMappingComplete(guessMapping(parseCsv(LAB_CS).headers))).toBe(true);
  });

  it('accepts metric+value+date without a loinc column', () => {
    const m: CsvMapping = ['metric', 'value', 'date'];
    expect(isMappingComplete(m)).toBe(true);
  });

  it('accepts loinc+value+date without a metric column', () => {
    const m: CsvMapping = ['loinc', 'value', 'date'];
    expect(isMappingComplete(m)).toBe(true);
  });

  it('is false when the value column is missing', () => {
    expect(isMappingComplete(['metric', 'date'])).toBe(false);
  });

  it('is false when the date column is missing', () => {
    expect(isMappingComplete(['metric', 'value'])).toBe(false);
  });

  it('is false when neither metric nor loinc is mapped', () => {
    expect(isMappingComplete(['value', 'date', 'unit'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildProposals — Synthea (LOINC-based)
// ---------------------------------------------------------------------------

describe('buildProposals: synthea-observations.csv', () => {
  const cat = catalog();
  const table = parseCsv(SYNTHEA);
  const mapping = guessMapping(table.headers);
  const proposals = buildProposals(table, mapping, cat);

  it('confirms which LOINC codes exist in the catalog', () => {
    // Glucose in our catalog is 2345-7, so Synthea's 2339-0 does NOT resolve.
    expect(cat.byLoinc('2339-0')).toBeUndefined();
    expect(cat.byLoinc('2093-3')?.key).toBe('total-cholesterol');
    expect(cat.byLoinc('13457-7')?.key).toBe('ldl-cholesterol');
    expect(cat.byLoinc('4548-4')?.key).toBe('hba1c');
    expect(cat.byLoinc('718-7')?.key).toBe('hemoglobin');
  });

  it('produces one proposal per data row', () => {
    expect(proposals).toHaveLength(11);
  });

  it('leaves the unknown glucose LOINC (2339-0) unresolved', () => {
    expect(proposals[0].metric).toEqual({
      unresolvedName: 'Glucose [Mass/volume] in Blood',
    });
    expect(proposals[0].confidence).toBe('low');
  });

  it('resolves rows whose LOINC is in the catalog', () => {
    expect(proposals[1].metric).toBe(cat.byLoinc('2093-3')!.id); // total cholesterol
    expect(proposals[2].metric).toBe(cat.byLoinc('13457-7')!.id); // LDL
    expect(proposals[4].metric).toBe(cat.byLoinc('4548-4')!.id); // HbA1c
    expect(proposals[9].metric).toBe(cat.byLoinc('718-7')!.id); // hemoglobin
  });

  it('parses dates to ISO and normalizes units', () => {
    expect(proposals[0].takenAt).toBe('2023-02-10T08:15');
    expect(proposals[0].timePrecision).toBe('datetime');
    expect(proposals[1].unit).toBe('mg/dL');
    expect(proposals[4].unit).toBe('%');
    expect(proposals[9].unit).toBe('g/dL');
  });

  it('marks a fully-resolved row as high confidence', () => {
    expect(proposals[1].confidence).toBe('high');
    expect(proposals[1].value).toBeCloseTo(193, 6);
  });

  it('preserves the original row as rawText', () => {
    expect(proposals[0].rawText).toBe(
      'p1,2023-02-10T08:15:00Z,2339-0,Glucose [Mass/volume] in Blood,95,mg/dL,numeric',
    );
  });
});

// ---------------------------------------------------------------------------
// buildProposals — Czech lab (name-based)
// ---------------------------------------------------------------------------

describe('buildProposals: lab-cs-semicolon.csv', () => {
  const cat = catalog();
  const table = parseCsv(LAB_CS);
  const mapping = guessMapping(table.headers);
  const proposals = buildProposals(table, mapping, cat);

  it('produces one proposal per data row', () => {
    expect(proposals).toHaveLength(7);
  });

  it('resolves metric names via resolveAlias', () => {
    expect(proposals[0].metric).toBe(cat.resolveAlias('Glukóza')!.id);
    expect(proposals[1].metric).toBe(cat.resolveAlias('LDL cholesterol')!.id);
    expect(proposals[2].metric).toBe(cat.resolveAlias('Kreatinin')!.id);
  });

  it('parses a decimal comma and DD.MM.YYYY dates', () => {
    expect(proposals[0].value).toBeCloseTo(5.4, 6);
    expect(proposals[0].takenAt).toBe('2023-02-10');
    expect(proposals[0].timePrecision).toBe('date');
  });

  it('normalizes µmol/l to the umol/L code', () => {
    expect(proposals[2].unit).toBe('umol/L');
  });

  it('parses reference bounds', () => {
    expect(proposals[0].refLow).toBeCloseTo(3.9, 6);
    expect(proposals[0].refHigh).toBeCloseTo(5.6, 6);
  });

  it('captures source and note, dropping empty notes', () => {
    expect(proposals[0].sourceName).toBe('Synlab Praha');
    expect(proposals[0].note).toBe('nalačno');
    expect(proposals[1].note).toBeUndefined();
  });

  it('recognizes the TSH unit mIU/l and keeps the row high confidence', () => {
    expect(proposals[5].metric).toBe(cat.resolveAlias('TSH')!.id);
    expect(proposals[5].unit).toBe('m[IU]/L');
    expect(proposals[5].confidence).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// buildProposals — edge cases
// ---------------------------------------------------------------------------

describe('buildProposals: edge cases', () => {
  it('leaves an unknown metric name unresolved and low confidence', () => {
    const table: CsvTable = {
      headers: ['metric', 'value', 'date'],
      rows: [['Nonexistent Analyte', '1.2', '2026-07-21']],
      delimiter: ',',
    };
    const mapping: CsvMapping = ['metric', 'value', 'date'];
    const proposals = buildProposals(table, mapping, catalog());
    expect(proposals).toHaveLength(1);
    expect(proposals[0].metric).toEqual({ unresolvedName: 'Nonexistent Analyte' });
    expect(proposals[0].confidence).toBe('low');
  });

  it('drops rows whose value cell is empty or not a number', () => {
    const table: CsvTable = {
      headers: ['metric', 'value', 'date'],
      rows: [
        ['Glukóza', '', '2026-07-21'],
        ['Glukóza', 'abc', '2026-07-21'],
        ['Glukóza', '5.4', '2026-07-21'],
      ],
      delimiter: ',',
    };
    const mapping: CsvMapping = ['metric', 'value', 'date'];
    const proposals = buildProposals(table, mapping, catalog());
    expect(proposals).toHaveLength(1);
    expect(proposals[0].value).toBeCloseTo(5.4, 6);
  });

  it('captures a censoring operator from the value cell', () => {
    const table: CsvTable = {
      headers: ['metric', 'value', 'date'],
      rows: [['CRP', '< 0.1', '2026-07-21']],
      delimiter: ',',
    };
    const proposals = buildProposals(table, ['metric', 'value', 'date'], catalog());
    expect(proposals[0].value).toBeCloseTo(0.1, 6);
    expect(proposals[0].operator).toBe('<');
  });

  it('returns no proposals when no value column is mapped', () => {
    const table: CsvTable = {
      headers: ['metric', 'date'],
      rows: [['Glukóza', '2026-07-21']],
      delimiter: ',',
    };
    expect(buildProposals(table, ['metric', 'date'], catalog())).toEqual([]);
  });

  it('resolves via LOINC even when a metric name column also exists', () => {
    const table: CsvTable = {
      headers: ['loinc', 'metric', 'value', 'date'],
      rows: [['2093-3', 'anything at all', '4.9', '2026-07-21']],
      delimiter: ',',
    };
    const cat = catalog();
    const proposals = buildProposals(table, ['loinc', 'metric', 'value', 'date'], cat);
    expect(proposals[0].metric).toBe(cat.byLoinc('2093-3')!.id);
  });
});
