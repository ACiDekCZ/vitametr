import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { createCatalog } from '../../../core/catalog.js';
import { CURRENT_SCHEMA_VERSION } from '../../../core/types.js';
import type { ImportMappingDef, MetricId, ProfileData, ProfileId } from '../../../core/types.js';
import { declarativeLabParser } from '../declarative-lab.js';
import { parseLabDocument } from '../lab-parsers.js';
import { parsePack } from '../pack.js';

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

/** A keyed, ';'-split mapping used by most cases. */
const KEYED: ImportMappingDef = {
  id: 'vzor',
  sourceName: 'VZOR-LAB',
  detect: { anyOf: ['VZOR-LAB'] },
  entrySplit: ';',
  pattern:
    '(?<name>[^:]+):\\s*(?<value>(?:[<>]=?\\s*)?\\d+(?:[.,]\\d+)?)\\s*(?<unit>[^\\s()]+)?\\s*(?:\\(\\s*(?<low>\\d+(?:[.,]\\d+)?)\\s*-\\s*(?<high>\\d+(?:[.,]\\d+)?)\\s*\\))?',
  datePattern: '(?<date>\\d{4}-\\d{2}-\\d{2})',
};

describe('declarativeLabParser — detect', () => {
  it('claims a document containing a detect substring (case-insensitive)', () => {
    const p = declarativeLabParser(KEYED);
    expect(p.detect(['header vzor-lab 2026-01-01'])).toBe(true);
  });

  it('does not claim a document without any detect substring', () => {
    const p = declarativeLabParser(KEYED);
    expect(p.detect(['some other lab report'])).toBe(false);
  });
});

describe('declarativeLabParser — parse', () => {
  it('parses value, unit and reference range from a keyed entry', () => {
    const p = declarativeLabParser(KEYED);
    const [m] = p.parse(['Glukóza: 5,4 mmol/l (3,9-5,6)'], catalog());
    expect(m.metric).toBe('builtin:glucose' as MetricId);
    expect(m.value).toBeCloseTo(5.4, 9);
    expect(m.unit).toBe('mmol/L');
    expect(m.refLow).toBeCloseTo(3.9, 9);
    expect(m.refHigh).toBeCloseTo(5.6, 9);
    expect(m.sourceName).toBe('VZOR-LAB');
    expect(m.confidence).toBe('medium');
  });

  it('splits a single line into entries on entrySplit', () => {
    const p = declarativeLabParser(KEYED);
    const out = p.parse(['Glukóza: 5,4 mmol/l (3,9-5,6); Kreatinin: 78 umol/l (64-104)'], catalog());
    expect(out).toHaveLength(2);
    expect(out[0].metric).toBe('builtin:glucose' as MetricId);
    expect(out[1].metric).toBe('builtin:creatinine' as MetricId);
    expect(out[1].value).toBeCloseTo(78, 9);
  });

  it('extracts the shared document date from datePattern', () => {
    const p = declarativeLabParser(KEYED);
    const [m] = p.parse(['VZOR-LAB 2026-03-15', 'Glukóza: 5,4 mmol/l'], catalog());
    expect(m.takenAt?.startsWith('2026-03-15')).toBe(true);
    expect(m.timePrecision).toBe('date');
  });

  it('captures a censoring operator inside the value group', () => {
    const p = declarativeLabParser(KEYED);
    const [m] = p.parse(['Glukóza: <2 mmol/l'], catalog());
    expect(m.operator).toBe('<');
    expect(m.value).toBeCloseTo(2, 9);
  });

  it('sets textValue for a short qualitative token (no numeric value)', () => {
    const def: ImportMappingDef = {
      id: 'q',
      sourceName: 'Q',
      detect: { anyOf: ['RES'] },
      pattern: '(?<name>[^=]+)=(?<value>.+)',
    };
    const p = declarativeLabParser(def);
    const [m] = p.parse(['Poznámka=negativní'], catalog());
    expect(m.value).toBeUndefined();
    expect(m.textValue).toBe('negativní');
  });

  it('drops a long prose value rather than inventing one', () => {
    const def: ImportMappingDef = {
      id: 'q',
      sourceName: 'Q',
      detect: { anyOf: ['RES'] },
      pattern: '(?<name>[^=]+)=(?<value>.+)',
    };
    const p = declarativeLabParser(def);
    const [m] = p.parse(['Poznámka=this is a long prose sentence that is not a value'], catalog());
    expect(m.value).toBeUndefined();
    expect(m.textValue).toBeUndefined();
  });

  it('passes an unresolved metric name through for review (never guesses)', () => {
    const p = declarativeLabParser(KEYED);
    const [m] = p.parse(['Zcela Neznámý Analyt: 1,2 mmol/l'], catalog());
    expect(m.metric).toEqual({ unresolvedName: 'Zcela Neznámý Analyt' });
  });

  it('an unrecognised unit is simply omitted (correctness over guessing)', () => {
    const p = declarativeLabParser(KEYED);
    const [m] = p.parse(['Glukóza: 5,4 zorks'], catalog());
    expect(m.value).toBeCloseTo(5.4, 9);
    expect(m.unit).toBeUndefined();
  });
});

describe('declarativeLabParser — invalid inputs & guards', () => {
  it('an invalid regex yields a no-op parser (detect false, parse [])', () => {
    const def: ImportMappingDef = {
      id: 'bad',
      sourceName: 'Bad',
      detect: { anyOf: ['X'] },
      pattern: '(?<name>[', // does not compile
    };
    const p = declarativeLabParser(def);
    expect(p.detect(['X'])).toBe(false);
    expect(p.parse(['X: 1 mmol/l'], catalog())).toEqual([]);
  });

  it('a pattern without a name group is a no-op parser', () => {
    const def: ImportMappingDef = {
      id: 'noname',
      sourceName: 'NoName',
      detect: { anyOf: ['X'] },
      pattern: '(?<value>\\d+)',
    };
    const p = declarativeLabParser(def);
    expect(p.detect(['X'])).toBe(false);
    expect(p.parse(['X 5'], catalog())).toEqual([]);
  });

  it('skips an over-long line (ReDoS guard)', () => {
    const p = declarativeLabParser(KEYED);
    const long = 'Glukóza: 5,4 mmol/l ' + 'a'.repeat(3000);
    expect(p.parse([long], catalog())).toEqual([]);
  });
});

describe('end-to-end: example-import-mapping.json pack', () => {
  it('imports the committed sample pack and parses a matching synthetic sheet', () => {
    const raw = readFileSync(
      new URL('../../../../packs/example-import-mapping.json', import.meta.url),
      'utf8',
    );
    const pack = parsePack(raw);
    expect(pack.importMappings).toHaveLength(1);

    // Wire the mapping into the chain exactly as the PDF/text importers do.
    const extra = (pack.importMappings ?? []).map(declarativeLabParser);
    const lines = [
      'VZOR-LAB 2026-03-15',
      'Glukóza: 5,4 mmol/l (3,9-5,6); Kreatinin: 78 umol/l (64-104); Cholesterol: 5,9 mmol/l (2,9-5,0)',
    ];
    const result = parseLabDocument(lines, catalog(), extra);

    expect(result.parserId).toBe('mapping:vzor-lab-keyed');
    expect(result.sourceName).toBe('VZOR-LAB (synthetic)');
    expect(result.proposals).toHaveLength(3);
    expect(result.proposals.map((p) => p.metric)).toEqual([
      'builtin:glucose',
      'builtin:creatinine',
      'builtin:total-cholesterol',
    ]);
    expect(result.proposals.every((p) => p.takenAt?.startsWith('2026-03-15'))).toBe(true);
    expect(result.proposals.every((p) => p.sourceName === 'VZOR-LAB (synthetic)')).toBe(true);
  });
});
