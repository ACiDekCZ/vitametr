/**
 * Input normalization (step K6a).
 *
 * Pure functions that clean up raw human input before it enters the domain
 * model: numbers with a decimal comma or point, censoring operators, unit
 * spellings, dates/times, and metric names resolved against the catalog.
 *
 * Design rules:
 * - Never guess. An unrecognized unit or metric is reported as such, never
 *   silently mapped to something plausible (spec §16).
 * - The original text is never destroyed; callers keep `rawText` alongside
 *   the normalized fields.
 * - No DOM, no storage, no clock. Dates are parsed from explicit input only;
 *   `Date.now()` / argless `new Date()` are deliberately not used.
 */

import type { Catalog } from './contracts.js';
import type { MetricId, Operator, ProposedMeasurement, TimePrecision } from './types.js';
import { UNITS } from './units-data.js';

// ---------------------------------------------------------------------------
// parseNumber
// ---------------------------------------------------------------------------

export type ParseNumberResult =
  | { value: number; operator?: Operator }
  | { error: 'empty' | 'not-a-number' };

/** Leading operator spellings mapped to the canonical Operator. */
const OPERATOR_MAP: ReadonlyArray<readonly [string, Operator]> = [
  // Longer / multi-char forms first so '<=' wins over '<'.
  ['<=', '<='],
  ['>=', '>='],
  ['≤', '<='],
  ['≥', '>='],
  ['<', '<'],
  ['>', '>'],
];

/**
 * Parse a raw numeric string. Handles a decimal comma or point, spaces and
 * NBSP as thousands separators, and a leading censoring operator
 * (`<`, `>`, `≤`, `≥`, `<=`, `>=`). Never returns NaN.
 */
export function parseNumber(raw: string): ParseNumberResult {
  let s = raw.trim();
  if (s === '') return { error: 'empty' };

  let operator: Operator | undefined;
  for (const [token, op] of OPERATOR_MAP) {
    if (s.startsWith(token)) {
      operator = op;
      s = s.slice(token.length).trim();
      break;
    }
  }

  if (s === '') return { error: 'not-a-number' };

  // Remove spaces and NBSP used as thousands separators.
  s = s.replace(/[\s  ]/g, '');

  // Unify the decimal separator: a comma is only ever a decimal separator in
  // this app (thousands separators were spaces, now removed).
  s = s.replace(/,/g, '.');

  // Accept an optional sign and exactly one decimal point.
  if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(s)) {
    return { error: 'not-a-number' };
  }

  const value = Number(s);
  if (Number.isNaN(value)) return { error: 'not-a-number' };

  return operator ? { value, operator } : { value };
}

// ---------------------------------------------------------------------------
// normalizeUnit
// ---------------------------------------------------------------------------

/**
 * Build a lookup key from a raw unit string: lowercased, whitespace removed,
 * micro sign / Greek mu unified to 'u', caret exponent unified to '*'.
 */
function unitKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s  ]/g, '')
    .replace(/[µμ]/g, 'u') // micro sign U+00B5 and Greek small mu U+03BC
    .replace(/²/g, '2') // superscript two (e.g. 1.73 m²) -> '2'
    .replace(/³/g, '3') // superscript three -> '3'
    .replace(/\^/g, '*'); // 10^9 -> 10*9
}

/**
 * Synonym table: normalized key -> UCUM code present in UNITS. Keys are the
 * output of {@link unitKey}, so they are already lowercased and stripped of
 * whitespace; add spellings here, never in the engine.
 */
const UNIT_SYNONYMS: Readonly<Record<string, string>> = {
  // molar concentration
  'mmol/l': 'mmol/L',
  'umol/l': 'umol/L',
  'nmol/l': 'nmol/L',
  // mass concentration
  'g/l': 'g/L',
  'g/dl': 'g/dL',
  'mg/l': 'mg/L',
  'mg/dl': 'mg/dL',
  'ug/l': 'ug/L',
  'mcg/l': 'ug/L',
  'ug/dl': 'ug/dL',
  'mcg/dl': 'ug/dL',
  'ng/ml': 'ng/mL',
  // enzymatic activity
  'u/l': 'U/L',
  'ukat/l': 'ukat/L',
  // international units (e.g. TSH)
  'miu/l': 'm[IU]/L',
  // pressure
  mmhg: 'mm[Hg]',
  kpa: 'kPa',
  // temperature
  '°c': 'Cel',
  c: 'Cel',
  cel: 'Cel',
  // fraction
  '%': '%',
  'mmol/mol': 'mmol/mol',
  // count concentration
  '10*9/l': '10*9/L',
  '10*12/l': '10*12/L',
  // eGFR: Czech ml/s per 1.73 m² and the ml/min form (single-token spellings;
  // unitKey lowercases and strips whitespace but keeps the decimal comma).
  'ml/s/1,73m2': 'mL/s/{1.73_m2}',
  'ml/s/1.73m2': 'mL/s/{1.73_m2}',
  'ml/min/1,73m2': 'mL/min/{1.73_m2}',
  'ml/min/1.73m2': 'mL/min/{1.73_m2}',
  // A line parser tokenizes on spaces, so "1,4 ml/s/1,73 m²" yields the unit token
  // "ml/s/1,73" without the trailing "m²" — accept that truncated form too.
  'ml/s/1,73': 'mL/s/{1.73_m2}',
  'ml/s/1.73': 'mL/s/{1.73_m2}',
  'ml/min/1,73': 'mL/min/{1.73_m2}',
  'ml/min/1.73': 'mL/min/{1.73_m2}',
  // urine-sediment count per microlitre (µ/μ already folded to 'u' by unitKey)
  'pocet/ul': '/uL',
  'počet/ul': '/uL',
  '/ul': '/uL',
  'elem/ul': '/uL',
  // rate
  '/min': '/min',
  bpm: '/min',
  'tep/min': '/min',
  // mass / length
  kg: 'kg',
  g: 'g',
  cm: 'cm',
  m: 'm',
};

/**
 * Full spelling -> UCUM code lookup. Every unit in UNITS is reachable by its
 * own code AND its display form (both run through {@link unitKey}), so the
 * table can never drift behind UNITS; UNIT_SYNONYMS only adds genuinely
 * alternate spellings (mcg/l, bpm, °c, …) on top and wins on any overlap.
 */
const UNIT_LOOKUP: Readonly<Record<string, string>> = (() => {
  const map: Record<string, string> = {};
  for (const u of UNITS) {
    map[unitKey(u.code)] = u.code;
    map[unitKey(u.display)] = u.code;
  }
  return { ...map, ...UNIT_SYNONYMS };
})();

/**
 * Map a human unit spelling to the UCUM code used in UNITS. Case-insensitive
 * and whitespace-tolerant. Returns undefined for anything unrecognized —
 * the caller must not guess.
 */
export function normalizeUnit(raw: string): string | undefined {
  if (raw.trim() === '') return undefined;
  return UNIT_LOOKUP[unitKey(raw)];
}

// ---------------------------------------------------------------------------
// parseDateTime
// ---------------------------------------------------------------------------

export interface ParsedDateTime {
  iso: string;
  precision: TimePrecision;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Validate a calendar date by round-tripping through explicit Date args. */
function isValidYmd(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(year, month - 1, day);
  return (
    d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day
  );
}

function isValidTime(hour: number, minute: number): boolean {
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function buildIso(
  year: number,
  month: number,
  day: number,
  time: { hour: number; minute: number } | undefined,
): ParsedDateTime {
  const date = `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
  if (time) {
    return {
      iso: `${date}T${pad2(time.hour)}:${pad2(time.minute)}`,
      precision: 'datetime',
    };
  }
  return { iso: date, precision: 'date' };
}

// ISO: 2026-07-21 or 2026-07-21T08:30 (optionally with seconds).
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2})?)?$/;
// Czech / slash: 21.7.2026 or 21. 7. 2026 or 21/7/2026, optional time.
const DMY_RE =
  /^(\d{1,2})\s*[./]\s*(\d{1,2})\s*[./]\s*(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/;

/**
 * Parse an ISO, Czech (dd.mm.yyyy) or slash date, optionally with a time.
 * Date-only input yields precision 'date'; a time yields 'datetime'.
 * Impossible dates return undefined.
 */
export function parseDateTime(raw: string): ParsedDateTime | undefined {
  const s = raw.trim();
  if (s === '') return undefined;

  const iso = ISO_RE.exec(s);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    if (!isValidYmd(year, month, day)) return undefined;
    if (iso[4] !== undefined) {
      const hour = Number(iso[4]);
      const minute = Number(iso[5]);
      if (!isValidTime(hour, minute)) return undefined;
      return buildIso(year, month, day, { hour, minute });
    }
    return buildIso(year, month, day, undefined);
  }

  const dmy = DMY_RE.exec(s);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const year = Number(dmy[3]);
    if (!isValidYmd(year, month, day)) return undefined;
    if (dmy[4] !== undefined) {
      const hour = Number(dmy[4]);
      const minute = Number(dmy[5]);
      if (!isValidTime(hour, minute)) return undefined;
      return buildIso(year, month, day, { hour, minute });
    }
    return buildIso(year, month, day, undefined);
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// resolveMetric
// ---------------------------------------------------------------------------

export type ResolveMetricResult = { metricId: MetricId } | { unresolvedName: string };

/**
 * Resolve a metric name against the catalog's alias index. On a miss, return
 * the trimmed original name as `unresolvedName` — never a guess.
 */
export function resolveMetric(name: string, catalog: Catalog): ResolveMetricResult {
  const trimmed = name.trim();
  const hit = catalog.resolveAlias(trimmed);
  if (hit) return { metricId: hit.id };
  // Common lab style "Full name (ABBR)" — e.g. "Glykovaný hemoglobin (HbA1c)"
  // or "Volný tyroxin (fT4)". Retry with the trailing parenthetical removed,
  // then with the parenthetical content alone.
  const paren = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(trimmed);
  if (paren) {
    const base = paren[1].trim();
    const inner = paren[2].trim();
    // A specimen/matrix qualifier — "(moč)" / "(urine)" — is NOT an abbreviation:
    // it marks a distinct specimen, so we must never fall back to the bare base
    // (a urine analyte would otherwise resolve onto its blood metric). Resolve
    // only the urine-qualified name ("X v moči"); if that has no catalog home,
    // leave it unresolved for review rather than guess the wrong specimen.
    if (/^(moč|moči|urine)$/iu.test(inner)) {
      const urine = base !== '' && catalog.resolveAlias(`${base} v moči`);
      return urine ? { metricId: urine.id } : { unresolvedName: trimmed };
    }
    const alt = (base !== '' && catalog.resolveAlias(base)) || (inner !== '' && catalog.resolveAlias(inner));
    if (alt) return { metricId: alt.id };
  }
  return { unresolvedName: trimmed };
}

// ---------------------------------------------------------------------------
// normalizeProposal
// ---------------------------------------------------------------------------

const CONFIDENCE_ORDER: ReadonlyArray<ProposedMeasurement['confidence']> = [
  'low',
  'medium',
  'high',
];

/** Lower confidence by one step, never below 'low'. */
function lowerConfidence(
  c: ProposedMeasurement['confidence'],
): ProposedMeasurement['confidence'] {
  const i = CONFIDENCE_ORDER.indexOf(c);
  return CONFIDENCE_ORDER[Math.max(0, i - 1)];
}

/**
 * Normalize a raw proposal: resolve an unresolved metric name and normalize
 * the unit string, filling the normalized fields while preserving `rawText`.
 * An unrecognized unit is dropped to undefined and confidence is lowered.
 * The input is never mutated; a new object is returned.
 */
export function normalizeProposal(
  p: ProposedMeasurement,
  catalog: Catalog,
): ProposedMeasurement {
  const out: ProposedMeasurement = { ...p };

  // Metric: attempt resolution only when still unresolved.
  if (typeof out.metric === 'object' && 'unresolvedName' in out.metric) {
    const resolved = resolveMetric(out.metric.unresolvedName, catalog);
    out.metric =
      'metricId' in resolved ? resolved.metricId : { unresolvedName: resolved.unresolvedName };
  }

  // Unit: normalize when present; drop and lower confidence if unrecognized.
  if (out.unit !== undefined) {
    const normalized = normalizeUnit(out.unit);
    if (normalized === undefined) {
      out.unit = undefined;
      out.confidence = lowerConfidence(out.confidence);
    } else {
      out.unit = normalized;
    }
  }

  return out;
}
