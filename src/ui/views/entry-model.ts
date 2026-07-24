/**
 * Add Values (entry) screen — DOM-free logic (K8c).
 *
 * These pure helpers are the testable core of the entry view: metric search,
 * per-field value validation, and building the {@link ManualEntryInput} payload
 * the shared import pipeline consumes. They never touch the DOM, storage or the
 * clock — the view supplies raw strings and the resolved date/source, so the
 * same rules can be unit-tested in a node environment.
 */

import type { Catalog, UnitsEngine } from '../../core/contracts';
import type { Metric, MetricId, Operator, UnitSystem } from '../../core/types';
import type { Locale } from '../../i18n/index';
import type { ManualEntryField, ManualEntryInput } from '../../plugins/import/manual';
import { parseNumber, parseDateTime, resolveMetric, type ParsedDateTime } from '../../core/normalize';
import { preferredUnitFor } from './overview-model';

// ---------------------------------------------------------------------------
// Name normalization (mirrors the catalog's case/diacritics-insensitive rule)
// ---------------------------------------------------------------------------

function foldName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Metric picker
// ---------------------------------------------------------------------------

/**
 * Filter the catalog by a free-text query, matching across a metric's key,
 * custom name, aliases and (optionally) its localized display name. An empty
 * query returns the first `limit` metrics so the picker can show suggestions.
 */
export function filterMetrics(
  query: string,
  catalog: Catalog,
  nameOf?: (metric: Metric) => string,
  limit = 20,
): Metric[] {
  const all = catalog.all();
  const needle = foldName(query);
  if (needle === '') return all.slice(0, limit);

  const hits = all.filter((metric) => {
    const candidates = [metric.key, metric.customName, ...metric.aliases];
    if (nameOf) candidates.push(nameOf(metric));
    return candidates.some((c) => c !== undefined && foldName(c).includes(needle));
  });
  return hits.slice(0, limit);
}

/** Metrics that are entered together (same `entryGroup`), catalog order. */
export function metricsInGroup(catalog: Catalog, group: string): Metric[] {
  return catalog.all().filter((metric) => metric.entryGroup === group);
}

/**
 * Distinct metric ids the profile has measured, most-recently-used first. Powers
 * the quick-add chips: for each metric we keep its latest `takenAt`, then order
 * metrics by that timestamp (newest first) and take the first `limit`. Ties keep
 * first-seen order. Returns an empty array when there are no measurements yet.
 */
export function recentMetricIds(
  measurements: readonly { metricId: MetricId; takenAt: string }[],
  limit = 5,
): MetricId[] {
  const latest = new Map<MetricId, string>();
  for (const m of measurements) {
    const prev = latest.get(m.metricId);
    if (prev === undefined || m.takenAt > prev) latest.set(m.metricId, m.takenAt);
  }
  return [...latest.entries()]
    .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
    .slice(0, Math.max(0, limit))
    .map(([id]) => id);
}

/**
 * Resolve a typed metric name to a concrete id, or report it as unresolved.
 * Never guesses — an unknown name is returned verbatim so the view can offer
 * to create a new metric (spec §16).
 */
export function resolveMetricSelection(
  name: string,
  catalog: Catalog,
): { metricId: MetricId } | { unresolvedName: string } {
  return resolveMetric(name, catalog);
}

/**
 * Default unit for a freshly picked metric: the last unit the user recorded it
 * in, else the metric's preferred unit for the active unit system (or, in 'auto'
 * / when absent, the locale preference), else the canonical unit. The unit-system
 * mapping is shared with the display resolver via {@link preferredUnitFor}.
 */
export function defaultUnitFor(
  metric: Metric,
  locale: string,
  lastUsed?: string,
  unitSystem?: UnitSystem,
): string {
  if (lastUsed && metric.units.includes(lastUsed)) return lastUsed;
  return preferredUnitFor(metric, unitSystem, locale as Locale) ?? metric.canonicalUnit;
}

// ---------------------------------------------------------------------------
// Field validation
// ---------------------------------------------------------------------------

export interface ValidateOptions {
  /** The unit the value is being entered in (for typical-range checking). */
  unit?: string;
  /** Units engine, used to convert to canonical before the range check. */
  units?: UnitsEngine;
}

export type FieldValidation =
  | { ok: false }
  | { ok: true; value: number; operator?: Operator; warning: boolean }
  | { ok: true; text: string; warning: false };

/**
 * Validate one raw value against its metric. A text/enum/multi metric accepts
 * any non-empty string. A number metric returns `ok: false` for anything that is
 * not a number (the view shows `entry.invalidValue`). A parseable numeric value
 * outside the metric's `typicalRange` is still `ok`, but flagged with
 * `warning: true` (non-blocking `entry.unusualValue`) — a typo/unit sanity nudge,
 * never medical advice.
 */
export function validateField(
  raw: string,
  metric: Metric | undefined,
  opts: ValidateOptions = {},
): FieldValidation {
  // Qualitative metrics: any non-empty string is a valid value.
  if (metric && metric.valueType !== 'number') {
    const text = raw.trim();
    return text === '' ? { ok: false } : { ok: true, text, warning: false };
  }

  const parsed = parseNumber(raw);
  if ('error' in parsed) return { ok: false };

  const { value } = parsed;
  let warning = false;

  const range = metric?.typicalRange;
  if (metric && range) {
    let canonical = value;
    const { unit, units } = opts;
    if (unit && units && unit !== metric.canonicalUnit) {
      const conv = units.convert(value, unit, metric.canonicalUnit, metric);
      if (conv.ok) canonical = conv.value;
    }
    if (
      (range.low !== undefined && canonical < range.low) ||
      (range.high !== undefined && canonical > range.high)
    ) {
      warning = true;
    }
  }

  return parsed.operator !== undefined
    ? { ok: true, value, operator: parsed.operator, warning }
    : { ok: true, value, warning };
}

// ---------------------------------------------------------------------------
// Building the pipeline payload
// ---------------------------------------------------------------------------

/** One value row from the form, still as raw strings. */
export interface EntryFieldInput {
  /** Resolved metric id, or an unresolved-name box for an unknown metric. */
  metric: MetricId | { unresolvedName: string };
  rawValue: string;
  /** Selected values for a 'multi' metric (rawValue is ignored then). */
  rawValues?: string[];
  /** The resolved metric's value kind, so text/enum values skip numeric parsing. */
  valueType?: 'number' | 'text' | 'enum' | 'multi';
  unit?: string;
  refLow?: string;
  refHigh?: string;
  note?: string;
}

/** The whole entry form: several value rows sharing a date and source. */
export interface EntryFormInput {
  fields: EntryFieldInput[];
  /** Raw date string (ISO `YYYY-MM-DD` from a date input, or a typed date). */
  date: string;
  /** Optional raw time string (`HH:MM`). */
  time?: string;
  sourceName?: string;
  note?: string;
}

/** Combine the form's date and optional time into a parsed timestamp. */
export function combineDateTime(date: string, time?: string): ParsedDateTime | undefined {
  const d = date.trim();
  if (d === '') return undefined;
  const t = time?.trim();
  return parseDateTime(t ? `${d} ${t}` : d);
}

function optionalNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = parseNumber(raw);
  return 'error' in parsed ? undefined : parsed.value;
}

/**
 * Build the {@link ManualEntryInput} for the import pipeline. Rows with an empty
 * or non-numeric value are skipped (the view validates first). The shared date
 * and source live on the input itself, so every produced field — including the
 * three of a blood-pressure group — carries the same `takenAt` and `sourceName`.
 */
export function buildManualInput(form: EntryFormInput): ManualEntryInput {
  const fields: ManualEntryField[] = [];

  for (const f of form.fields) {
    // A 'multi' metric carries several chosen values.
    if (f.valueType === 'multi') {
      const values = (f.rawValues ?? []).map((v) => v.trim()).filter((v) => v !== '');
      if (values.length > 0) fields.push({ metric: f.metric, textValues: values });
      continue;
    }

    if (f.rawValue.trim() === '') continue;

    // A qualitative (text/enum) metric stores the raw string; no parse or unit.
    if (f.valueType !== undefined && f.valueType !== 'number') {
      fields.push({ metric: f.metric, textValue: f.rawValue.trim() });
      continue;
    }

    const parsed = parseNumber(f.rawValue);
    if ('error' in parsed) continue;

    const field: ManualEntryField = { metric: f.metric, value: parsed.value };
    if (parsed.operator !== undefined) field.operator = parsed.operator;
    if (f.unit) field.unit = f.unit;

    const refLow = optionalNumber(f.refLow);
    if (refLow !== undefined) field.refLow = refLow;
    const refHigh = optionalNumber(f.refHigh);
    if (refHigh !== undefined) field.refHigh = refHigh;

    const note = f.note?.trim();
    if (note) field.note = note;

    fields.push(field);
  }

  const input: ManualEntryInput = { fields };

  const when = combineDateTime(form.date, form.time);
  if (when) {
    input.takenAt = when.iso;
    input.timePrecision = when.precision;
  }

  const source = form.sourceName?.trim();
  if (source) input.sourceName = source;

  const note = form.note?.trim();
  if (note) input.note = note;

  return input;
}
