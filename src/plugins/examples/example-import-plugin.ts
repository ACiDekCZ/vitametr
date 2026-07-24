// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Milan Víšek

/**
 * EXAMPLE — a minimal, complete `ImportPlugin` (teaching template).
 *
 * This file is MIT-licensed (the rest of the repository is MPL-2.0) and is NOT
 * registered in the running app — it exists only as a copy-and-adapt starting
 * point for plugin authors. See `PLUGINS.md` for the full developer contract.
 *
 * What it demonstrates
 * --------------------
 * A parser for a tiny FICTIONAL text format, one measurement per line:
 *
 *     metric = value unit @ YYYY-MM-DD
 *
 * for example:
 *
 *     Glukóza = 5,4 mmol/l @ 2026-03-15
 *     Kreatinin = 78 umol/l @ 2026-03-15
 *     Wobblonium = 12 zorp @ 2026-03-15   <- unknown metric AND unknown unit
 *
 * The point of the example is the *golden rule* (PLUGINS.md, spec §16):
 * **correctness over guessing.** An importer never invents a metric, a unit or
 * a value. When a name does not resolve it is emitted as `{ unresolvedName }`
 * for the user to map once; when a unit is not recognised it is dropped (never
 * swapped for a plausible-looking one). All of that comes for free from the
 * shared normalize helpers — the plugin just wires them up.
 *
 * How the pieces fit
 * ------------------
 * - `resolveMetric(name, catalog)` -> a resolved `MetricId` OR an
 *   `{ unresolvedName }`. Never a guess.
 * - `parseNumber(raw)` -> a number (handling a decimal comma and a leading
 *   `<`/`>` censoring operator) OR an error; never `NaN`.
 * - `normalizeUnit(raw)` -> a canonical UCUM code OR `undefined` for an
 *   unrecognised spelling.
 * - `parseDateTime(raw)` -> an ISO date/datetime + its precision, or undefined.
 *
 * The plugin returns `ProposedMeasurement[]`; the shared review pipeline
 * (normalize -> review -> commit) does the rest — this file never touches
 * storage, the DOM or a clock.
 */

import type { ImportContext, ImportInput, ImportPlugin } from '../../core/contracts.js';
import type { ProposedMeasurement } from '../../core/types.js';
import {
  normalizeUnit,
  parseDateTime,
  parseNumber,
  resolveMetric,
} from '../../core/normalize.js';

/**
 * One line of the fictional format:
 *
 *     <name> = <value> <unit> @ <date>
 *
 * Named groups keep the mapping to fields obvious. `unit` and the whole
 * `@ <date>` tail are optional, so a bare `Weight = 81,2 kg` line still parses.
 */
const LINE_RE =
  /^\s*(?<name>[^=]+?)\s*=\s*(?<value>[^@]+?)\s*(?:@\s*(?<date>\S+))?\s*$/;

/** The `<value>` field split into an optional operator+number and a unit word. */
const VALUE_RE = /^(?<number>(?:[<>]=?\s*)?[\d.,]+)(?:\s+(?<unit>\S+))?$/;

/**
 * Turn one text line into a proposal, or `undefined` when the line is not a
 * record (blank lines, comments, anything that does not match the grammar).
 * Kept pure and exported so tests — and adapters — can exercise it directly.
 */
export function parseExampleLine(
  rawText: string,
  ctx: ImportContext,
): ProposedMeasurement | undefined {
  const line = rawText.trim();
  // Skip blanks and `#`-prefixed comment lines.
  if (line === '' || line.startsWith('#')) return undefined;

  const m = LINE_RE.exec(line);
  if (!m?.groups) return undefined;

  const name = m.groups.name.trim();
  const valuePart = m.groups.value.trim();
  const datePart = m.groups.date;
  if (name === '' || valuePart === '') return undefined;

  const vm = VALUE_RE.exec(valuePart);
  if (!vm?.groups) return undefined;

  // Value: parseNumber handles a decimal comma and a leading `<`/`>` operator,
  // and never returns NaN. A non-numeric value means this is not a record.
  const parsedValue = parseNumber(vm.groups.number);
  if ('error' in parsedValue) return undefined;

  // Metric: resolve against the catalog; on a miss keep the raw name for the
  // user to map — never fabricate an id.
  const resolved = resolveMetric(name, ctx.catalog);
  const metric =
    'metricId' in resolved ? resolved.metricId : { unresolvedName: resolved.unresolvedName };
  const metricResolved = 'metricId' in resolved;

  // Unit: normalise the spelling; an unrecognised unit is DROPPED (undefined),
  // not guessed. That lowers our confidence but never corrupts the value.
  const unit = vm.groups.unit ? normalizeUnit(vm.groups.unit) : undefined;
  const unitRecognised = vm.groups.unit ? unit !== undefined : true;

  // Date: parsed from explicit input only (no clock).
  const date = datePart ? parseDateTime(datePart) : undefined;

  // Confidence mirrors the built-in parsers: everything resolved -> high; a
  // dropped unit or a missing date -> medium; an unresolved metric -> low.
  let confidence: ProposedMeasurement['confidence'];
  if (!metricResolved) confidence = 'low';
  else if (!unitRecognised || !date) confidence = 'medium';
  else confidence = 'high';

  const proposal: ProposedMeasurement = {
    metric,
    value: parsedValue.value,
    confidence,
    rawText,
  };
  if (unit !== undefined) proposal.unit = unit;
  if (parsedValue.operator !== undefined) proposal.operator = parsedValue.operator;
  if (date) {
    proposal.takenAt = date.iso;
    proposal.timePrecision = date.precision;
  }
  return proposal;
}

/** Read an `ImportInput` (a picked file or in-memory data) to a text string. */
async function readText(input: ImportInput): Promise<string> {
  if (input.kind === 'file') return input.file.text();
  // `data` inputs are whatever a caller handed us; accept a string or bytes.
  if (typeof input.data === 'string') return input.data;
  if (input.data instanceof Uint8Array) return new TextDecoder().decode(input.data);
  return '';
}

/**
 * The plugin object itself. To make it live you would (see PLUGINS.md):
 *   1. add it to `IMPORT_PLUGINS` in `src/plugins/registry.ts`, and
 *   2. teach the sniffer in `src/plugins/detect.ts` to recognise the format so
 *      the single "Import a file" entry can route to it.
 * This example deliberately does NEITHER — it changes no app behaviour.
 */
export const exampleImportPlugin: ImportPlugin = {
  id: 'example-text',
  // A real plugin points this at an i18n key that exists in `src/i18n/`.
  nameKey: 'example.import.name',
  kind: 'file',
  accepts: ['.example', 'text/plain'],

  async parse(input: ImportInput, ctx: ImportContext): Promise<ProposedMeasurement[]> {
    const text = await readText(input);
    const proposals: ProposedMeasurement[] = [];
    for (const line of text.split(/\r?\n/)) {
      const proposal = parseExampleLine(line, ctx);
      if (proposal) proposals.push(proposal);
    }
    return proposals;
  },
};
