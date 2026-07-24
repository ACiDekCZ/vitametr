/**
 * FHIR import plugin (phase 2).
 *
 * Turns FHIR R4 `Observation` resources into reviewable `ProposedMeasurement`s.
 * Accepts any of the shapes a lab or health record might hand us:
 *  - a `Bundle` (`{ resourceType: 'Bundle', entry: [{ resource }] }`),
 *  - a single `Observation`,
 *  - a `DiagnosticReport` whose `contained` array holds Observations,
 *  - a bare array of Observations.
 *
 * Design rules (spec §16): never guess. Metric resolution prefers the LOINC
 * coding (`catalog.byLoinc`) and falls back to the `code.text` / coding display
 * via `catalog.resolveAlias`; an unresolved code stays `{ unresolvedName }`.
 * Unit and date parsing are delegated to `core/normalize.ts`; the only local
 * preprocessing is stripping a trailing timezone designator off the effective
 * timestamp (the same wall-clock-preserving trick `core/csv.ts` uses).
 *
 * Only Observations with a numeric `valueQuantity.value` become proposals.
 * Non-numeric results (`valueString`, `valueCodeableConcept`, a missing
 * quantity) are skipped — the MVP models numeric quantities only. Malformed or
 * missing fields degrade gracefully and never throw.
 */

import type { ImportContext, ImportInput, ImportPlugin, Catalog } from '../../core/contracts.js';
import type { MetricId, Operator, ProposedMeasurement, TimePrecision } from '../../core/types.js';
import { normalizeUnit, parseDateTime } from '../../core/normalize.js';

const LOINC_SYSTEM = 'http://loinc.org';

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null;
}

/**
 * Walk any accepted shape and collect the `Observation` resources it holds.
 * Handles Bundles (via `entry[].resource`, which may itself be a
 * DiagnosticReport), DiagnosticReports (via `contained`), arrays, and a single
 * Observation. Unknown resources are ignored rather than throwing.
 */
function collectObservations(node: unknown, out: Json[]): void {
  if (!isObject(node)) return;

  if (Array.isArray(node)) {
    for (const item of node) collectObservations(item, out);
    return;
  }

  switch (node.resourceType) {
    case 'Bundle': {
      const { entry } = node;
      if (Array.isArray(entry)) {
        for (const e of entry) {
          if (isObject(e) && !Array.isArray(e)) collectObservations(e.resource, out);
        }
      }
      return;
    }
    case 'DiagnosticReport': {
      const { contained } = node;
      if (Array.isArray(contained)) {
        for (const c of contained) collectObservations(c, out);
      }
      return;
    }
    case 'Observation':
      out.push(node);
      return;
    default:
      return;
  }
}

/** A FHIR comparator token mapped to our Operator, or undefined. */
function toOperator(comparator: unknown): Operator | undefined {
  return comparator === '<' || comparator === '>' || comparator === '<=' || comparator === '>='
    ? comparator
    : undefined;
}

/**
 * Strip a trailing timezone marker (`Z` or `±HH:MM` / `±HHMM`) so an otherwise
 * ISO timestamp reaches `parseDateTime`, which reads wall-clock strings only.
 * Same approach as `core/csv.ts`: the wall-clock date/time is preserved, the
 * zone designator dropped.
 */
function stripTimezone(raw: string): string {
  return raw.trim().replace(/\s*(?:Z|[+-]\d{2}:?\d{2})$/, '');
}

/** The effective instant of an Observation: `effectiveDateTime` or `effectivePeriod.start`. */
function effectiveDate(obs: Json): string | undefined {
  const dt = obs.effectiveDateTime;
  if (typeof dt === 'string' && dt.trim() !== '') return dt;
  const period = obs.effectivePeriod;
  if (isObject(period) && typeof period.start === 'string' && period.start.trim() !== '') {
    return period.start;
  }
  return undefined;
}

/** The LOINC coding of a `code`, if any, with its code and display text. */
function loincCoding(code: unknown): { code?: string; display?: string } {
  if (!isObject(code)) return {};
  const { coding } = code;
  if (!Array.isArray(coding)) return {};
  for (const c of coding) {
    if (isObject(c) && !Array.isArray(c) && c.system === LOINC_SYSTEM) {
      return {
        code: typeof c.code === 'string' ? c.code : undefined,
        display: typeof c.display === 'string' ? c.display : undefined,
      };
    }
  }
  return {};
}

/** Resolve the metric of an Observation: LOINC first, then text/display alias. */
function resolveMetricOf(
  obs: Json,
  catalog: Catalog,
): { metric: MetricId | { unresolvedName: string }; resolved: boolean } {
  const code = obs.code;
  const { code: loinc, display } = loincCoding(code);
  const text = isObject(code) && typeof code.text === 'string' ? code.text : undefined;

  // LOINC coding is the authoritative, code-system-based match.
  if (loinc) {
    const hit = catalog.byLoinc(loinc);
    if (hit) return { metric: hit.id, resolved: true };
  }

  // Fall back to a name match on the free text, then the coding display.
  for (const name of [text, display]) {
    if (name && name.trim() !== '') {
      const hit = catalog.resolveAlias(name);
      if (hit) return { metric: hit.id, resolved: true };
    }
  }

  // Never guess: surface the best available human label for the review UI.
  return { metric: { unresolvedName: text ?? display ?? '' }, resolved: false };
}

/** Numeric bound from a `referenceRange` endpoint (`{ value }`), if present. */
function boundValue(endpoint: unknown): number | undefined {
  if (isObject(endpoint) && !Array.isArray(endpoint)) {
    const v = endpoint.value;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** Build a proposal for one Observation, or undefined when it carries no numeric value. */
function observationToProposal(obs: Json, catalog: Catalog): ProposedMeasurement | undefined {
  const vq = obs.valueQuantity;
  if (!isObject(vq) || Array.isArray(vq)) return undefined;

  // Numeric quantities only; skip valueString / valueCodeableConcept / etc.
  const value = vq.value;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;

  const operator = toOperator(vq.comparator);

  // Unit: UCUM `code` preferred, else the human `unit`; normalized to our code.
  const rawUnit =
    typeof vq.code === 'string' && vq.code.trim() !== ''
      ? vq.code
      : typeof vq.unit === 'string' && vq.unit.trim() !== ''
        ? vq.unit
        : undefined;
  const unitPresent = rawUnit !== undefined;
  const unit = rawUnit !== undefined ? normalizeUnit(rawUnit) : undefined;

  // Metric.
  const { metric, resolved: metricResolved } = resolveMetricOf(obs, catalog);

  // Date: strip a timezone suffix, then delegate to the shared parser.
  let takenAt: string | undefined;
  let timePrecision: TimePrecision | undefined;
  const rawDate = effectiveDate(obs);
  if (rawDate !== undefined) {
    const parsed = parseDateTime(stripTimezone(rawDate));
    if (parsed) {
      takenAt = parsed.iso;
      timePrecision = parsed.precision;
    }
  }

  // Reference range (first entry; one-sided allowed).
  let refLow: number | undefined;
  let refHigh: number | undefined;
  const ranges = obs.referenceRange;
  if (Array.isArray(ranges) && ranges.length > 0) {
    const first = ranges[0];
    if (isObject(first) && !Array.isArray(first)) {
      refLow = boundValue(first.low);
      refHigh = boundValue(first.high);
    }
  }

  // Confidence.
  const dateOk = takenAt !== undefined;
  const unitOk = !unitPresent || unit !== undefined;
  let confidence: ProposedMeasurement['confidence'];
  if (!metricResolved) confidence = 'low';
  else if (dateOk && unitOk) confidence = 'high';
  else confidence = 'medium';

  // rawText: a compact snapshot of the source code + value so the original
  // stays traceable through review and storage.
  const rawText = JSON.stringify({
    code: obs.code,
    valueQuantity: obs.valueQuantity,
    effectiveDateTime: obs.effectiveDateTime,
  });

  const proposal: ProposedMeasurement = { metric, value, confidence, rawText };
  if (operator !== undefined) proposal.operator = operator;
  if (unit !== undefined) proposal.unit = unit;
  if (takenAt !== undefined) proposal.takenAt = takenAt;
  if (timePrecision !== undefined) proposal.timePrecision = timePrecision;
  if (refLow !== undefined) proposal.refLow = refLow;
  if (refHigh !== undefined) proposal.refHigh = refHigh;

  return proposal;
}

/**
 * Pure: turn FHIR data (Bundle / Observation / DiagnosticReport / array) into
 * proposals. Exported for tests. Observations without a numeric
 * `valueQuantity.value` are skipped; everything else degrades gracefully.
 */
export function observationsToProposals(root: unknown, catalog: Catalog): ProposedMeasurement[] {
  const observations: Json[] = [];
  collectObservations(root, observations);

  const proposals: ProposedMeasurement[] = [];
  for (const obs of observations) {
    const proposal = observationToProposal(obs, catalog);
    if (proposal) proposals.push(proposal);
  }
  return proposals;
}

export const fhirImportPlugin: ImportPlugin = {
  id: 'fhir',
  nameKey: 'import.fhir',
  kind: 'file',
  accepts: ['.json', 'application/fhir+json', 'application/json'],

  async parse(input: ImportInput, ctx: ImportContext): Promise<ProposedMeasurement[]> {
    let root: unknown;
    if (input.kind === 'file') {
      // File and Blob both expose .text().
      root = JSON.parse(await input.file.text());
    } else {
      root = input.data;
    }
    return observationsToProposals(root, ctx.catalog);
  },
};
