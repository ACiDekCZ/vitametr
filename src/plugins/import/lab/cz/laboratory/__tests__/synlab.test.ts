import { describe, expect, it } from 'vitest';

import { createCatalog } from '../../../../../../core/catalog.js';
import { CURRENT_SCHEMA_VERSION } from '../../../../../../core/types.js';
import type { ProfileData, ProfileId } from '../../../../../../core/types.js';
import { parseLabDocument } from '../../../../lab-parsers.js';
import { synlabParser } from '../synlab.js';

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

/** SYNLAB result sheet (fixture B). */
const SYNLAB_LINES: string[] = [
  'SYNLAB czech s.r.o.',
  'Laboratorní výsledky',
  'Pacient: Testovací Vzor · Datum odběru: 14.08.2023 · Materiál: sérum',
  'Analyt Výsledek Jednotka Referenční rozmezí',
  'Glukóza 5,1 mmol/l 3,9 - 5,6',
  'Cholesterol 4,8 mmol/l < 5,0',
  'Triglyceridy 1,2 mmol/l do 1,7',
  'HDL cholesterol 1,6 mmol/l nad 1,0',
  'CRP < 0,10 mg/l do 5,0',
  'Ferritin 120 ug/l 30 - 400',
  'TSH 2,4 mIU/l 0,27 - 4,20',
];

/** Standard Czech biochemistry sheet (fixture A) — not a SYNLAB sheet. */
const RESULT_LINES: string[] = [
  'Výsledkový list — biochemie',
  'Pacient: Testovací Vzor (nar. 1980) · Odběr: 10.02.2023 07:45 · Vzorek: sérum',
  'Vyšetření Výsledek Hodn. Jednotka Referenční meze',
  'Glukóza 5,4 mmol/l 3,9 - 5,6',
  'Cholesterol celkový 5,9 H mmol/l 0,0 - 5,0',
  'TSH 2,10 mIU/l 0,27 - 4,20',
];

describe('synlabParser', () => {
  it('detects a SYNLAB sheet by its header', () => {
    expect(synlabParser.detect(SYNLAB_LINES)).toBe(true);
  });

  it('does not detect a non-SYNLAB sheet', () => {
    expect(synlabParser.detect(RESULT_LINES)).toBe(false);
  });

  it('parses proposals from a SYNLAB sheet', () => {
    const proposals = synlabParser.parse(SYNLAB_LINES, catalog());
    expect(proposals.length).toBeGreaterThan(0);
    const crp = proposals.find((p) => p.rawText?.startsWith('CRP'))!;
    expect(crp.operator).toBe('<');
    expect(crp.value).toBeCloseTo(0.1, 9);
  });
});

describe('parseLabDocument routing', () => {
  it('routes a SYNLAB sheet to the synlab parser', () => {
    const result = parseLabDocument(SYNLAB_LINES, catalog());
    expect(result.parserId).toBe('synlab');
    expect(result.sourceName).toBe('SYNLAB');
    expect(result.proposals.length).toBeGreaterThan(0);
  });

  it('falls back to the generic parser for a non-SYNLAB sheet', () => {
    const result = parseLabDocument(RESULT_LINES, catalog());
    expect(result.parserId).toBe('generic');
  });
});
