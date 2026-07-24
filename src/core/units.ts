/**
 * Units conversion engine (step K3).
 *
 * Pure, dependency-free implementation of the `UnitsEngine` contract.
 * Conversion resolution order (design doc §2.2, correction 2026-07-21):
 *   1. same unit code                       -> identity
 *   2. explicit metric.conversions (either  -> affine relation, invertible;
 *      direction)                              precedes every derived path
 *   3. same dimension via toBase            -> linear map ('arbitrary' allows
 *                                              identity only)
 *   4. molarMass bridge between mass- and   -> via each dimension's base unit
 *      molar-concentration
 *   5. otherwise                            -> not-convertible (never NaN)
 *
 * Base units are an internal detail (see units-data.ts). The molar bridge
 * relationship is: mass_conc[g/L] = molar_conc[mmol/L] * molarMass[g/mol] / 1000.
 */

import type { ConversionResult, UnitsEngine } from './contracts.js';
import type { Measurement, Metric, MetricConversion, UnitDef } from './types.js';
import { UNITS } from './units-data.js';

/** Value expressed in the unit's dimension base: base = value * factor + offset. */
function toBase(def: UnitDef, value: number): number {
  return value * def.toBase.factor + (def.toBase.offset ?? 0);
}

/** Inverse of `toBase`: value = (base - offset) / factor. */
function fromBase(def: UnitDef, base: number): number {
  return (base - (def.toBase.offset ?? 0)) / def.toBase.factor;
}

/**
 * Match an explicit metric conversion for the (from, to) pair in either
 * direction. The stored relation is `to = from * factor + offset`.
 * Returns the converted value, or undefined when no entry matches.
 */
function applyExplicit(
  conversions: readonly MetricConversion[] | undefined,
  fromUnit: string,
  toUnit: string,
  value: number,
): number | undefined {
  if (!conversions) return undefined;
  for (const c of conversions) {
    const offset = c.offset ?? 0;
    if (c.fromUnit === fromUnit && c.toUnit === toUnit) {
      // forward: to = from * factor + offset
      return value * c.factor + offset;
    }
    if (c.fromUnit === toUnit && c.toUnit === fromUnit) {
      // inverse: from = (to - offset) / factor
      return (value - offset) / c.factor;
    }
  }
  return undefined;
}

/**
 * Dimension guard for import resolution (spec §16, data integrity).
 *
 * A resolved metric name is only trustworthy when the row's unit is
 * DIMENSIONALLY compatible with that metric: it is the metric's canonical unit,
 * one of its listed units, or convertible to any of them (same dimension, molar
 * bridge, or an explicit metric conversion). A genuine mismatch — e.g. a GFR
 * rate unit on the creatinine metric, or a urine-sediment count on a blood
 * count metric — means the name resolution is wrong; the caller must discard it
 * and send the row to review rather than attach a wrong metric.
 *
 * Pure: reads only the engine (itself pure) and the metric's unit fields. An
 * unknown unit code is NOT compatible (never a silent guess).
 */
export function isUnitCompatibleWithMetric(
  engine: UnitsEngine,
  metric: Metric,
  unitCode: string,
): boolean {
  if (metric.canonicalUnit === unitCode) return true;
  if (metric.units.includes(unitCode)) return true;
  if (engine.convert(1, unitCode, metric.canonicalUnit, metric).ok) return true;
  for (const u of metric.units) {
    if (engine.convert(1, unitCode, u, metric).ok) return true;
  }
  return false;
}

export function createUnitsEngine(units: readonly UnitDef[] = UNITS): UnitsEngine {
  const byCode = new Map<string, UnitDef>();
  for (const u of units) byCode.set(u.code, u);

  function getUnit(code: string): UnitDef | undefined {
    return byCode.get(code);
  }

  // Rebuild the table in place so the engine reference stays stable (every
  // ctx.units holder keeps working). Later entries win on a duplicate code.
  function reloadUnits(next: readonly UnitDef[]): void {
    byCode.clear();
    for (const u of next) byCode.set(u.code, u);
  }

  function allUnits(): UnitDef[] {
    return [...byCode.values()];
  }

  /**
   * molarMass bridge between mass-concentration and molar-concentration.
   * Returns the converted value, or undefined when the pair does not qualify
   * or the metric lacks molarMass.
   */
  function bridge(from: UnitDef, to: UnitDef, value: number, metric?: Metric): number | undefined {
    const molarMass = metric?.molarMass;
    if (molarMass === undefined) return undefined;

    const isBridge =
      (from.dimension === 'molar-concentration' && to.dimension === 'mass-concentration') ||
      (from.dimension === 'mass-concentration' && to.dimension === 'molar-concentration');
    if (!isBridge) return undefined;

    if (from.dimension === 'molar-concentration') {
      // molar -> mass: base_mass[g/L] = base_molar[mmol/L] * M / 1000
      const baseMolar = toBase(from, value);
      const baseMass = (baseMolar * molarMass) / 1000;
      return fromBase(to, baseMass);
    }
    // mass -> molar: base_molar[mmol/L] = base_mass[g/L] * 1000 / M
    const baseMass = toBase(from, value);
    const baseMolar = (baseMass * 1000) / molarMass;
    return fromBase(to, baseMolar);
  }

  function convert(
    value: number,
    fromUnit: string,
    toUnit: string,
    metric?: Metric,
  ): ConversionResult {
    // 1. identity
    if (fromUnit === toUnit) return { ok: true, value };

    const from = byCode.get(fromUnit);
    const to = byCode.get(toUnit);
    if (!from || !to) return { ok: false, reason: 'unknown-unit' };

    // 2. explicit metric conversion (takes precedence over any derived path)
    const explicit = applyExplicit(metric?.conversions, fromUnit, toUnit, value);
    if (explicit !== undefined) return { ok: true, value: explicit };

    // 3. same dimension -> linear map through toBase.
    //    'arbitrary' allows identity only (already handled by step 1).
    if (from.dimension === to.dimension) {
      if (from.dimension === 'arbitrary') return { ok: false, reason: 'not-convertible' };
      return { ok: true, value: fromBase(to, toBase(from, value)) };
    }

    // 4. molarMass bridge (mass-concentration <-> molar-concentration)
    const bridged = bridge(from, to, value, metric);
    if (bridged !== undefined) return { ok: true, value: bridged };

    // 5. not convertible
    return { ok: false, reason: 'not-convertible' };
  }

  function convertMeasurement(
    m: Measurement,
    toUnit: string,
    metric: Metric,
  ): { value: number; refLow?: number; refHigh?: number } | undefined {
    if (m.value === undefined) return undefined; // a text result cannot be converted
    const v = convert(m.value, m.unit, toUnit, metric);
    if (!v.ok) return undefined;

    const result: { value: number; refLow?: number; refHigh?: number } = { value: v.value };

    if (m.refLow !== undefined) {
      const low = convert(m.refLow, m.unit, toUnit, metric);
      if (low.ok) result.refLow = low.value;
    }
    if (m.refHigh !== undefined) {
      const high = convert(m.refHigh, m.unit, toUnit, metric);
      if (high.ok) result.refHigh = high.value;
    }
    return result;
  }

  function reachableUnits(metric: Metric): string[] {
    // metric.units filtered to those convertible from the canonical unit,
    // canonical first, otherwise preserving the metric.units order.
    const canonical = metric.canonicalUnit;
    const rest = metric.units.filter(
      (code) => code !== canonical && convert(1, canonical, code, metric).ok,
    );
    return [canonical, ...rest];
  }

  function round(value: number, unitCode: string, metric?: Metric): number {
    const decimals = metric?.precision?.[unitCode];
    if (decimals === undefined) return value;
    return Number(value.toFixed(decimals));
  }

  return { getUnit, reloadUnits, allUnits, convert, convertMeasurement, reachableUnits, round };
}
