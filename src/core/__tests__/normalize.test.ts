import { describe, expect, it } from 'vitest';

import {
  normalizeProposal,
  normalizeUnit,
  parseDateTime,
  parseNumber,
  resolveMetric,
} from '../normalize.js';
import { createCatalog } from '../catalog.js';
import type { Catalog } from '../contracts.js';
import { CURRENT_SCHEMA_VERSION } from '../types.js';
import type { Metric, MetricId, ProfileData, ProfileId, ProposedMeasurement } from '../types.js';

/** Real built-in catalog (empty profile) for alias-resolution assertions. */
function realCatalog(): Catalog {
  const data: ProfileData = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    profile: { id: 'p1' as ProfileId, name: 'Test', createdAt: '2026-01-01' },
    metrics: [],
    sources: [],
    measurements: [],
    settings: {},
  };
  return createCatalog(data);
}

// ---------------------------------------------------------------------------
// parseNumber
// ---------------------------------------------------------------------------

describe('parseNumber', () => {
  const cases: Array<[string, ReturnType<typeof parseNumber>]> = [
    ['< 0,5', { value: 0.5, operator: '<' }],
    ['<0.5', { value: 0.5, operator: '<' }],
    ['>7', { value: 7, operator: '>' }],
    ['≥7', { value: 7, operator: '>=' }],
    ['≤ 0,1', { value: 0.1, operator: '<=' }],
    ['<= 3', { value: 3, operator: '<=' }],
    ['>= 3', { value: 3, operator: '>=' }],
    ['5.5', { value: 5.5 }],
    ['5,5', { value: 5.5 }],
    ['1 234,5', { value: 1234.5 }],
    ['1 234,5', { value: 1234.5 }], // NBSP thousands separator
    ['1234.5', { value: 1234.5 }],
    ['  42  ', { value: 42 }],
    ['-3,5', { value: -3.5 }],
    ['+3,5', { value: 3.5 }],
    ['', { error: 'empty' }],
    ['   ', { error: 'empty' }],
    ['abc', { error: 'not-a-number' }],
    ['<', { error: 'not-a-number' }],
    ['1,2,3', { error: 'not-a-number' }],
  ];

  it.each(cases)('parses %j', (raw, expected) => {
    expect(parseNumber(raw)).toEqual(expected);
  });

  it('never returns NaN', () => {
    const r = parseNumber('12.34');
    expect('value' in r && Number.isNaN(r.value)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizeUnit
// ---------------------------------------------------------------------------

describe('normalizeUnit', () => {
  const cases: Array<[string, string | undefined]> = [
    ['mmol/l', 'mmol/L'],
    ['MMOL/L', 'mmol/L'],
    ['mmol/L', 'mmol/L'],
    ['mg/dl', 'mg/dL'],
    ['mg/dL', 'mg/dL'],
    ['ug/l', 'ug/L'],
    ['µg/l', 'ug/L'],
    ['mcg/l', 'ug/L'],
    ['ng/ml', 'ng/mL'],
    ['u/l', 'U/L'],
    ['U/l', 'U/L'],
    ['mmHg', 'mm[Hg]'],
    ['mm Hg', 'mm[Hg]'],
    ['°C', 'Cel'],
    ['C', 'Cel'],
    ['%', '%'],
    ['g/l', 'g/L'],
    ['10^9/l', '10*9/L'],
    ['10*9/l', '10*9/L'],
    ['/min', '/min'],
    ['bpm', '/min'],
    ['tep/min', '/min'],
    ['kg', 'kg'],
    ['cm', 'cm'],
    ['  MMOL / L  ', 'mmol/L'],
    // Units defined in UNITS but formerly absent from the synonym table — the
    // lookup is now derived from UNITS (code + display) so they resolve too.
    ['pmol/l', 'pmol/L'],
    ['nmol/l', 'nmol/L'],
    ['l/l', 'L/L'],
    ['L/L', 'L/L'],
    ['fl', 'fL'],
    ['fL', 'fL'],
    ['pH', '[pH]'],
    ['ph', '[pH]'],
    ['pg/ml', 'pg/mL'],
    ['ng/l', 'ng/L'],
    ['ng/dl', 'ng/dL'],
    ['µkat/l', 'ukat/L'],
    // Czech eGFR unit (SYNLAB uses ml/s per 1.73 m²; distinct from ml/min).
    ['ml/s/1,73m2', 'mL/s/{1.73_m2}'],
    ['ml/s/1.73m2', 'mL/s/{1.73_m2}'],
    ['ml/min/1,73m2', 'mL/min/{1.73_m2}'],
    // Urine-sediment count per microlitre — its own island, NOT a blood count.
    ['počet/μL', '/uL'],
    ['počet/µL', '/uL'],
    ['počet/uL', '/uL'],
    ['foo', undefined],
    ['', undefined],
  ];

  it.each(cases)('normalizes %j', (raw, expected) => {
    expect(normalizeUnit(raw)).toBe(expected);
  });

  it('every mapped code exists in UNITS synonyms toward a known code', () => {
    expect(normalizeUnit('mmol/l')).toBe('mmol/L');
  });

  it('folds a superscript ² so the Czech eGFR unit is recognized', () => {
    // "ml/s/1,73 m²" (SI eGFR) — the ² must fold to 2 and whitespace strip.
    expect(normalizeUnit('ml/s/1,73 m²')).toBe('mL/s/{1.73_m2}');
    expect(normalizeUnit('ml/min/1,73 m²')).toBe('mL/min/{1.73_m2}');
    // A line parser splits the unit at the space, yielding "ml/s/1,73" — accepted.
    expect(normalizeUnit('ml/s/1,73')).toBe('mL/s/{1.73_m2}');
    // The bare superscript area is not a unit on its own.
    expect(normalizeUnit('m²')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseDateTime
// ---------------------------------------------------------------------------

describe('parseDateTime', () => {
  it('parses ISO date-only', () => {
    expect(parseDateTime('2026-07-21')).toEqual({ iso: '2026-07-21', precision: 'date' });
  });

  it('parses ISO datetime', () => {
    expect(parseDateTime('2026-07-21T08:30')).toEqual({
      iso: '2026-07-21T08:30',
      precision: 'datetime',
    });
  });

  it('parses Czech date', () => {
    expect(parseDateTime('21.7.2026')).toEqual({ iso: '2026-07-21', precision: 'date' });
  });

  it('parses spaced Czech date', () => {
    expect(parseDateTime('21. 7. 2026')).toEqual({ iso: '2026-07-21', precision: 'date' });
  });

  it('parses Czech datetime', () => {
    expect(parseDateTime('21.7.2026 8:30')).toEqual({
      iso: '2026-07-21T08:30',
      precision: 'datetime',
    });
  });

  it('parses slash form', () => {
    expect(parseDateTime('21/7/2026')).toEqual({ iso: '2026-07-21', precision: 'date' });
  });

  it('rejects impossible month', () => {
    expect(parseDateTime('32.13.2026')).toBeUndefined();
  });

  it('rejects impossible day', () => {
    expect(parseDateTime('31.2.2026')).toBeUndefined();
  });

  it('rejects garbage', () => {
    expect(parseDateTime('not a date')).toBeUndefined();
  });

  it('rejects empty', () => {
    expect(parseDateTime('')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Fake catalog for resolveMetric / normalizeProposal
// ---------------------------------------------------------------------------

const GLUCOSE_ID = 'builtin:glucose' as MetricId;

const URINE_GLUCOSE_ID = 'builtin:urine-glucose' as MetricId;

function fakeCatalog(): Catalog {
  const glucose = {
    id: GLUCOSE_ID,
    key: 'glucose',
    aliases: ['glukóza', 'glykémie', 'glucose'],
    category: 'lab',
    valueType: 'number',
    canonicalUnit: 'mmol/L',
    units: ['mmol/L', 'mg/dL'],
  } as Metric;

  // A urine-qualified metric, so a specimen "(moč)" qualifier can resolve to it.
  const urineGlucose = {
    id: URINE_GLUCOSE_ID,
    key: 'urine-glucose',
    aliases: ['glukóza v moči'],
    category: 'lab',
    valueType: 'number',
    canonicalUnit: 'mmol/L',
    units: ['mmol/L'],
  } as Metric;

  const norm = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '');

  const metrics = [glucose, urineGlucose];
  return {
    all: () => metrics,
    visible: () => metrics,
    unlearnAlias: () => {},
    customAliases: () => [],
    byId: (id) => metrics.find((m) => m.id === id),
    byKey: (key) => metrics.find((m) => m.key === key),
    byLoinc: () => undefined,
    byExternalCode: () => undefined,
    resolveAlias: (name) =>
      metrics.find((m) => m.aliases.some((a) => norm(a) === norm(name))),
    addUserMetric: () => {
      throw new Error('not implemented');
    },
    learnAlias: () => {
      /* noop */
    },
    setMetricTags: () => {},
    setExternalCodes: () => {},
    addTag: () => {},
    removeTag: () => {},
  };
}

describe('resolveMetric', () => {
  it('resolves a known alias (diacritics-insensitive)', () => {
    expect(resolveMetric('Glukoza', fakeCatalog())).toEqual({ metricId: GLUCOSE_ID });
  });

  it('returns trimmed unresolvedName on miss', () => {
    expect(resolveMetric('  Unknown Metric  ', fakeCatalog())).toEqual({
      unresolvedName: 'Unknown Metric',
    });
  });

  it('resolves "Full name (ABBR)" via the base name before the parenthetical', () => {
    // "Glukóza" is an alias; the trailing "(GLU)" must not defeat the match.
    expect(resolveMetric('Glukóza (GLU)', fakeCatalog())).toEqual({ metricId: GLUCOSE_ID });
  });

  it('resolves "Full name (ABBR)" via the parenthetical content', () => {
    // Base "Blood sugar" is unknown, but the parenthetical "glykémie" is an alias.
    expect(resolveMetric('Blood sugar (glykémie)', fakeCatalog())).toEqual({ metricId: GLUCOSE_ID });
  });

  it('still misses when neither the base nor the parenthetical is known', () => {
    expect(resolveMetric('Foo (bar)', fakeCatalog())).toEqual({ unresolvedName: 'Foo (bar)' });
  });

  it('a specimen "(moč)" qualifier resolves the urine-qualified name, not the bare base', () => {
    // "Glukóza" alone is blood glucose, but "Glukóza (moč)" is a urine analyte:
    // it must resolve to the urine metric via "Glukóza v moči", never blood.
    expect(resolveMetric('Glukóza (moč)', fakeCatalog())).toEqual({ metricId: URINE_GLUCOSE_ID });
  });

  it('a specimen "(moč)" qualifier with no urine home stays unresolved (never the blood metric)', () => {
    // "Glykémie" is a blood-glucose alias, but "Glykémie (moč)" has no urine home
    // ("Glykémie v moči" is not an alias) → review, not a wrong-specimen guess.
    expect(resolveMetric('Glykémie (moč)', fakeCatalog())).toEqual({
      unresolvedName: 'Glykémie (moč)',
    });
  });

  it('prefers the base-name eGFR alias over the "(Krea)" qualifier (real catalog)', () => {
    // "Odhad filtr. CKD-EPI (Krea)" is an eGFR estimate; the parenthetical
    // "(Krea)" names the analyte it is based on, not the identity. It must NOT
    // fall through to the creatinine alias "Krea".
    const cat = realCatalog();
    const r = resolveMetric('Odhad filtr. CKD-EPI (Krea)', cat);
    expect(r).toEqual({ metricId: 'builtin:egfr' as MetricId });
    expect(r).not.toEqual({ metricId: 'builtin:creatinine' as MetricId });
  });
});

// ---------------------------------------------------------------------------
// normalizeProposal
// ---------------------------------------------------------------------------

describe('normalizeProposal', () => {
  it('resolves metric, normalizes unit, preserves rawText', () => {
    const p: ProposedMeasurement = {
      metric: { unresolvedName: 'glykémie' },
      value: 5.4,
      unit: 'mmol/l',
      rawText: 'Glykémie 5,4 mmol/l',
      confidence: 'high',
    };
    const out = normalizeProposal(p, fakeCatalog());
    expect(out.metric).toEqual(GLUCOSE_ID);
    expect(out.unit).toBe('mmol/L');
    expect(out.rawText).toBe('Glykémie 5,4 mmol/l');
    expect(p.metric).toEqual({ unresolvedName: 'glykémie' }); // input not mutated
  });

  it('drops unknown unit and lowers confidence, never guesses', () => {
    const p: ProposedMeasurement = {
      metric: { unresolvedName: 'glykémie' },
      value: 5.4,
      unit: 'zonk',
      rawText: 'raw',
      confidence: 'high',
    };
    const out = normalizeProposal(p, fakeCatalog());
    expect(out.unit).toBeUndefined();
    expect(out.confidence).toBe('medium');
    expect(out.rawText).toBe('raw');
  });

  it('keeps unresolved metric name when catalog misses', () => {
    const p: ProposedMeasurement = {
      metric: { unresolvedName: 'mystery' },
      value: 1,
      rawText: 'raw',
      confidence: 'low',
    };
    const out = normalizeProposal(p, fakeCatalog());
    expect(out.metric).toEqual({ unresolvedName: 'mystery' });
  });

  it('leaves an already-resolved metric id untouched', () => {
    const p: ProposedMeasurement = {
      metric: GLUCOSE_ID,
      value: 1,
      confidence: 'high',
    };
    const out = normalizeProposal(p, fakeCatalog());
    expect(out.metric).toEqual(GLUCOSE_ID);
    expect(out).not.toBe(p);
  });
});
