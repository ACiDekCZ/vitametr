import { describe, expect, it } from 'vitest';

import { createUnitsEngine, isUnitCompatibleWithMetric } from '../units.js';
import { UNITS } from '../units-data.js';
import type { Measurement, Metric, MetricId, ProfileId } from '../types.js';

const engine = createUnitsEngine();

// ---------------------------------------------------------------------------
// Metric fixtures (minimal shapes, only fields the engine reads)
// ---------------------------------------------------------------------------

function metric(partial: Partial<Metric> & Pick<Metric, 'canonicalUnit' | 'units'>): Metric {
  return {
    id: 'builtin:test' as MetricId,
    aliases: [],
    category: 'lab',
    valueType: 'number',
    ...partial,
  };
}

const glucose = metric({
  canonicalUnit: 'mmol/L',
  units: ['mmol/L', 'mg/dL'],
  molarMass: 180.16,
  precision: { 'mmol/L': 2, 'mg/dL': 0 },
});

const creatinine = metric({
  canonicalUnit: 'umol/L',
  units: ['umol/L', 'mg/dL'],
  molarMass: 113.12,
});

const iron = metric({
  canonicalUnit: 'umol/L',
  units: ['umol/L', 'ug/dL'],
  molarMass: 55.85,
});

const vitaminD = metric({
  canonicalUnit: 'nmol/L',
  units: ['nmol/L', 'ng/mL'],
  molarMass: 400.64,
});

const hba1c = metric({
  canonicalUnit: 'mmol/mol',
  units: ['mmol/mol', '%'],
  conversions: [{ fromUnit: 'mmol/mol', toUnit: '%', factor: 0.09148, offset: 2.152 }],
});

const temperature = metric({ canonicalUnit: 'Cel', units: ['Cel', '[degF]'] });
const pressure = metric({ canonicalUnit: 'mm[Hg]', units: ['mm[Hg]', 'kPa'] });
const alt = metric({ canonicalUnit: 'ukat/L', units: ['ukat/L', 'U/L'] });
const tsh = metric({ canonicalUnit: 'm[IU]/L', units: ['m[IU]/L'] });

function ok(r: { ok: boolean }): asserts r is { ok: true; value: number } {
  expect(r.ok).toBe(true);
}

// ---------------------------------------------------------------------------
// Acceptance: molarMass bridge
// ---------------------------------------------------------------------------

describe('molarMass bridge', () => {
  it('glucose 5.5 mmol/L -> 99.09 mg/dL and back', () => {
    const r = engine.convert(5.5, 'mmol/L', 'mg/dL', glucose);
    ok(r);
    expect(r.value).toBeCloseTo(99.09, 1);

    const back = engine.convert(r.value, 'mg/dL', 'mmol/L', glucose);
    ok(back);
    expect(back.value).toBeCloseTo(5.5, 6);
  });

  it('creatinine 1.0 mg/dL -> ~88.4 umol/L', () => {
    const r = engine.convert(1.0, 'mg/dL', 'umol/L', creatinine);
    ok(r);
    expect(r.value).toBeCloseTo(88.4, 1);
  });

  it('iron 10 umol/L -> ~55.87 ug/dL', () => {
    const r = engine.convert(10, 'umol/L', 'ug/dL', iron);
    ok(r);
    expect(r.value).toBeCloseTo(55.87, 1);
  });

  it('vitamin D 30 ng/mL -> ~74.9 nmol/L', () => {
    const r = engine.convert(30, 'ng/mL', 'nmol/L', vitaminD);
    ok(r);
    expect(r.value).toBeCloseTo(74.9, 1);
  });

  it('requires molarMass to bridge mass<->molar', () => {
    const noMass = metric({ canonicalUnit: 'mmol/L', units: ['mmol/L', 'mg/dL'] });
    const r = engine.convert(5.5, 'mmol/L', 'mg/dL', noMass);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not-convertible');
  });
});

// ---------------------------------------------------------------------------
// Acceptance: explicit MetricConversion
// ---------------------------------------------------------------------------

describe('explicit MetricConversion (HbA1c)', () => {
  it('42 mmol/mol -> ~6.0 %', () => {
    const r = engine.convert(42, 'mmol/mol', '%', hba1c);
    ok(r);
    expect(r.value).toBeGreaterThanOrEqual(5.99);
    expect(r.value).toBeLessThanOrEqual(6.0);
  });

  it('inverse 6.0 % -> ~42 mmol/mol', () => {
    const r = engine.convert(6.0, '%', 'mmol/mol', hba1c);
    ok(r);
    expect(r.value).toBeCloseTo(42, 0);
  });

  it('explicit conversion beats the dimensional fraction conversion', () => {
    const r = engine.convert(42, 'mmol/mol', '%', hba1c);
    ok(r);
    // dimensional would give 4.2 %, which is medically wrong
    expect(r.value).not.toBeCloseTo(4.2, 1);
  });
});

// ---------------------------------------------------------------------------
// Acceptance: dimensional conversions
// ---------------------------------------------------------------------------

describe('dimensional conversions', () => {
  it('temperature 36.6 Cel -> 97.88 [degF] and back', () => {
    const r = engine.convert(36.6, 'Cel', '[degF]', temperature);
    ok(r);
    expect(r.value).toBeCloseTo(97.88, 2);

    const back = engine.convert(r.value, '[degF]', 'Cel', temperature);
    ok(back);
    expect(back.value).toBeCloseTo(36.6, 9);
  });

  it('pressure 120 mm[Hg] -> ~16.0 kPa', () => {
    const r = engine.convert(120, 'mm[Hg]', 'kPa', pressure);
    ok(r);
    expect(r.value).toBeCloseTo(16.0, 1);
  });

  it('enzymatic 1 ukat/L = 60 U/L', () => {
    const r = engine.convert(1, 'ukat/L', 'U/L', alt);
    ok(r);
    expect(r.value).toBeCloseTo(60, 9);
  });

  it('1000 nmol/L = 1 umol/L', () => {
    const r = engine.convert(1000, 'nmol/L', 'umol/L');
    ok(r);
    expect(r.value).toBeCloseTo(1, 9);
  });

  it('ug/L <-> ng/mL identity-factor equivalence', () => {
    const r = engine.convert(7, 'ug/L', 'ng/mL');
    ok(r);
    expect(r.value).toBeCloseTo(7, 9);
  });
});

// ---------------------------------------------------------------------------
// Acceptance: arbitrary dimension + unknown units
// ---------------------------------------------------------------------------

describe('arbitrary dimension and unknown units', () => {
  it('arbitrary identity works', () => {
    const r = engine.convert(3, 'm[IU]/L', 'm[IU]/L', tsh);
    ok(r);
    expect(r.value).toBe(3);
  });

  it('arbitrary cross-unit is not convertible', () => {
    const r = engine.convert(3, 'm[IU]/L', 'mL/min/{1.73_m2}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not-convertible');
  });

  it('unknown unit code -> unknown-unit', () => {
    const r = engine.convert(3, 'made-up-unit', 'mmol/L');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown-unit');

    const r2 = engine.convert(3, 'mmol/L', 'made-up-unit');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('unknown-unit');
  });

  it('no conversion path -> not-convertible, never NaN', () => {
    const r = engine.convert(5, 'kg', 'Cel');
    expect(r.ok).toBe(false);
    if (r.ok) expect(Number.isNaN(r.value)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Property: round-trip for every unit pair of a metric
// ---------------------------------------------------------------------------

describe('round-trip property', () => {
  const metrics = [glucose, creatinine, iron, vitaminD, hba1c, temperature, pressure, alt];
  const sample = 37.25;

  for (const m of metrics) {
    for (const a of m.units) {
      for (const b of m.units) {
        it(`${a} -> ${b} -> ${a} round-trips`, () => {
          const forward = engine.convert(sample, a, b, m);
          ok(forward);
          expect(Number.isNaN(forward.value)).toBe(false);
          const back = engine.convert(forward.value, b, a, m);
          ok(back);
          const rel = Math.abs(back.value - sample) / Math.abs(sample);
          expect(rel).toBeLessThan(1e-9);
        });
      }
    }
  }
});

// ---------------------------------------------------------------------------
// convertMeasurement
// ---------------------------------------------------------------------------

describe('convertMeasurement', () => {
  function measurement(value: number, unit: string, refLow?: number, refHigh?: number): Measurement {
    return {
      id: 'm1' as Measurement['id'],
      profileId: 'p1' as ProfileId,
      metricId: 'builtin:test' as MetricId,
      value,
      unit,
      takenAt: '2026-07-21',
      timePrecision: 'date',
      status: 'confirmed',
      origin: { pluginId: 'manual' },
      createdAt: '2026-07-21',
      modifiedAt: '2026-07-21',
      ...(refLow !== undefined ? { refLow } : {}),
      ...(refHigh !== undefined ? { refHigh } : {}),
    };
  }

  it('converts value and reference range together, keeping position', () => {
    const m = measurement(5.5, 'mmol/L', 3.9, 5.6);
    const out = engine.convertMeasurement(m, 'mg/dL', glucose);
    expect(out).toBeDefined();
    if (!out) return;
    expect(out.value).toBeCloseTo(99.09, 1);
    expect(out.refLow).toBeDefined();
    expect(out.refHigh).toBeDefined();
    // value inside the original range stays inside the converted range
    expect(out.value).toBeGreaterThanOrEqual(out.refLow as number);
    expect(out.value).toBeLessThanOrEqual(out.refHigh as number);
  });

  it('omits missing refs and still converts value', () => {
    const m = measurement(5.5, 'mmol/L');
    const out = engine.convertMeasurement(m, 'mg/dL', glucose);
    expect(out).toBeDefined();
    if (!out) return;
    expect(out.refLow).toBeUndefined();
    expect(out.refHigh).toBeUndefined();
  });

  it('returns undefined when not convertible', () => {
    const m = measurement(5, 'kg');
    const out = engine.convertMeasurement(m, 'Cel', metric({ canonicalUnit: 'kg', units: ['kg', 'Cel'] }));
    expect(out).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// reachableUnits
// ---------------------------------------------------------------------------

describe('reachableUnits', () => {
  it('lists canonical first then convertible units in stable order', () => {
    expect(engine.reachableUnits(glucose)).toEqual(['mmol/L', 'mg/dL']);
  });

  it('drops units that are not convertible from canonical', () => {
    const mixed = metric({ canonicalUnit: 'mmol/L', units: ['mg/dL', 'mmol/L', 'kg'] });
    // no molarMass -> mg/dL unreachable; kg is a different dimension
    expect(mixed.units.length).toBe(3);
    expect(engine.reachableUnits(mixed)).toEqual(['mmol/L']);
  });

  it('includes bridged units when molarMass is present', () => {
    expect(engine.reachableUnits(creatinine)).toEqual(['umol/L', 'mg/dL']);
  });
});

// ---------------------------------------------------------------------------
// isUnitCompatibleWithMetric — dimension guard for import resolution
// ---------------------------------------------------------------------------

describe('isUnitCompatibleWithMetric', () => {
  it('accepts the metric canonical unit and any listed unit', () => {
    expect(isUnitCompatibleWithMetric(engine, glucose, 'mmol/L')).toBe(true);
    expect(isUnitCompatibleWithMetric(engine, glucose, 'mg/dL')).toBe(true);
  });

  it('accepts a legitimately convertible unit not in the metric list', () => {
    // g/L shares the mass-concentration dimension with mg/dL and bridges to
    // mmol/L via molarMass — a real, convertible unit must stay compatible.
    expect(isUnitCompatibleWithMetric(engine, glucose, 'g/L')).toBe(true);
  });

  it('rejects a genuine dimension mismatch (rate/GFR unit vs molar creatinine)', () => {
    expect(isUnitCompatibleWithMetric(engine, creatinine, 'mL/s/{1.73_m2}')).toBe(false);
    expect(isUnitCompatibleWithMetric(engine, creatinine, 'mL/min/{1.73_m2}')).toBe(false);
  });

  it('rejects an urine-sediment count unit for a blood-count metric', () => {
    const erythrocytes = metric({ canonicalUnit: '10*12/L', units: ['10*12/L'] });
    expect(isUnitCompatibleWithMetric(engine, erythrocytes, '10*12/L')).toBe(true);
    expect(isUnitCompatibleWithMetric(engine, erythrocytes, '/uL')).toBe(false);
  });

  it('treats an unknown unit code as incompatible (never a silent guess)', () => {
    expect(isUnitCompatibleWithMetric(engine, glucose, 'totally-unknown')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// round
// ---------------------------------------------------------------------------

describe('round', () => {
  it('rounds to configured decimals', () => {
    expect(engine.round(99.088, 'mg/dL', glucose)).toBe(99);
    expect(engine.round(5.4987, 'mmol/L', glucose)).toBe(5.5);
  });

  it('returns value unchanged when no precision info', () => {
    expect(engine.round(1.23456, 'mg/dL', creatinine)).toBe(1.23456);
    expect(engine.round(1.23456, 'mg/dL')).toBe(1.23456);
    const partial = metric({ canonicalUnit: 'mmol/L', units: ['mmol/L'], precision: { 'mmol/L': 1 } });
    expect(engine.round(1.23456, 'mg/dL', partial)).toBe(1.23456);
  });
});

// ---------------------------------------------------------------------------
// getUnit + custom unit table
// ---------------------------------------------------------------------------

describe('getUnit and factory', () => {
  it('returns unit defs by code', () => {
    expect(engine.getUnit('mmol/L')?.dimension).toBe('molar-concentration');
    expect(engine.getUnit('nope')).toBeUndefined();
  });

  it('accepts a custom unit table', () => {
    const custom = createUnitsEngine(UNITS.filter((u) => u.code === 'kg'));
    expect(custom.getUnit('kg')).toBeDefined();
    expect(custom.getUnit('mmol/L')).toBeUndefined();
  });

  it('reloadUnits replaces the table in place and converts with a new custom unit', () => {
    const e = createUnitsEngine([]);
    expect(e.getUnit('kg')).toBeUndefined();
    // A profile adds a custom mass unit "dag" (dekagram = 0.01 kg).
    e.reloadUnits([
      { code: 'kg', display: 'kg', dimension: 'mass', toBase: { factor: 1 } },
      { code: 'dag', display: 'dag', dimension: 'mass', toBase: { factor: 0.01 } },
    ]);
    expect(e.allUnits().map((u) => u.code).sort()).toEqual(['dag', 'kg']);
    const r = e.convert(500, 'dag', 'kg');
    ok(r);
    expect(r.value).toBeCloseTo(5, 9);
  });
});
