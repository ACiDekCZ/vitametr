/**
 * Manual entry import plugin (step K7).
 *
 * The "silent passthrough" path of the shared import pipeline: the entry form
 * (K8c) hands over already-typed field values, this plugin turns them into
 * high-confidence proposals, and the pipeline commits them without stopping at
 * the review screen. The exact same `prepare`/`commit` code runs for manual
 * entry as for CSV/PDF imports later — the review infrastructure is written
 * once (design doc §5.1).
 *
 * Grouping (e.g. blood pressure = systolic + diastolic + pulse) is modeled here
 * simply as multiple `fields` sharing one `takenAt`/`sourceName`: each field
 * becomes its own proposal, so one submitted form produces one measurement per
 * field, all sharing the same time and source. Which metrics belong to a group
 * is the UI's concern (K8c, via `Metric.entryGroup`); this plugin just faithfully
 * emits whatever fields it is given.
 */

import type { ImportContext, ImportInput, ImportPlugin } from '../../core/contracts.js';
import type { Operator, ProposedMeasurement, TimePrecision } from '../../core/types.js';

/** One value the user typed into the entry form. */
export interface ManualEntryField {
  /**
   * The metric the user picked. A resolved `MetricId` (string) for a known
   * metric, or a `{ unresolvedName }` box when the user typed a name that is
   * not in the catalog yet (the pipeline then routes it to review).
   */
  metric: ProposedMeasurement['metric'];
  /** Numeric value; omit for a qualitative text result. */
  value?: number;
  /** Qualitative value (e.g. "Negativní"); omit for a numeric result. */
  textValue?: string;
  /** Several chosen values, for a 'multi' metric. */
  textValues?: string[];
  operator?: Operator;
  unit?: string;
  refLow?: number;
  refHigh?: number;
  refText?: string;
  note?: string;
  /** Optional original text, kept verbatim as measurement origin. */
  rawText?: string;
}

/** Structured payload carried by an `ImportInput` of kind 'data'. */
export interface ManualEntryInput {
  fields: ManualEntryField[];
  /** ISO timestamp shared by all fields of this submission. */
  takenAt?: string;
  timePrecision?: TimePrecision;
  /** Source name shared by all fields (e.g. 'Home', a lab, a device). */
  sourceName?: string;
  /** Note shared by all fields unless a field overrides it. */
  note?: string;
}

function isManualEntryInput(data: unknown): data is ManualEntryInput {
  return (
    typeof data === 'object' &&
    data !== null &&
    Array.isArray((data as { fields?: unknown }).fields)
  );
}

export const manualImportPlugin: ImportPlugin = {
  id: 'manual',
  nameKey: 'import.manual',
  kind: 'interactive',

  async parse(input: ImportInput, _ctx: ImportContext): Promise<ProposedMeasurement[]> {
    if (input.kind !== 'data') {
      throw new Error('manual import expects structured form data (kind "data")');
    }
    if (!isManualEntryInput(input.data)) {
      throw new Error('manual import: malformed entry form data');
    }

    const form = input.data;

    return form.fields.map((field): ProposedMeasurement => ({
      metric: field.metric,
      ...(field.value !== undefined ? { value: field.value } : {}),
      ...(field.textValue !== undefined ? { textValue: field.textValue } : {}),
      ...(field.textValues !== undefined ? { textValues: field.textValues } : {}),
      ...(field.operator !== undefined ? { operator: field.operator } : {}),
      ...(field.unit !== undefined ? { unit: field.unit } : {}),
      ...(form.takenAt !== undefined ? { takenAt: form.takenAt } : {}),
      ...(form.timePrecision !== undefined ? { timePrecision: form.timePrecision } : {}),
      ...(field.refLow !== undefined ? { refLow: field.refLow } : {}),
      ...(field.refHigh !== undefined ? { refHigh: field.refHigh } : {}),
      ...(field.refText !== undefined ? { refText: field.refText } : {}),
      ...(form.sourceName !== undefined ? { sourceName: form.sourceName } : {}),
      ...(field.note ?? form.note ? { note: field.note ?? form.note } : {}),
      ...(field.rawText !== undefined ? { rawText: field.rawText } : {}),
      // Manual entry is authoritative: the user typed it deliberately.
      confidence: 'high',
    }));
  },
};
