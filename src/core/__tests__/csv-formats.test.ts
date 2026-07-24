import { describe, expect, it } from 'vitest';
import {
  buildProposals,
  detectFormats,
  parseCsv,
  type CsvMapping,
} from '../csv';
import { createCatalog } from '../catalog';
import type { ProfileData } from '../types';

function emptyProfile(): ProfileData {
  return {
    schemaVersion: 1,
    profile: { id: 'p' as never, name: 'p', createdAt: '2026-01-01T00:00:00.000Z' },
    metrics: [],
    sources: [],
    measurements: [],
    settings: {},
  };
}

const catalog = createCatalog(emptyProfile());

describe('detectFormats — decimal separator', () => {
  it('detects a comma decimal from Czech-style values', () => {
    const t = parseCsv('value;date\n5,4;10.02.2023\n3,2;11.02.2023');
    const mapping: CsvMapping = ['value', 'date'];
    expect(detectFormats(t, mapping).decimal).toBe(',');
  });

  it('detects a point decimal from ISO/US-style values', () => {
    const t = parseCsv('value,date\n5.4,2023-02-10\n3.2,2023-02-11');
    expect(detectFormats(t, ['value', 'date']).decimal).toBe('.');
  });

  it('treats the closest separator to the end as decimal (grouping vs decimal)', () => {
    const t = parseCsv('value,date\n"1,234.5",2023-02-10');
    expect(detectFormats(t, ['value', 'date']).decimal).toBe('.');
  });
});

describe('detectFormats — date order', () => {
  it('is ymd for ISO dates', () => {
    const t = parseCsv('value,date\n5.4,2023-02-10');
    expect(detectFormats(t, ['value', 'date']).dateOrder).toBe('ymd');
  });

  it('is dmy when a first component exceeds 12', () => {
    const t = parseCsv('value;date\n5,4;25.02.2023\n5,1;10.02.2023');
    expect(detectFormats(t, ['value', 'date']).dateOrder).toBe('dmy');
  });

  it('is mdy when a middle component exceeds 12', () => {
    const t = parseCsv('value,date\n5.4,02/25/2023\n5.1,02/10/2023');
    expect(detectFormats(t, ['value', 'date']).dateOrder).toBe('mdy');
  });

  it('is ambiguous when every component is <= 12', () => {
    const t = parseCsv('value,date\n5.4,01/02/2023\n5.1,03/04/2023');
    expect(detectFormats(t, ['value', 'date']).dateOrder).toBe('ambiguous');
  });
});

describe('buildProposals with explicit formats', () => {
  const mapping: CsvMapping = ['metric', 'value', 'date'];

  it('reads an ambiguous date as day-first when told dmy', () => {
    const t = parseCsv('metric,value,date\nGlucose,5.4,01/02/2023');
    const [p] = buildProposals(t, mapping, catalog, { decimal: '.', dateOrder: 'dmy' });
    expect(p.takenAt?.startsWith('2023-02-01')).toBe(true);
  });

  it('reads the same date as month-first when told mdy', () => {
    const t = parseCsv('metric,value,date\nGlucose,5.4,01/02/2023');
    const [p] = buildProposals(t, mapping, catalog, { decimal: '.', dateOrder: 'mdy' });
    expect(p.takenAt?.startsWith('2023-01-02')).toBe(true);
  });

  it('honors a comma decimal so 1,5 is one and a half', () => {
    const t = parseCsv('metric;value;date\nGlucose;1,5;10.02.2023');
    const [p] = buildProposals(t, ['metric', 'value', 'date'], catalog, {
      decimal: ',',
      dateOrder: 'dmy',
    });
    expect(p.value).toBeCloseTo(1.5, 6);
  });

  it('rejects an impossible date under the chosen order (no silent misread)', () => {
    // 25 as month is invalid under mdy → no date, lower confidence, goes to review.
    const t = parseCsv('metric,value,date\nGlucose,5.4,25/02/2023');
    const [p] = buildProposals(t, mapping, catalog, { decimal: '.', dateOrder: 'mdy' });
    expect(p.takenAt).toBeUndefined();
  });
});
