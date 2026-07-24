/**
 * CSV import core (phase 2).
 *
 * Pure, DOM-free functions that turn raw CSV text into reviewable
 * `ProposedMeasurement`s:
 *  - {@link parseCsv} — RFC 4180 tokenizer with delimiter auto-detection.
 *  - {@link guessMapping} — pre-fills a column→field mapping from header names.
 *  - {@link isMappingComplete} — the minimum a mapping must cover to proceed.
 *  - {@link buildProposals} — one proposal per data row, resolved against the
 *    catalog and normalized through `core/normalize.ts`.
 *
 * Design rules (spec §16): never guess. Number/unit/date parsing is delegated
 * to `core/normalize.ts` — this module adds no parsing of its own beyond the
 * CSV grammar itself and trimming a source-specific timezone suffix off dates.
 */

import type { Catalog } from './contracts.js';
import type {
  MetricId,
  Operator,
  ProposedMeasurement,
  TimePrecision,
} from './types.js';
import {
  normalizeUnit,
  parseDateTime,
  parseNumber,
  resolveMetric,
} from './normalize.js';

// ---------------------------------------------------------------------------
// parseCsv
// ---------------------------------------------------------------------------

export interface CsvTable {
  headers: string[];
  rows: string[][];
  delimiter: ',' | ';' | '\t';
}

const DELIMITERS: ReadonlyArray<CsvTable['delimiter']> = [',', ';', '\t'];

/**
 * RFC 4180 tokenizer for a single, known delimiter. Handles double-quoted
 * fields (with escaped `""`), quoted fields containing the delimiter or
 * newlines, and CRLF / LF / lone-CR line endings. Never throws.
 */
function tokenize(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const endField = (): void => {
    record.push(field);
    field = '';
  };
  const endRecord = (): void => {
    endField();
    records.push(record);
    record = [];
  };

  while (i < n) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === delimiter) {
      endField();
      i += 1;
      continue;
    }
    if (c === '\r') {
      if (text[i + 1] === '\n') i += 1; // consume the LF of a CRLF pair
      endRecord();
      i += 1;
      continue;
    }
    if (c === '\n') {
      endRecord();
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }

  // Flush a trailing field/record that was not terminated by a newline.
  if (field !== '' || record.length > 0) endRecord();

  return records;
}

/** A record that is a single empty field is a blank line — dropped. */
function isBlank(record: string[]): boolean {
  return record.length === 1 && record[0] === '';
}

/**
 * Choose the delimiter that splits the header line into the most columns.
 * Ties keep the earlier candidate (comma > semicolon > tab), so a file with
 * no delimiter at all defaults to comma.
 */
function detectDelimiter(text: string): CsvTable['delimiter'] {
  let best: CsvTable['delimiter'] = ',';
  let bestCols = 0;
  for (const d of DELIMITERS) {
    const records = tokenize(text, d);
    const header = records.find((r) => !isBlank(r));
    const cols = header ? header.length : 0;
    if (cols > bestCols) {
      bestCols = cols;
      best = d;
    }
  }
  return best;
}

/** Pad with empty strings or truncate a row to the header width. */
function fitWidth(row: string[], width: number): string[] {
  if (row.length === width) return row;
  if (row.length > width) return row.slice(0, width);
  return [...row, ...Array<string>(width - row.length).fill('')];
}

/**
 * Parse CSV text into a table. Auto-detects the delimiter (',', ';' or tab)
 * from the header line. Empty input yields an empty table. Malformed rows are
 * padded / truncated to the header width rather than throwing.
 */
export function parseCsv(text: string): CsvTable {
  if (text === '') return { headers: [], rows: [], delimiter: ',' };

  const delimiter = detectDelimiter(text);
  const records = tokenize(text, delimiter).filter((r) => !isBlank(r));
  if (records.length === 0) return { headers: [], rows: [], delimiter };

  const headers = records[0];
  const width = headers.length;
  const rows = records.slice(1).map((r) => fitWidth(r, width));
  return { headers, rows, delimiter };
}

// ---------------------------------------------------------------------------
// guessMapping
// ---------------------------------------------------------------------------

export type CsvField =
  | 'metric'
  | 'loinc'
  | 'value'
  | 'unit'
  | 'date'
  | 'refLow'
  | 'refHigh'
  | 'source'
  | 'note';

/** mapping[columnIndex] = CsvField | undefined (column ignored). */
export type CsvMapping = (CsvField | undefined)[];

/** Case- and diacritics-insensitive normalization of a header name. */
function normalizeHeader(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritical marks
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Synonyms per field (already normalized: lowercased, diacritics-stripped).
 * Fields are ordered by priority so a header that could match two fields is
 * assigned to the earlier one.
 */
const FIELD_SYNONYMS: ReadonlyArray<readonly [CsvField, readonly string[]]> = [
  ['loinc', ['loinc', 'code', 'kod']],
  ['metric', ['metric', 'velicina', 'test', 'analyt', 'description', 'nazev']],
  ['value', ['value', 'hodnota', 'vysledek']],
  ['unit', ['unit', 'units', 'jednotka']],
  ['date', ['date', 'datum']],
  ['refLow', ['ref low', 'dolni mez', 'low', 'min']],
  ['refHigh', ['ref high', 'horni mez', 'high', 'max']],
  ['source', ['source', 'zdroj', 'laborator']],
  ['note', ['note', 'poznamka']],
];

/** The field a header name matches, or undefined if it matches nothing. */
function matchField(header: string): CsvField | undefined {
  const key = normalizeHeader(header);
  if (key === '') return undefined;
  for (const [field, synonyms] of FIELD_SYNONYMS) {
    if (synonyms.includes(key)) return field;
  }
  return undefined;
}

/**
 * Pre-fill a mapping from header names, matching cs+en synonyms
 * case/diacritics-insensitively. Recognizes Synthea columns (CODE→loinc,
 * DESCRIPTION→metric, VALUE, UNITS, DATE). A header matching nothing is left
 * undefined. Each field is assigned to at most one column (first match wins);
 * metric and loinc are distinct fields, so both may be mapped together.
 */
export function guessMapping(headers: string[]): CsvMapping {
  const used = new Set<CsvField>();
  return headers.map((header) => {
    const field = matchField(header);
    if (field === undefined || used.has(field)) return undefined;
    used.add(field);
    return field;
  });
}

/**
 * A mapping is usable once it covers a value column, a date column, and at
 * least one of metric / loinc.
 */
export function isMappingComplete(mapping: CsvMapping): boolean {
  const has = (f: CsvField): boolean => mapping.includes(f);
  return has('value') && has('date') && (has('metric') || has('loinc'));
}

// ---------------------------------------------------------------------------
// Locale-sensitive formats (decimal separator + date component order)
//
// The number/date format is a property of the FILE, not the app's UI locale.
// We detect it where the data allows an unambiguous read and otherwise report
// 'ambiguous' so the UI can force an explicit choice — never a silent guess
// (a misread date or value is exactly the kind of error spec §16 forbids).
// ---------------------------------------------------------------------------

export type DecimalSeparator = '.' | ',';
export type DateOrder = 'ymd' | 'dmy' | 'mdy';

export interface CsvFormats {
  decimal: DecimalSeparator;
  dateOrder: DateOrder;
}

export interface DetectedFormats {
  decimal: DecimalSeparator;
  /** 'ambiguous' when every sampled date has all components <= 12. */
  dateOrder: DateOrder | 'ambiguous';
}

const ISO_DATE = /^\d{4}-\d{1,2}-\d{1,2}/;

function columnCells(table: CsvTable, idx: number | undefined): string[] {
  if (idx === undefined) return [];
  return table.rows.map((r) => (r[idx] ?? '').trim()).filter((s) => s !== '');
}

/** The decimal separator implied by a single numeric cell, if any. */
function cellDecimal(cell: string): DecimalSeparator | undefined {
  const lastComma = cell.lastIndexOf(',');
  const lastDot = cell.lastIndexOf('.');
  if (lastComma === -1 && lastDot === -1) return undefined;
  // The separator closest to the end (fewest trailing digits) is the decimal;
  // the other, if present, is a thousands group.
  return lastComma > lastDot ? ',' : '.';
}

/**
 * Detect the file's decimal separator and date order from the mapped value and
 * date columns. Decimal defaults to '.'; date order is 'ambiguous' when the
 * data cannot disambiguate day-first from month-first.
 */
export function detectFormats(table: CsvTable, mapping: CsvMapping): DetectedFormats {
  // Decimal: majority vote over value cells.
  const valueIdx = indexOfField(mapping, 'value');
  let comma = 0;
  let dot = 0;
  for (const c of columnCells(table, valueIdx)) {
    const sep = cellDecimal(c);
    if (sep === ',') comma++;
    else if (sep === '.') dot++;
  }
  const decimal: DecimalSeparator = comma > dot ? ',' : '.';

  // Date order.
  const dateIdx = indexOfField(mapping, 'date');
  let sawSlashOrDot = false;
  let firstOver12 = false;
  let secondOver12 = false;
  let anyIso = false;
  for (const c of columnCells(table, dateIdx)) {
    if (ISO_DATE.test(c)) {
      anyIso = true;
      continue;
    }
    const parts = c.split(/[./-]/).map((p) => parseInt(p, 10));
    if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) continue;
    sawSlashOrDot = true;
    if (parts[0] > 12) firstOver12 = true;
    if (parts[1] > 12) secondOver12 = true;
  }
  let dateOrder: DetectedFormats['dateOrder'];
  if (firstOver12) dateOrder = 'dmy';
  else if (secondOver12) dateOrder = 'mdy';
  else if (anyIso && !sawSlashOrDot) dateOrder = 'ymd';
  else if (sawSlashOrDot) dateOrder = 'ambiguous';
  else dateOrder = 'ymd';

  return { decimal, dateOrder };
}

/** Rewrite a numeric string to canonical form (point decimal, no grouping). */
function applyDecimal(raw: string, decimal: DecimalSeparator): string {
  if (decimal === ',') {
    return raw.replace(/\./g, '').replace(/,/g, '.');
  }
  return raw.replace(/,/g, '');
}

/** Parse a date honoring an explicit component order; returns undefined if invalid. */
function parseDateWithOrder(
  raw: string,
  order: DateOrder,
): { iso: string; precision: TimePrecision } | undefined {
  const cleaned = stripTimezone(raw);
  if (ISO_DATE.test(cleaned)) return parseDateTime(cleaned);

  const [datePart, timePart] = cleaned.split(/[T ]/, 2);
  const parts = datePart.split(/[./-]/).map((p) => p.trim());
  if (parts.length !== 3 || parts.some((p) => p === '')) return undefined;

  let y: string, m: string, d: string;
  if (order === 'dmy') [d, m, y] = parts;
  else if (order === 'mdy') [m, d, y] = parts;
  else [y, m, d] = parts;
  if (y.length === 2) y = `20${y}`;

  const iso = `${y.padStart(4, '0')}-${m.padStart(2, '0')}-${d.padStart(2, '0')}${
    timePart ? `T${timePart}` : ''
  }`;
  return parseDateTime(iso);
}

// ---------------------------------------------------------------------------
// buildProposals
// ---------------------------------------------------------------------------

/** Index of the first column mapped to `field`, or undefined. */
function indexOfField(mapping: CsvMapping, field: CsvField): number | undefined {
  const i = mapping.indexOf(field);
  return i === -1 ? undefined : i;
}

/**
 * Strip a trailing timezone marker (`Z` or `±HH:MM` / `±HHMM`) so an
 * otherwise-ISO timestamp reaches `parseDateTime`, which handles wall-clock
 * strings only. Synthea emits UTC-suffixed timestamps; the wall-clock
 * date/time is preserved, the zone designator (sub-day precision) is dropped.
 */
function stripTimezone(raw: string): string {
  return raw.trim().replace(/\s*(?:Z|[+-]\d{2}:?\d{2})$/, '');
}

/** Numeric-only parse for reference bounds (operators/errors ignored). */
function parseNumericOnly(raw: string): number | undefined {
  const r = parseNumber(raw);
  return 'value' in r ? r.value : undefined;
}

/**
 * Build one `ProposedMeasurement` per data row. Metric resolution prefers a
 * mapped LOINC code (`catalog.byLoinc`) and falls back to a mapped name
 * (`resolveAlias`); unmatched names stay `{ unresolvedName }` — never guessed.
 * Rows whose value cell is empty or not a number are dropped.
 */
export function buildProposals(
  table: CsvTable,
  mapping: CsvMapping,
  catalog: Catalog,
  formats?: CsvFormats,
): ProposedMeasurement[] {
  const metricIdx = indexOfField(mapping, 'metric');
  const loincIdx = indexOfField(mapping, 'loinc');
  const valueIdx = indexOfField(mapping, 'value');
  const unitIdx = indexOfField(mapping, 'unit');
  const dateIdx = indexOfField(mapping, 'date');
  const refLowIdx = indexOfField(mapping, 'refLow');
  const refHighIdx = indexOfField(mapping, 'refHigh');
  const sourceIdx = indexOfField(mapping, 'source');
  const noteIdx = indexOfField(mapping, 'note');

  const proposals: ProposedMeasurement[] = [];
  if (valueIdx === undefined) return proposals; // no value column → nothing usable

  const cell = (row: string[], idx: number | undefined): string =>
    idx === undefined ? '' : (row[idx] ?? '');

  for (const row of table.rows) {
    // Value — drop rows without a usable number. When an explicit decimal
    // separator is given, canonicalize the cell first so grouping vs decimal
    // is unambiguous.
    const valueRaw = cell(row, valueIdx);
    const parsedValue = parseNumber(
      formats ? applyDecimal(valueRaw, formats.decimal) : valueRaw,
    );
    if (!('value' in parsedValue)) continue;

    // Metric — LOINC first, then name; never guessed.
    let metric: MetricId | { unresolvedName: string } = { unresolvedName: '' };
    let metricResolved = false;
    if (loincIdx !== undefined) {
      const code = cell(row, loincIdx).trim();
      const hit = code ? catalog.byLoinc(code) : undefined;
      if (hit) {
        metric = hit.id;
        metricResolved = true;
      }
    }
    if (!metricResolved) {
      if (metricIdx !== undefined) {
        const resolved = resolveMetric(cell(row, metricIdx), catalog);
        if ('metricId' in resolved) {
          metric = resolved.metricId;
          metricResolved = true;
        } else {
          metric = { unresolvedName: resolved.unresolvedName };
        }
      } else if (loincIdx !== undefined) {
        metric = { unresolvedName: cell(row, loincIdx).trim() };
      } else {
        metric = { unresolvedName: '' };
      }
    }

    // Unit — normalize when a unit column is mapped (undefined if unrecognized).
    const unit = unitIdx === undefined ? undefined : normalizeUnit(cell(row, unitIdx));

    // Date — parse when a date column is mapped. With an explicit date order,
    // honor it (so day-first vs month-first is never guessed); otherwise fall
    // back to the auto-detecting parser.
    let takenAt: string | undefined;
    let timePrecision: TimePrecision | undefined;
    if (dateIdx !== undefined) {
      const dateRaw = cell(row, dateIdx);
      const parsedDate = formats
        ? parseDateWithOrder(dateRaw, formats.dateOrder)
        : parseDateTime(stripTimezone(dateRaw));
      if (parsedDate) {
        takenAt = parsedDate.iso;
        timePrecision = parsedDate.precision;
      }
    }

    // Reference bounds — numeric only.
    const refLow = refLowIdx === undefined ? undefined : parseNumericOnly(cell(row, refLowIdx));
    const refHigh =
      refHighIdx === undefined ? undefined : parseNumericOnly(cell(row, refHighIdx));

    // Source / note — raw text.
    const sourceRaw = sourceIdx === undefined ? '' : cell(row, sourceIdx).trim();
    const noteRaw = noteIdx === undefined ? '' : cell(row, noteIdx).trim();

    // Confidence: value is always ok here (rows without it were dropped).
    const unitColumnExists = unitIdx !== undefined;
    const unitOk = !unitColumnExists || unit !== undefined;
    const dateOk = takenAt !== undefined;
    let confidence: ProposedMeasurement['confidence'];
    if (!metricResolved) confidence = 'low';
    else if (dateOk && unitOk) confidence = 'high';
    else confidence = 'medium';

    const proposal: ProposedMeasurement = {
      metric,
      value: parsedValue.value,
      confidence,
      rawText: row.join(table.delimiter),
    };
    const operator: Operator | undefined = parsedValue.operator;
    if (operator !== undefined) proposal.operator = operator;
    if (unit !== undefined) proposal.unit = unit;
    if (takenAt !== undefined) proposal.takenAt = takenAt;
    if (timePrecision !== undefined) proposal.timePrecision = timePrecision;
    if (refLow !== undefined) proposal.refLow = refLow;
    if (refHigh !== undefined) proposal.refHigh = refHigh;
    if (sourceRaw !== '') proposal.sourceName = sourceRaw;
    if (noteRaw !== '') proposal.note = noteRaw;

    proposals.push(proposal);
  }

  return proposals;
}
