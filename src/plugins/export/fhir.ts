/**
 * FHIR export plugin (phase 3, interop).
 *
 * Serializes the selected measurements as a FHIR R4 `Bundle`
 * (`type: "collection"`) whose entries are `Observation` resources — the mirror
 * image of what `plugins/import/fhir.ts` recognizes, so exporting then importing
 * round-trips the numeric records.
 *
 * Per Observation:
 * - `resourceType: "Observation"`, `status: "final"`.
 * - `code`: `text` = the metric's display name; a LOINC `coding`
 *   (`system: http://loinc.org`, `code`, `display`) is added when the metric
 *   carries an `externalCodes.loinc` — that coding is what makes the import
 *   resolve the metric by code rather than by name.
 * - Numeric result → `valueQuantity { value, unit, code }` (UCUM code = our unit
 *   code, which the import normalizes back); a censored result keeps its
 *   `comparator` (`<`, `>`, …). Qualitative result → `valueString`.
 * - `effectiveDateTime` = `takenAt` (a wall-clock ISO string; the import strips
 *   any timezone designator, so none is added here).
 * - `referenceRange` = `[{ low: { value }, high: { value } }]` when either bound
 *   is present (one-sided allowed).
 * - `category`: one `CodeableConcept` whose `coding` list carries the metric's
 *   tags under a Vitametr tag system URI (`code` + `display` = the raw tag id).
 *   Added only when tags are enabled (`settings.useTags !== false`) AND the
 *   metric has tags. The FHIR import ignores `category`, so it is purely
 *   additive and does not affect the round-trip.
 *
 * Honors `ExportSelection.metricIds` + `range` via the shared `selectMeasurements`
 * filter. No clock is read: the bundle carries no generated timestamp.
 */

import type { ExportContext, ExportPlugin, ExportSelection } from '../../core/contracts.js';
import type { Measurement, Metric } from '../../core/types.js';
import { en } from '../../i18n/en.js';
import { cs } from '../../i18n/cs.js';
import { selectMeasurements } from './json-backup.js';

const LOINC_SYSTEM = 'http://loinc.org';
/** Vitametr's own coding system for metric tags (not a standard terminology). */
const TAG_SYSTEM = 'https://vitametr.app/fhir/tag';

/** Human-readable metric name for the given locale (mirrors the CSV export). */
function metricName(metric: Metric | undefined, locale: 'cs' | 'en'): string {
  if (!metric) return '';
  if (metric.customName) return metric.customName;
  if (metric.nameKey) {
    const table = locale === 'cs' ? cs : en;
    return table[metric.nameKey as keyof typeof en] ?? metric.nameKey;
  }
  return metric.key ?? metric.id;
}

interface FhirCoding {
  system: string;
  code: string;
  display?: string;
}

interface FhirCodeableConcept {
  coding: FhirCoding[];
}

interface FhirObservation {
  resourceType: 'Observation';
  status: 'final';
  category?: FhirCodeableConcept[];
  code: { text: string; coding?: FhirCoding[] };
  effectiveDateTime?: string;
  valueQuantity?: { value: number; unit?: string; code?: string; comparator?: string };
  valueString?: string;
  referenceRange?: Array<{ low?: { value: number }; high?: { value: number } }>;
}

/** Build a single Observation resource from a measurement. */
function observationOf(m: Measurement, ctx: ExportContext): FhirObservation {
  const metric = ctx.catalog.byId(m.metricId);
  const name = metricName(metric, ctx.locale);

  const code: FhirObservation['code'] = { text: name };
  const loinc = metric?.externalCodes?.loinc;
  if (loinc) {
    const coding: FhirCoding = { system: LOINC_SYSTEM, code: loinc };
    if (name) coding.display = name;
    code.coding = [coding];
  }

  const obs: FhirObservation = {
    resourceType: 'Observation',
    status: 'final',
    code,
  };

  // Tags → a single category CodeableConcept, one coding per tag. Added only when
  // tags are enabled and the metric carries any (the import ignores category).
  const withTags = ctx.data.settings?.useTags !== false;
  const tags = metric?.tags ?? [];
  if (withTags && tags.length > 0) {
    obs.category = [
      {
        coding: tags.map((tag) => ({ system: TAG_SYSTEM, code: tag, display: tag })),
      },
    ];
  }

  if (m.takenAt) obs.effectiveDateTime = m.takenAt;

  if (m.value !== undefined) {
    const vq: FhirObservation['valueQuantity'] = { value: m.value };
    if (m.unit) {
      vq.unit = m.unit;
      vq.code = m.unit;
    }
    if (m.operator) vq.comparator = m.operator;
    obs.valueQuantity = vq;
  } else {
    // Qualitative result (text / enum / multi): a plain string value. The import
    // skips these (numeric only), but a valid FHIR export still represents them.
    const text = m.textValue ?? (m.textValues ? m.textValues.join(', ') : '');
    if (text) obs.valueString = text;
  }

  if (m.refLow !== undefined || m.refHigh !== undefined) {
    const rr: { low?: { value: number }; high?: { value: number } } = {};
    if (m.refLow !== undefined) rr.low = { value: m.refLow };
    if (m.refHigh !== undefined) rr.high = { value: m.refHigh };
    obs.referenceRange = [rr];
  }

  return obs;
}

export const fhirExportPlugin: ExportPlugin = {
  id: 'fhir',
  nameKey: 'export.fhir',
  fileExtension: 'json',

  async export(selection: ExportSelection, ctx: ExportContext): Promise<Blob> {
    const rows = selectMeasurements(ctx.data.measurements, selection);
    const bundle = {
      resourceType: 'Bundle' as const,
      type: 'collection' as const,
      entry: rows.map((m) => ({ resource: observationOf(m, ctx) })),
    };
    return new Blob([JSON.stringify(bundle, null, 2)], {
      type: 'application/fhir+json',
    });
  },
};
