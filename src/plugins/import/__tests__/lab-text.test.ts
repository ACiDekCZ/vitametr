import { describe, expect, it } from 'vitest';

import { createCatalog } from '../../../core/catalog.js';
import { CURRENT_SCHEMA_VERSION } from '../../../core/types.js';
import type { MetricId, ProfileData, ProfileId } from '../../../core/types.js';
import { parseLabLines } from '../lab-text.js';

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

const CLOSE = 1e-9;

/** The lines produced from the synthetic Czech biochemistry lab PDF. */
const LINES: string[] = [
  'Výsledkový list — biochemie',
  'Pacient: Testovací Vzor (nar. 1980) · Odběr: 10.02.2023 07:45 · Vzorek: sérum',
  'Vyšetření Výsledek Hodn. Jednotka Referenční meze',
  'Glukóza 5,4 mmol/l 3,9 - 5,6',
  'Cholesterol celkový 5,9 H mmol/l 0,0 - 5,0',
  'LDL cholesterol 3,2 H mmol/l 0,0 - 3,0',
  'HDL cholesterol 1,4 mmol/l 1,0 - 2,1',
  'Triglyceridy 1,8 mmol/l 0,0 - 1,7',
  'Kreatinin 78 umol/l 64 - 104',
  'Kyselina močová 320 umol/l 202 - 417',
  'ALT 0,45 ukat/l 0,10 - 0,78',
  'TSH 2,10 mIU/l 0,27 - 4,20',
  'Vitamin D 62 L nmol/l 75 - 200',
];

describe('parseLabLines', () => {
  it('produces one proposal per analyte row (title/meta/header yield none)', () => {
    const proposals = parseLabLines(LINES, catalog());
    expect(proposals).toHaveLength(10);
  });

  it('parses Glukóza fully: metric, value, unit, range, date, confidence', () => {
    const [glucose] = parseLabLines(LINES, catalog());
    expect(glucose.metric).toBe('builtin:glucose' as MetricId);
    expect(glucose.value).toBeCloseTo(5.4, 9);
    expect(glucose.unit).toBe('mmol/L');
    expect(glucose.refLow).toBeCloseTo(3.9, 9);
    expect(glucose.refHigh).toBeCloseTo(5.6, 9);
    expect(glucose.takenAt?.startsWith('2023-02-10')).toBe(true);
    expect(glucose.confidence).toBe('high');
    expect(glucose.rawText).toBe('Glukóza 5,4 mmol/l 3,9 - 5,6');
  });

  it('resolves total cholesterol despite the H flag between value and unit', () => {
    const proposals = parseLabLines(LINES, catalog());
    const chol = proposals.find((p) => p.rawText?.startsWith('Cholesterol celkový'));
    expect(chol).toBeDefined();
    expect(chol!.metric).toBe('builtin:total-cholesterol' as MetricId);
    // The flag must not be misread as the value or the unit.
    expect(chol!.value).toBeCloseTo(5.9, 9);
    expect(chol!.unit).toBe('mmol/L');
    expect(chol!.confidence).toBe('high');
  });

  it('resolves the Czech SI eGFR ("ml/s/1,73 m²") to eGFR with its recognized unit', () => {
    // Czech labs report eGFR in ml/s per 1.73 m²; the unit must be recognized so
    // eGFR imports complete (value + unit + range) rather than unitless/low-conf.
    const proposals = parseLabLines(['Odhad filtr. CKD-EPI 1,4 ml/s/1,73 m2 1,0 - 2,0'], catalog());
    const egfr = proposals.find((p) => p.metric === ('builtin:egfr' as MetricId));
    expect(egfr).toBeDefined();
    expect(egfr!.value).toBeCloseTo(1.4, 9);
    expect(egfr!.unit).toBe('mL/s/{1.73_m2}');
  });

  it('drops a dimensionally-incompatible unit to review (a fL value on a mmol/L lipid)', () => {
    // A misaligned row can cross a `fL` value into a lipid metric — the unit guard
    // must reject it (unresolved) rather than store it under the wrong metric.
    const [tri] = parseLabLines(['Triglyceridy 14,4 fl'], catalog());
    if (tri) expect(typeof tri.metric).toBe('object'); // unresolved, never triglycerides
  });

  it('recognizes umol/L, ukat/L and m[IU]/L units with their values', () => {
    const proposals = parseLabLines(LINES, catalog());

    const krea = proposals.find((p) => p.rawText?.startsWith('Kreatinin'))!;
    expect(krea.metric).toBe('builtin:creatinine' as MetricId);
    expect(krea.unit).toBe('umol/L');
    expect(krea.value).toBeCloseTo(78, 9);

    const alt = proposals.find((p) => p.rawText?.startsWith('ALT'))!;
    expect(alt.metric).toBe('builtin:alt' as MetricId);
    expect(alt.unit).toBe('ukat/L');
    expect(alt.value).toBeCloseTo(0.45, 9);

    const tsh = proposals.find((p) => p.rawText?.startsWith('TSH'))!;
    expect(tsh.metric).toBe('builtin:tsh' as MetricId);
    expect(tsh.unit).toBe('m[IU]/L');
    expect(tsh.value).toBeCloseTo(2.1, 9);
  });

  it('parses Vitamin D with a trailing L flag', () => {
    const proposals = parseLabLines(LINES, catalog());
    const vitd = proposals.find((p) => p.rawText?.startsWith('Vitamin D'))!;
    expect(vitd.metric).toBe('builtin:vitamin-d' as MetricId);
    expect(vitd.value).toBeCloseTo(62, 9);
    expect(vitd.unit).toBe('nmol/L');
  });

  it('gives every proposal the shared draw date from the header', () => {
    const proposals = parseLabLines(LINES, catalog());
    for (const p of proposals) {
      expect(p.takenAt).toBe('2023-02-10T07:45');
      expect(p.timePrecision).toBe('datetime');
    }
  });

  it('reports an unknown analyte as unresolved with low confidence', () => {
    const withUnknown = [...LINES, 'Neznámý marker 1,23 mmol/l 0 - 2'];
    const proposals = parseLabLines(withUnknown, catalog());
    expect(proposals).toHaveLength(11);
    const unknown = proposals.find((p) => p.rawText?.startsWith('Neznámý marker'))!;
    expect(unknown.metric).toEqual({ unresolvedName: 'Neznámý marker' });
    expect(unknown.value).toBeCloseTo(1.23, 9);
    expect(unknown.unit).toBe('mmol/L');
    expect(unknown.confidence).toBe('low');
  });

  it('does not emit a proposal for a meta line that has a number but no unit', () => {
    const proposals = parseLabLines(['Pacient: Testovací Vzor (nar. 1980)'], catalog());
    expect(proposals).toHaveLength(0);
  });

  it('leaves takenAt undefined when no date is present', () => {
    const proposals = parseLabLines(['Glukóza 5,4 mmol/l 3,9 - 5,6'], catalog());
    expect(proposals).toHaveLength(1);
    expect(proposals[0].takenAt).toBeUndefined();
    expect(proposals[0].timePrecision).toBeUndefined();
    // No date => a resolved metric caps at medium confidence.
    expect(proposals[0].confidence).toBe('medium');
    expect(proposals[0].refLow).toBeCloseTo(3.9, CLOSE);
  });
});

/** The lines produced from the synthetic SYNLAB lab PDF (fixture B). */
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

describe('parseLabLines — reference-range and value formats (fixture B)', () => {
  function bySource(rawPrefix: string) {
    const proposals = parseLabLines(SYNLAB_LINES, catalog());
    return proposals.find((p) => p.rawText?.startsWith(rawPrefix))!;
  }

  it('parses `< X` as refHigh with no refLow (Cholesterol < 5,0)', () => {
    const chol = bySource('Cholesterol 4,8');
    expect(chol.metric).toBe('builtin:total-cholesterol' as MetricId);
    expect(chol.value).toBeCloseTo(4.8, CLOSE);
    expect(chol.refHigh).toBeCloseTo(5.0, CLOSE);
    expect(chol.refLow).toBeUndefined();
    expect(chol.refText).toBe('< 5,0');
  });

  it('parses Czech `do X` as refHigh (Triglyceridy do 1,7)', () => {
    const tg = bySource('Triglyceridy');
    expect(tg.metric).toBe('builtin:triglycerides' as MetricId);
    expect(tg.refHigh).toBeCloseTo(1.7, CLOSE);
    expect(tg.refLow).toBeUndefined();
  });

  it('parses Czech `nad X` as refLow (HDL nad 1,0)', () => {
    const hdl = bySource('HDL cholesterol');
    expect(hdl.metric).toBe('builtin:hdl-cholesterol' as MetricId);
    expect(hdl.refLow).toBeCloseTo(1.0, CLOSE);
    expect(hdl.refHigh).toBeUndefined();
  });

  it('captures a leading operator on the value (CRP < 0,10)', () => {
    const crp = bySource('CRP');
    expect(crp.metric).toBe('builtin:crp' as MetricId);
    expect(crp.value).toBeCloseTo(0.1, CLOSE);
    expect(crp.operator).toBe('<');
    expect(crp.unit).toBe('mg/L');
    // Reference comes from the trailing `do 5,0`.
    expect(crp.refHigh).toBeCloseTo(5.0, CLOSE);
    expect(crp.refLow).toBeUndefined();
  });

  it('still parses a two-number range (Ferritin 30 - 400)', () => {
    const fer = bySource('Ferritin');
    expect(fer.metric).toBe('builtin:ferritin' as MetricId);
    expect(fer.value).toBeCloseTo(120, CLOSE);
    expect(fer.unit).toBe('ug/L');
    expect(fer.refLow).toBeCloseTo(30, CLOSE);
    expect(fer.refHigh).toBeCloseTo(400, CLOSE);
  });

  it('applies the date-only draw date from `Datum odběru:` to every proposal', () => {
    const proposals = parseLabLines(SYNLAB_LINES, catalog());
    expect(proposals.length).toBeGreaterThan(0);
    for (const p of proposals) {
      expect(p.takenAt).toBe('2023-08-14');
      expect(p.timePrecision).toBe('date');
    }
  });

  it('parses Czech `od X do Y` as a two-sided range', () => {
    const [only] = parseLabLines(['Glukóza 5,1 mmol/l od 3,9 do 5,6'], catalog());
    expect(only.refLow).toBeCloseTo(3.9, CLOSE);
    expect(only.refHigh).toBeCloseTo(5.6, CLOSE);
  });
});

/**
 * Rows from the comprehensive "výsledkový list" (fixture lab-cs-full) whose
 * units (l/l, fl, pmol/l, pH) were absent from the old synonym table, plus the
 * "Full name (ABBR)" style — all previously dropped or left unresolved.
 */
describe('parseLabLines — full sheet units and "Name (ABBR)" rows', () => {
  const resolve = (line: string) => parseLabLines([line], catalog())[0];

  const rows: Array<[string, MetricId, string, number]> = [
    ['Hematokrit 0,49 l/l 0,40 - 0,50', 'builtin:hematocrit' as MetricId, 'L/L', 0.49],
    ['Střední objem erytrocytu 88,5 fl 82 - 98', 'builtin:mcv' as MetricId, 'fL', 88.5],
    ['Volný tyroxin (fT4) 15,8 pmol/l 12,0 - 22,0', 'builtin:ft4' as MetricId, 'pmol/L', 15.8],
    ['Glykovaný hemoglobin (HbA1c) 38 mmol/mol 20 - 42', 'builtin:hba1c' as MetricId, 'mmol/mol', 38],
    ['Vitamin B12 310 pmol/l 145 - 569', 'builtin:vitamin-b12' as MetricId, 'pmol/L', 310],
    ['pH moči 5,5 pH 5,0 - 6,5', 'builtin:urine-ph' as MetricId, '[pH]', 5.5],
  ];

  it.each(rows)('parses %j to a resolved metric with the right unit', (line, metric, unit, value) => {
    const p = resolve(line);
    expect(p).toBeDefined();
    expect(p.metric).toBe(metric);
    expect(p.unit).toBe(unit);
    expect(p.value).toBeCloseTo(value, CLOSE);
  });

  it('resolves folate under its Czech name "Kyselina listová"', () => {
    const p = resolve('Kyselina listová 18,5 nmol/l 8,0 - 40,0');
    expect(p.metric).toBe('builtin:folate' as MetricId);
    expect(p.unit).toBe('nmol/L');
  });
});

/**
 * Qualitative (dipstick) rows have no number or unit — e.g.
 * "Glukóza v moči negativní". They import only when the name resolves to a
 * text/enum metric AND the value is a recognized qualitative token.
 */
describe('parseLabLines — qualitative (dipstick) rows', () => {
  const one = (line: string) => parseLabLines([line], catalog());

  const rows: Array<[string, MetricId, string]> = [
    ['Glukóza v moči negativní negativní', 'builtin:urine-glucose' as MetricId, 'negativní'],
    ['Ketolátky v moči negativní negativní', 'builtin:urine-ketones' as MetricId, 'negativní'],
    ['Urobilinogen v moči normální normální', 'builtin:urine-urobilinogen' as MetricId, 'normální'],
    ['Krev v moči stopy negativní', 'builtin:urine-blood' as MetricId, 'stopy'],
    // The trailing "+" flag and repeated reference must be ignored.
    ['Leukocyty v moči pozitivní + negativní', 'builtin:urine-leukocyte-esterase' as MetricId, 'pozitivní'],
  ];

  it.each(rows)('parses %j as a text-valued proposal', (line, metric, textValue) => {
    const [p] = one(line);
    expect(p).toBeDefined();
    expect(p.metric).toBe(metric);
    expect(p.textValue).toBe(textValue);
    expect(p.value).toBeUndefined();
    expect(p.unit).toBeUndefined();
  });

  it('prefers the longest resolving name (urine metric over the blood one)', () => {
    // "Glukóza" alone is blood glucose (numeric); "Glukóza v moči" is the text
    // urine metric — the longer, correct match must win.
    const [p] = one('Glukóza v moči pozitivní');
    expect(p.metric).toBe('builtin:urine-glucose' as MetricId);
    expect(p.textValue).toBe('pozitivní');
  });

  it('never invents a text value for a numeric metric (spec §16)', () => {
    // Blood glucose is numeric; a stray qualitative token must NOT be attached.
    expect(parseLabLines(['Glukóza negativní'], catalog())).toHaveLength(0);
  });

  it('ignores prose lines whose name does not resolve', () => {
    expect(parseLabLines(['Poznámka k odběru negativní'], catalog())).toHaveLength(0);
  });

  it('leaves a resolved text metric out when the value is not qualitative', () => {
    // Name resolves, but "žlutá" is not a recognized qualitative token.
    expect(parseLabLines(['Glukóza v moči žlutá zakalená'], catalog())).toHaveLength(0);
  });
});

/**
 * Regression: SYNLAB metric mis-resolution (data-integrity bugs).
 *  - eGFR "Odhad filtr. CKD-EPI (Krea)" must NOT fall through the "(Krea)"
 *    parenthetical onto creatinine.
 *  - A urine-sediment RBC count ("Erytrocyty … počet/µL") must NOT map onto the
 *    blood erythrocyte metric (whose unit is 10*12/L).
 */
describe('parseLabLines — SYNLAB metric mis-resolution regressions', () => {
  const first = (line: string) => parseLabLines([line], catalog())[0];

  it('row 1: blood RBC in 10^12/L resolves to erythrocytes (kept)', () => {
    const p = first('Erytrocyty 5,56 10^12/L 4,00 - 5,80');
    expect(p).toBeDefined();
    expect(p.metric).toBe('builtin:erythrocytes' as MetricId);
    expect(p.unit).toBe('10*12/L');
    expect(p.value).toBeCloseTo(5.56, CLOSE);
  });

  it('row 2: creatinine in µmol/L resolves to creatinine (kept)', () => {
    const p = first('Kreatinin 91 μmol/L 64 - 104');
    expect(p).toBeDefined();
    expect(p.metric).toBe('builtin:creatinine' as MetricId);
    expect(p.unit).toBe('umol/L');
    expect(p.value).toBeCloseTo(91, CLOSE);
  });

  it('row 3: eGFR "(Krea)" resolves to eGFR, never creatinine', () => {
    const p = first('Odhad filtr. CKD-EPI (Krea) 1,4 ml/s/1,73m2');
    expect(p).toBeDefined();
    expect(p.metric).not.toEqual('builtin:creatinine' as MetricId);
    expect(p.metric).toBe('builtin:egfr' as MetricId);
    expect(p.unit).toBe('mL/s/{1.73_m2}');
  });

  it('row 3 guard: a creatinine-named estimate carrying a GFR unit is rejected', () => {
    // Even if the name resolved to creatinine, a GFR/rate unit is not a molar
    // concentration — the dimension guard sends it to review, never onto a
    // wrong metric.
    const p = first('Krea 1,4 ml/s/1,73m2');
    expect(p).toBeDefined();
    expect(p.metric).not.toEqual('builtin:creatinine' as MetricId);
    expect(p.metric).toEqual({ unresolvedName: 'Krea' });
    expect(p.confidence).toBe('low');
  });

  it('row 4: urine-sediment RBC count does NOT map to blood erythrocytes', () => {
    const p = first('Erytrocyty < 4 počet/μL');
    expect(p).toBeDefined();
    expect(p.metric).not.toEqual('builtin:erythrocytes' as MetricId);
    expect(p.metric).toEqual({ unresolvedName: 'Erytrocyty' });
  });

  it('legitimate convertible unit is not rejected (glucose in mg/dL)', () => {
    const p = first('Glukóza 99 mg/dl 74 - 106');
    expect(p).toBeDefined();
    expect(p.metric).toBe('builtin:glucose' as MetricId);
    expect(p.unit).toBe('mg/dL');
  });
});
