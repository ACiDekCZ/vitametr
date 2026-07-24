/**
 * Unit table — data, not code. Extending the app with a new unit means
 * adding a row here; the engine never changes.
 *
 * Base units per dimension (internal detail, never shown to users):
 *   mass: kg · length: m · temperature: Cel · pressure: Pa
 *   mass-concentration: g/L · molar-concentration: mmol/L
 *   count-concentration: 10*9/L · fraction: 1 (ratio) · rate: /min
 *   enzymatic-activity: ukat/L · arbitrary: no conversions (identity only)
 *
 * `toBase`: base = value * factor + offset.
 * UCUM codes follow the case-sensitive ("c/s") form.
 */

import type { UnitDef } from './types';

export const UNITS: readonly UnitDef[] = [
  // mass
  { code: 'kg', display: 'kg', dimension: 'mass', toBase: { factor: 1 } },
  { code: 'g', display: 'g', dimension: 'mass', toBase: { factor: 0.001 } },
  { code: 'pg', display: 'pg', dimension: 'mass', toBase: { factor: 1e-15 } },
  { code: '[lb_av]', display: 'lb', dimension: 'mass', toBase: { factor: 0.45359237 } },

  // length
  { code: 'm', display: 'm', dimension: 'length', toBase: { factor: 1 } },
  { code: 'cm', display: 'cm', dimension: 'length', toBase: { factor: 0.01 } },
  { code: '[in_i]', display: 'in', dimension: 'length', toBase: { factor: 0.0254 } },

  // temperature (base Cel; degF -> Cel: (F - 32) * 5/9)
  { code: 'Cel', display: '°C', dimension: 'temperature', toBase: { factor: 1 } },
  { code: '[degF]', display: '°F', dimension: 'temperature', toBase: { factor: 5 / 9, offset: -160 / 9 } },

  // pressure (base Pa)
  { code: 'mm[Hg]', display: 'mmHg', dimension: 'pressure', toBase: { factor: 133.322387415 } },
  { code: 'kPa', display: 'kPa', dimension: 'pressure', toBase: { factor: 1000 } },

  // mass concentration (base g/L)
  { code: 'g/L', display: 'g/l', dimension: 'mass-concentration', toBase: { factor: 1 } },
  { code: 'g/dL', display: 'g/dl', dimension: 'mass-concentration', toBase: { factor: 10 } },
  { code: 'mg/L', display: 'mg/l', dimension: 'mass-concentration', toBase: { factor: 0.001 } },
  { code: 'mg/dL', display: 'mg/dl', dimension: 'mass-concentration', toBase: { factor: 0.01 } },
  { code: 'ug/L', display: 'µg/l', dimension: 'mass-concentration', toBase: { factor: 1e-6 } },
  { code: 'ug/dL', display: 'µg/dl', dimension: 'mass-concentration', toBase: { factor: 1e-5 } },
  { code: 'ng/mL', display: 'ng/ml', dimension: 'mass-concentration', toBase: { factor: 1e-6 } },
  { code: 'ng/L', display: 'ng/l', dimension: 'mass-concentration', toBase: { factor: 1e-9 } },
  // pg/mL is identical in magnitude to ng/L (1 pg/mL = 1 ng/L) but is a
  // distinct UCUM code (some assays report NT-proBNP / p2PSA as pg/mL).
  { code: 'pg/mL', display: 'pg/ml', dimension: 'mass-concentration', toBase: { factor: 1e-9 } },
  { code: 'ng/dL', display: 'ng/dl', dimension: 'mass-concentration', toBase: { factor: 1e-8 } },

  // molar concentration (base mmol/L)
  { code: 'mmol/L', display: 'mmol/l', dimension: 'molar-concentration', toBase: { factor: 1 } },
  { code: 'umol/L', display: 'µmol/l', dimension: 'molar-concentration', toBase: { factor: 0.001 } },
  { code: 'nmol/L', display: 'nmol/l', dimension: 'molar-concentration', toBase: { factor: 1e-6 } },
  { code: 'pmol/L', display: 'pmol/l', dimension: 'molar-concentration', toBase: { factor: 1e-9 } },

  // count concentration (blood counts; base 10*9/L)
  { code: '10*9/L', display: '10⁹/l', dimension: 'count-concentration', toBase: { factor: 1 } },
  { code: '10*12/L', display: '10¹²/l', dimension: 'count-concentration', toBase: { factor: 1000 } },

  // fraction (base ratio 1). NOTE: % <-> mmol/mol dimensional conversion is
  // mathematically valid but medically wrong for HbA1c (NGSP vs IFCC scales)
  // — the metric's explicit conversion takes precedence by engine order.
  { code: '%', display: '%', dimension: 'fraction', toBase: { factor: 0.01 } },
  { code: 'mmol/mol', display: 'mmol/mol', dimension: 'fraction', toBase: { factor: 0.001 } },
  // Hematocrit as a volume fraction (L/L 0.45 == 45 %); converts to % via base.
  { code: 'L/L', display: 'l/l', dimension: 'fraction', toBase: { factor: 1 } },

  // rate (base /min)
  { code: '/min', display: '/min', dimension: 'rate', toBase: { factor: 1 } },

  // enzymatic activity (base ukat/L; 1 ukat/L = 60 U/L)
  { code: 'ukat/L', display: 'µkat/l', dimension: 'enzymatic-activity', toBase: { factor: 1 } },
  { code: 'U/L', display: 'U/l', dimension: 'enzymatic-activity', toBase: { factor: 1 / 60 } },

  // arbitrary (identity conversion only — each code is its own island)
  { code: 'm[IU]/L', display: 'mIU/l', dimension: 'arbitrary', toBase: { factor: 1 } },
  // Femtoliter — mean cell / platelet volume (MCV, MPV); reported only in fL.
  { code: 'fL', display: 'fl', dimension: 'arbitrary', toBase: { factor: 1 } },
  // pH (urine) — a dimensionless scale, no conversion.
  { code: '[pH]', display: 'pH', dimension: 'arbitrary', toBase: { factor: 1 } },
  { code: 'mL/min/{1.73_m2}', display: 'ml/min/1.73m²', dimension: 'arbitrary', toBase: { factor: 1 } },
  // Czech labs (SYNLAB) report eGFR in ml/s per 1.73 m² (1 ml/s ≈ 60 ml/min).
  // Own arbitrary island; the eGFR metric carries the explicit ×60 conversion.
  { code: 'mL/s/{1.73_m2}', display: 'ml/s/1.73m²', dimension: 'arbitrary', toBase: { factor: 1 } },
  // Urine-sediment count per microlitre (microscopy). Deliberately its OWN
  // arbitrary island: it is NOT a blood count-concentration (10*12/L) and must
  // never be coerced onto one — the import dimension guard relies on this.
  { code: '/uL', display: 'počet/µL', dimension: 'arbitrary', toBase: { factor: 1 } },
  // Antibody activity (anti-GAD). Distinct from the enzymatic-activity U/L —
  // arbitrary/assay-defined units, no cross-unit conversion.
  { code: 'U/mL', display: 'U/ml', dimension: 'arbitrary', toBase: { factor: 1 } },
  // Albumin/creatinine ratio (ACR): a derived ratio, no unit conversion in MVP.
  { code: 'mg/mmol', display: 'mg/mmol', dimension: 'arbitrary', toBase: { factor: 1 } },
  // Fecal haemoglobin mass per mass of stool (quantitative FIT).
  { code: 'ug/g', display: 'µg/g', dimension: 'arbitrary', toBase: { factor: 1 } },
  // Serum/urine osmolality — milliosmoles per kg of water. Own arbitrary island
  // (an osmole is not a plain mole; no conversion to molar-concentration).
  { code: 'mmol/kg', display: 'mmol/kg', dimension: 'arbitrary', toBase: { factor: 1 } },
  // International units per mL (ASLO, rheumatoid factor). Assay-defined activity,
  // numerically equal to kIU/L; kept as its own arbitrary island (no conversion).
  { code: '[IU]/mL', display: 'IU/ml', dimension: 'arbitrary', toBase: { factor: 1 } },
  // Erythrocyte sedimentation rate (ESR / FW) — millimetres settled per hour.
  { code: 'mm/h', display: 'mm/h', dimension: 'arbitrary', toBase: { factor: 1 } },
  // International units per litre (FSH, LH, beta-hCG). Assay-defined activity;
  // its own arbitrary island (numerically distinct from [IU]/mL — no conversion).
  { code: '[IU]/L', display: 'IU/l', dimension: 'arbitrary', toBase: { factor: 1 } },
  // Coagulation clotting time (aPTT) — seconds. Own arbitrary island: clotting
  // times are assay/reagent specific and never converted to another unit here.
  { code: 's', display: 's', dimension: 'arbitrary', toBase: { factor: 1 } },
  // INR (international normalized ratio) — a dimensionless standardized ratio.
  { code: '{INR}', display: 'INR', dimension: 'arbitrary', toBase: { factor: 1 } },
] as const;
