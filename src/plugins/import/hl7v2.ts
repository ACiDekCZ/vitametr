/**
 * HL7 v2 ORU^R01 lab import plugin (phase 2).
 *
 * Turns the OBX result segments of an HL7 v2 `ORU^R01` observation-result
 * message into reviewable `ProposedMeasurement`s.
 *
 * HL7 v2 layout recap: a message is a set of segments separated by CR and/or
 * LF; each segment is a list of fields separated by '|'; a field may hold
 * '^'-separated components. Field 0 of a segment is its name (MSH, PID, OBR,
 * OBX...). MSH is special — its declared field separator sits where field 1
 * would be, so MSH field numbers are shifted by one relative to the array
 * index; every other segment's array index equals its field number.
 *
 * Design rules (spec §16): never guess. Metric resolution prefers the LOINC
 * code of OBX-3 (`catalog.byLoinc`) and falls back to the observation text via
 * `catalog.resolveAlias`; an unresolved code stays `{ unresolvedName }`. Unit
 * and number parsing are delegated to `core/normalize.ts`.
 *
 * MVP scope: only OBX segments carrying a numeric value type ('NM' or 'SN')
 * become proposals. Text results ('ST', 'TX', 'CE', ...) are skipped. Malformed
 * or missing fields degrade gracefully and never throw.
 */

import type { Catalog, ImportContext, ImportInput, ImportPlugin } from '../../core/contracts.js';
import type { MetricId, Operator, ProposedMeasurement, TimePrecision } from '../../core/types.js';
import { normalizeUnit, parseNumber } from '../../core/normalize.js';

/** A parsed message timestamp: ISO string plus its precision. */
interface MessageDateTime {
  iso: string;
  precision: TimePrecision;
}

/** Segment name -> its '|'-split fields. Index equals field number (MSH aside). */
type Segment = string[];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Validate a calendar date without relying on the ambient clock. */
function isValidYmd(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(year, month - 1, day);
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
}

/**
 * Parse an HL7 timestamp `YYYYMMDD[HHMM[SS]]` into an ISO string. A leading
 * date is required; time components are optional (seconds default to 00 when a
 * time is present). Any trailing fraction/timezone is ignored. The ISO string
 * is built by hand — no ambient clock is consulted. Returns undefined for
 * anything that is not a valid date.
 */
function parseHl7Timestamp(raw: string): MessageDateTime | undefined {
  const s = raw.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?/.exec(s);
  if (!m) return undefined;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!isValidYmd(year, month, day)) return undefined;

  const date = `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;

  if (m[4] === undefined) {
    return { iso: date, precision: 'date' };
  }

  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] !== undefined ? Number(m[6]) : 0;
  if (hour > 23 || minute > 59 || second > 59) {
    // Invalid time component: keep the still-valid date rather than throwing.
    return { iso: date, precision: 'date' };
  }

  return {
    iso: `${date}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}`,
    precision: 'datetime',
  };
}

/** Split a raw message into named segments (fields already '|'-split). */
function splitSegments(message: string): Segment[] {
  return message
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => line.split('|'));
}

/** Read a field by index, returning '' when absent. */
function field(segment: Segment, index: number): string {
  const v = segment[index];
  return typeof v === 'string' ? v : '';
}

/**
 * The message-wide collection datetime: OBR-7 (first OBR) if present, else
 * MSH-7. Applied to every OBX that lacks its own OBX-14.
 */
function messageDateTime(segments: Segment[]): MessageDateTime | undefined {
  const obr = segments.find((s) => s[0] === 'OBR');
  if (obr) {
    const parsed = parseHl7Timestamp(field(obr, 7));
    if (parsed) return parsed;
  }
  const msh = segments.find((s) => s[0] === 'MSH');
  if (msh) {
    // MSH numbering is offset by one: MSH-7 lives at array index 6.
    const parsed = parseHl7Timestamp(field(msh, 6));
    if (parsed) return parsed;
  }
  return undefined;
}

/**
 * Resolve the metric of an OBX-3 `code^text^codingSystem`. A LOINC coding
 * ('LN'/'LOINC') is matched by code first; otherwise, and on a code miss, the
 * observation text is matched as an alias. Never guesses.
 */
function resolveMetric(
  obx3: string,
  catalog: Catalog,
): { metric: MetricId | { unresolvedName: string }; resolved: boolean } {
  const [code = '', text = '', system = ''] = obx3.split('^');
  const sys = system.trim().toUpperCase();

  if (code.trim() !== '' && (sys === 'LN' || sys === 'LOINC')) {
    const hit = catalog.byLoinc(code.trim());
    if (hit) return { metric: hit.id, resolved: true };
  }

  if (text.trim() !== '') {
    const hit = catalog.resolveAlias(text.trim());
    if (hit) return { metric: hit.id, resolved: true };
  }

  // Never guess: surface the best available human label for the review UI.
  return { metric: { unresolvedName: text.trim() || code.trim() }, resolved: false };
}

/**
 * Parse an OBX-7 reference range: `low-high`, one-sided `<X` / `>X`, or empty.
 * Delegates the numeric parsing (comma/point, operators) to `parseNumber`.
 */
function parseRefRange(raw: string): { refLow?: number; refHigh?: number } {
  const s = raw.trim();
  if (s === '') return {};

  const first = s[0];
  if (first === '<' || first === '>' || first === '≤' || first === '≥') {
    const r = parseNumber(s);
    if ('value' in r) {
      if (r.operator === '<' || r.operator === '<=') return { refHigh: r.value };
      if (r.operator === '>' || r.operator === '>=') return { refLow: r.value };
    }
    return {};
  }

  const m = /^([0-9][0-9.,]*)\s*-\s*([0-9][0-9.,]*)$/.exec(s);
  if (m) {
    const lo = parseNumber(m[1]);
    const hi = parseNumber(m[2]);
    const out: { refLow?: number; refHigh?: number } = {};
    if ('value' in lo) out.refLow = lo.value;
    if ('value' in hi) out.refHigh = hi.value;
    return out;
  }

  return {};
}

/** True for OBX value types that carry a numeric result. */
function isNumericValueType(vt: string): boolean {
  const t = vt.trim().toUpperCase();
  return t === 'NM' || t === 'SN';
}

/** Build a proposal for one OBX segment, or undefined when it is non-numeric. */
function obxToProposal(
  segment: Segment,
  rawLine: string,
  messageDt: MessageDateTime | undefined,
  catalog: Catalog,
): ProposedMeasurement | undefined {
  if (!isNumericValueType(field(segment, 2))) return undefined;

  // Value + optional censoring operator.
  const parsed = parseNumber(field(segment, 5));
  if (!('value' in parsed)) return undefined;
  const value = parsed.value;
  const operator: Operator | undefined = parsed.operator;

  // Metric.
  const { metric, resolved: metricResolved } = resolveMetric(field(segment, 3), catalog);

  // Unit (OBX-6): normalized to our UCUM code, undefined when unrecognized.
  const rawUnit = field(segment, 6).trim();
  const unitPresent = rawUnit !== '';
  const unit = unitPresent ? normalizeUnit(rawUnit) : undefined;

  // Reference range (OBX-7).
  const rawRef = field(segment, 7).trim();
  const { refLow, refHigh } = parseRefRange(rawRef);

  // Date: OBX-14 if present, else the message datetime.
  let takenAt: string | undefined;
  let timePrecision: TimePrecision | undefined;
  const ownDt = parseHl7Timestamp(field(segment, 14));
  const dt = ownDt ?? messageDt;
  if (dt) {
    takenAt = dt.iso;
    timePrecision = dt.precision;
  }

  // Confidence.
  const dateOk = takenAt !== undefined;
  const unitOk = !unitPresent || unit !== undefined;
  let confidence: ProposedMeasurement['confidence'];
  if (!metricResolved) confidence = 'low';
  else if (dateOk && unitOk) confidence = 'high';
  else confidence = 'medium';

  const proposal: ProposedMeasurement = { metric, value, confidence, rawText: rawLine };
  if (operator !== undefined) proposal.operator = operator;
  if (unit !== undefined) proposal.unit = unit;
  if (takenAt !== undefined) proposal.takenAt = takenAt;
  if (timePrecision !== undefined) proposal.timePrecision = timePrecision;
  if (refLow !== undefined) proposal.refLow = refLow;
  if (refHigh !== undefined) proposal.refHigh = refHigh;
  if (rawRef !== '') proposal.refText = rawRef;

  return proposal;
}

/**
 * Pure: turn an HL7 v2 ORU^R01 message into proposals. Exported for tests.
 * Only numeric OBX segments ('NM'/'SN') become proposals; text results are
 * skipped and everything degrades gracefully without throwing.
 */
export function parseHl7Oru(message: string, catalog: Catalog): ProposedMeasurement[] {
  const segments = splitSegments(message);
  const messageDt = messageDateTime(segments);

  const proposals: ProposedMeasurement[] = [];
  for (const segment of segments) {
    if (segment[0] !== 'OBX') continue;
    // Reconstruct the original line for rawText traceability.
    const rawLine = segment.join('|');
    const proposal = obxToProposal(segment, rawLine, messageDt, catalog);
    if (proposal) proposals.push(proposal);
  }
  return proposals;
}

export const hl7v2ImportPlugin: ImportPlugin = {
  id: 'hl7v2',
  nameKey: 'import.hl7v2',
  kind: 'file',
  accepts: ['.hl7', '.txt', 'application/hl7-v2', 'text/plain'],

  async parse(input: ImportInput, ctx: ImportContext): Promise<ProposedMeasurement[]> {
    let message: string;
    if (input.kind === 'file') {
      // File and Blob both expose .text().
      message = await input.file.text();
    } else {
      message = typeof input.data === 'string' ? input.data : '';
    }
    return parseHl7Oru(message, ctx.catalog);
  },
};
