/**
 * Lab-result line parser (phase 3).
 *
 * A PDF lab sheet is extracted to text lines elsewhere (pdf.js — not this
 * module's concern). This file is the PURE function that turns those lines
 * into measurement proposals. It has zero runtime dependencies beyond the
 * shared normalization helpers and never touches the DOM, storage or a clock.
 *
 * A typical analyte row looks like:
 *
 *   <name words> <value> [flag] <unit> <refLow> - <refHigh>
 *
 * where the flag (H / L / * or the Czech arrows ↑ / ↓) is optional and the
 * value uses a decimal comma. The document's draw date lives once in the
 * header ("Odběr: 10.02.2023 07:45") and is shared by every proposal.
 *
 * Design rule (spec §16): never guess. An unrecognized unit or metric name is
 * reported as such; a line that lacks both a numeric value AND a recognized
 * unit is not an analyte row and produces nothing — this is how title, meta
 * and column-header lines fall away naturally.
 */

import type { Catalog } from '../../core/contracts.js';
import type { Metric, ProposedMeasurement } from '../../core/types.js';
import { normalizeUnit, parseDateTime, parseNumber, resolveMetric } from '../../core/normalize.js';
import { createUnitsEngine, isUnitCompatibleWithMetric } from '../../core/units.js';

/**
 * Shared units engine for the import dimension guard. Built from the built-in
 * unit table; pure and read-only here (never reloaded), so a single instance is
 * safe to share across calls.
 */
const unitsEngine = createUnitsEngine();

/** A Czech date DD.MM.YYYY, optionally followed by a HH:MM time. */
const DATE_RE = /(\d{1,2}\.\d{1,2}\.\d{4}(?:[ \t]+\d{1,2}:\d{2})?)/;

/** A bare number: decimal comma or point, no sign, no operator. */
const NUM = String.raw`\d+(?:[.,]\d+)?`;

/**
 * Trailing reference expressions, tried in order. Every pattern is anchored at
 * the end of the line and starts with `\s+`, so it only ever consumes the
 * range that follows the value+unit — never part of them.
 *
 * Supported styles:
 *  - `od X do Y`            -> refLow = X, refHigh = Y   (Czech "from X to Y")
 *  - `X - Y` / `X – Y`      -> refLow = X, refHigh = Y   (hyphen or en dash)
 *  - `do X`                 -> refHigh = X               (Czech "up to X")
 *  - `nad X`                -> refLow = X                (Czech "above X")
 *  - `< X` / `≤ X` / `<= X` -> refHigh = X
 *  - `> X` / `≥ X` / `>= X` -> refLow = X
 *
 * The Czech `od …/do …/nad …` word forms are matched case-insensitively and
 * require whitespace on both sides, so they never bite into a metric name.
 */
const REF_OD_DO_RE = new RegExp(String.raw`\s+od\s+(${NUM})\s+do\s+(${NUM})\s*$`, 'i');
const REF_RANGE_RE = new RegExp(String.raw`\s+(${NUM})\s*[-–]\s*(${NUM})\s*$`);
const REF_DO_RE = new RegExp(String.raw`\s+do\s+(${NUM})\s*$`, 'i');
const REF_NAD_RE = new RegExp(String.raw`\s+nad\s+(${NUM})\s*$`, 'i');
const REF_LE_RE = new RegExp(String.raw`\s+(?:<=|≤|<)\s*(${NUM})\s*$`);
const REF_GE_RE = new RegExp(String.raw`\s+(?:>=|≥|>)\s*(${NUM})\s*$`);

/** A result flag sitting between the value and the unit (H, L, *, ↑, ↓). */
const FLAG_RE = /^(?:[HL]|\*|↑|↓)$/i;

/** A standalone censoring operator token sitting before the value number. */
const OPERATOR_TOKEN_RE = /^(?:<=|>=|≤|≥|<|>)$/;

interface ReferenceMatch {
  refLow?: number;
  refHigh?: number;
  refText: string;
  /** Index in the working string where the matched expression begins. */
  index: number;
}

/** Parse a bare numeric bound; undefined when it is not a plain number. */
function parseBound(raw: string): number | undefined {
  const parsed = parseNumber(raw);
  return 'value' in parsed ? parsed.value : undefined;
}

/**
 * Strip and interpret the trailing reference expression, if any. Returns the
 * parsed bounds, the original range text, and where it started so the caller
 * can remove it from the line.
 */
function extractReference(working: string): ReferenceMatch | undefined {
  let m = REF_OD_DO_RE.exec(working);
  if (m) {
    return { refLow: parseBound(m[1]), refHigh: parseBound(m[2]), refText: m[0].trim(), index: m.index };
  }
  m = REF_RANGE_RE.exec(working);
  if (m) {
    return { refLow: parseBound(m[1]), refHigh: parseBound(m[2]), refText: m[0].trim(), index: m.index };
  }
  m = REF_DO_RE.exec(working);
  if (m) {
    return { refHigh: parseBound(m[1]), refText: m[0].trim(), index: m.index };
  }
  m = REF_NAD_RE.exec(working);
  if (m) {
    return { refLow: parseBound(m[1]), refText: m[0].trim(), index: m.index };
  }
  m = REF_LE_RE.exec(working);
  if (m) {
    return { refHigh: parseBound(m[1]), refText: m[0].trim(), index: m.index };
  }
  m = REF_GE_RE.exec(working);
  if (m) {
    return { refLow: parseBound(m[1]), refText: m[0].trim(), index: m.index };
  }
  return undefined;
}

/** Scan all lines for the document's draw date; the first hit wins. */
function findDocumentDate(lines: string[]): { iso: string; precision: 'date' | 'datetime' } | undefined {
  for (const line of lines) {
    const match = DATE_RE.exec(line);
    if (!match) continue;
    const parsed = parseDateTime(match[1]);
    if (parsed) return parsed;
  }
  return undefined;
}

/**
 * Try to parse a single line into a proposal. Returns undefined when the line
 * is not an analyte row (no numeric value together with a recognized unit).
 */
function parseLine(
  rawText: string,
  catalog: Catalog,
  date: { iso: string; precision: 'date' | 'datetime' } | undefined,
): ProposedMeasurement | undefined {
  // 1. Strip a trailing reference expression, if present.
  let refLow: number | undefined;
  let refHigh: number | undefined;
  let refText: string | undefined;
  let working = rawText.trim();

  const refMatch = extractReference(working);
  if (refMatch) {
    refLow = refMatch.refLow;
    refHigh = refMatch.refHigh;
    refText = refMatch.refText;
    working = working.slice(0, refMatch.index).trim();
  }

  const tokens = working.length > 0 ? working.split(/\s+/) : [];
  if (tokens.length === 0) return undefined;

  // 2. Unit: right-to-left, the first token normalizeUnit recognizes.
  let unitIndex = -1;
  let unitCode: string | undefined;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const code = normalizeUnit(tokens[i]);
    if (code !== undefined) {
      unitIndex = i;
      unitCode = code;
      break;
    }
  }
  if (unitIndex < 0 || unitCode === undefined) return undefined;

  // 3. Value: the numeric token immediately before the unit, skipping at most
  //    one flag token (H / L / * / ↑ / ↓) between the value and the unit. A
  //    censoring operator sitting just before the number (e.g. `< 0,10`) is
  //    folded back in so parseNumber captures the operator.
  let valueIndex = unitIndex - 1;
  if (valueIndex >= 0 && FLAG_RE.test(tokens[valueIndex])) valueIndex -= 1;
  if (valueIndex < 0) return undefined;

  let valueStart = valueIndex;
  if (valueStart - 1 >= 0 && OPERATOR_TOKEN_RE.test(tokens[valueStart - 1])) {
    valueStart -= 1;
  }

  const valueText = tokens.slice(valueStart, valueIndex + 1).join(' ');
  const parsedValue = parseNumber(valueText);
  if ('error' in parsedValue) return undefined;

  // 4. Name: everything before the value (and its operator) token.
  const name = tokens.slice(0, valueStart).join(' ').trim();
  if (name === '') return undefined;
  // Reject obvious non-analyte rows: a label ending in ':' (e.g. "Evaluation:")
  // or a "name" that is only digits/punctuation (a scrambled multi-column row).
  if (name.endsWith(':')) return undefined;
  if (!/\p{L}/u.test(name)) return undefined;

  // 5. Metric: resolve against the catalog; never guess.
  //    Dimension guard (spec §16, data integrity): a resolved name is only kept
  //    when the parsed unit is dimensionally compatible with that metric. A
  //    genuine mismatch (e.g. a GFR rate unit resolving onto creatinine via a
  //    "(Krea)" qualifier, or a urine-sediment count onto blood erythrocytes)
  //    is discarded and the row goes to review as unresolved — never a wrong
  //    metric.
  const resolved = resolveMetric(name, catalog);
  let metric: Metric['id'] | { unresolvedName: string };
  if ('metricId' in resolved) {
    const m = catalog.byId(resolved.metricId);
    metric =
      m && !isUnitCompatibleWithMetric(unitsEngine, m, unitCode)
        ? { unresolvedName: name }
        : resolved.metricId;
  } else {
    metric = { unresolvedName: resolved.unresolvedName };
  }

  // 6. Confidence: high needs a resolved metric AND a recognized unit AND a
  //    date. The unit is always recognized here, so a resolved metric is high
  //    when a date exists, otherwise medium; an unresolved metric is low.
  const isUnresolved = typeof metric === 'object' && 'unresolvedName' in metric;
  let confidence: ProposedMeasurement['confidence'];
  if (isUnresolved) confidence = 'low';
  else confidence = date ? 'high' : 'medium';

  const proposal: ProposedMeasurement = {
    metric,
    value: parsedValue.value,
    unit: unitCode,
    confidence,
    rawText,
  };
  if (parsedValue.operator !== undefined) proposal.operator = parsedValue.operator;
  if (refLow !== undefined) proposal.refLow = refLow;
  if (refHigh !== undefined) proposal.refHigh = refHigh;
  if (refText !== undefined) proposal.refText = refText;
  if (date) {
    proposal.takenAt = date.iso;
    proposal.timePrecision = date.precision;
  }

  return proposal;
}

// ---------------------------------------------------------------------------
// Qualitative (dipstick / semi-quant) rows
// ---------------------------------------------------------------------------

/**
 * Recognized qualitative result phrases (urine dipstick and semi-quant
 * screens). Compared case- and diacritics-insensitively. This list governs
 * only VALUE validity — a row becomes a proposal solely when its NAME resolves
 * to a text/enum/multi metric, so prose lines can never slip through here.
 */
const QUALITATIVE_PHRASES: readonly string[] = [
  'bez nálezu',
  'v mezích',
  'nenalezeno',
  'slabě pozitivní',
  'silně pozitivní',
  'negativní',
  'negativ',
  'pozitivní',
  'pozitiv',
  'stopy',
  'stopově',
  'normální',
  'zvýšený',
  'snížený',
  'negative',
  'positive',
  'trace',
  'normal',
  'abnormal',
];

/** A dipstick plus-grade token: `+`…`++++` or `1+`…`4+`. */
const PLUS_GRADE_RE = /^(?:\+{1,4}|[1-4]\+)$/;

/** Lowercase and strip diacritics for tolerant phrase comparison. */
function fold(s: string): string {
  return s.trim().toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

/**
 * Interpret the tokens after a resolved metric name as a qualitative value.
 * For enum/multi metrics only the metric's own `enumValues` are accepted; for
 * a text metric a recognized qualitative phrase or a plus-grade token. Returns
 * the value in its canonical/original spelling, or undefined when the tokens
 * are not a qualitative value (so the row is left for review — never guessed).
 */
function matchQualitativeValue(valueTokens: string[], metric: Metric): string | undefined {
  if (valueTokens.length === 0) return undefined;
  if (metric.valueType === 'enum' || metric.valueType === 'multi') {
    const allowed = metric.enumValues ?? [];
    for (const n of [2, 1]) {
      const phrase = valueTokens.slice(0, n).join(' ');
      const hit = allowed.find((v) => fold(v) === fold(phrase));
      if (hit) return hit;
    }
    return undefined;
  }
  for (const n of [2, 1]) {
    const phrase = valueTokens.slice(0, n).join(' ');
    if (QUALITATIVE_PHRASES.some((q) => fold(q) === fold(phrase))) return phrase;
  }
  if (PLUS_GRADE_RE.test(valueTokens[0])) return valueTokens[0];
  return undefined;
}

/**
 * Try to read a line as a qualitative row: `<name> <value> [reference]`, where
 * the value has no unit (e.g. "Glukóza v moči negativní"). Conservative by
 * design — emitted only when the longest resolving name prefix is a
 * text/enum/multi metric AND the following token is a known qualitative value.
 * A name that resolves to a numeric metric yields nothing (spec §16).
 */
function parseQualitativeLine(
  rawText: string,
  catalog: Catalog,
  date: { iso: string; precision: 'date' | 'datetime' } | undefined,
): ProposedMeasurement | undefined {
  const tokens = rawText.trim().split(/\s+/);
  if (tokens.length < 2) return undefined;

  // Longest name prefix first, so "Glukóza v moči" wins over "Glukóza".
  for (let i = tokens.length - 1; i >= 1; i--) {
    const name = tokens.slice(0, i).join(' ');
    if (name.endsWith(':') || !/\p{L}/u.test(name)) continue;
    const metric = catalog.resolveAlias(name);
    if (!metric) continue;
    // A numeric metric is not a qualitative row; a shorter prefix would only be
    // a worse match, so stop rather than guess.
    if (metric.valueType === 'number') return undefined;

    const value = matchQualitativeValue(tokens.slice(i), metric);
    if (value === undefined) return undefined;

    const proposal: ProposedMeasurement = {
      metric: metric.id,
      confidence: date ? 'high' : 'medium',
      rawText,
    };
    if (metric.valueType === 'multi') proposal.textValues = [value];
    else proposal.textValue = value;
    if (date) {
      proposal.takenAt = date.iso;
      proposal.timePrecision = date.precision;
    }
    return proposal;
  }
  return undefined;
}

/**
 * Parse lab-sheet text lines into measurement proposals. Pure: the same input
 * always yields the same output. The draw date is discovered once and shared
 * by every proposal (a lab sheet reflects a single blood draw).
 *
 * Each line is tried as a numeric analyte row first, then as a qualitative
 * (dipstick) row; only the first that matches produces a proposal.
 */
export function parseLabLines(lines: string[], catalog: Catalog): ProposedMeasurement[] {
  const date = findDocumentDate(lines);
  const proposals: ProposedMeasurement[] = [];
  for (const line of lines) {
    const proposal = parseLine(line, catalog, date) ?? parseQualitativeLine(line, catalog, date);
    if (proposal) proposals.push(proposal);
  }
  return proposals;
}
