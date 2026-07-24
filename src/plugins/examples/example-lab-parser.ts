// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Milan Víšek

/**
 * EXAMPLE — a minimal `LabParser` (teaching template).
 *
 * This file is MIT-licensed (the rest of the repository is MPL-2.0) and is NOT
 * registered in the running app (it is absent from `LAB_PARSERS` in
 * `src/plugins/import/lab-parsers.ts`) — it exists only as a copy-and-adapt
 * starting point. See `PLUGINS.md` for the full developer contract.
 *
 * What it demonstrates
 * --------------------
 * A per-lab parser for a trivial, FICTIONAL keyed line format. When PDF (or
 * plain text) is extracted to lines, `parseLabDocument` tries each specific
 * `LabParser` in turn: the first whose `detect(lines)` returns true handles the
 * document, otherwise the generic heuristic reader does. A specific parser is
 * only needed when the *layout* defeats the generic reader — naming differences
 * are data (aliases / packs), not code.
 *
 * The fictional sheet looks like:
 *
 *     EXAMPLE-LAB REPORT
 *     Date: 2026-03-15
 *     Glukóza | 5,4 | mmol/l | 3,9-5,6
 *     Kreatinin | 78 | umol/l | 64-104
 *
 * i.e. pipe-separated `name | value | unit | low-high` rows under a header the
 * parser recognises by its marker text. This mirrors the conventions in
 * `src/plugins/import/lab-text.ts`: resolve names against the catalog (never
 * guess), parse numbers via `parseNumber`, normalise units via `normalizeUnit`
 * (dropping unrecognised ones), and share the one document date across every
 * proposal.
 */

import type { Catalog } from '../../core/contracts.js';
import type { ProposedMeasurement } from '../../core/types.js';
import {
  normalizeUnit,
  parseDateTime,
  parseNumber,
  resolveMetric,
} from '../../core/normalize.js';
import type { LabParser } from '../import/lab-parsers.js';

/** The marker that identifies this lab's sheets — the basis of `detect`. */
const MARKER = 'EXAMPLE-LAB';

/** `Date: YYYY-MM-DD` header line; the first hit is the document date. */
const DATE_RE = /Date:\s*(\S+)/i;

/** A `low-high` reference range (bare numbers, hyphen or en dash). */
const RANGE_RE = /^\s*([\d.,]+)\s*[-–]\s*([\d.,]+)\s*$/;

/** Parse a bare numeric bound; undefined when it is not a plain number. */
function bound(raw: string): number | undefined {
  const parsed = parseNumber(raw);
  return 'value' in parsed ? parsed.value : undefined;
}

/** Scan for the `Date:` header; the first parseable date wins. */
function findDate(lines: string[]): { iso: string; precision: 'date' | 'datetime' } | undefined {
  for (const line of lines) {
    const m = DATE_RE.exec(line);
    if (m) {
      const parsed = parseDateTime(m[1]);
      if (parsed) return parsed;
    }
  }
  return undefined;
}

export const exampleLabParser: LabParser = {
  id: 'example-lab',
  sourceName: 'Example Lab',

  /**
   * Claim the document when its marker text is present. `detect` should be a
   * cheap, specific test — never `() => true` (that is the generic fallback's
   * job, and it must always be tried last).
   */
  detect(lines: string[]): boolean {
    return lines.some((l) => l.toUpperCase().includes(MARKER));
  },

  parse(lines: string[], catalog: Catalog): ProposedMeasurement[] {
    const date = findDate(lines);
    const proposals: ProposedMeasurement[] = [];

    for (const rawText of lines) {
      // Only pipe-separated rows are analyte rows; headers/meta fall away.
      const parts = rawText.split('|').map((p) => p.trim());
      if (parts.length < 3) continue;

      const [name, valueRaw, unitRaw, rangeRaw] = parts;
      if (name === '') continue;

      // Value: parseNumber handles a decimal comma and a leading `<`/`>`
      // operator, and never returns NaN. Non-numeric -> not an analyte row.
      const parsedValue = parseNumber(valueRaw);
      if ('error' in parsedValue) continue;

      // Metric: resolve, or keep the raw name for one-time user mapping.
      const resolved = resolveMetric(name, catalog);
      const metric =
        'metricId' in resolved ? resolved.metricId : { unresolvedName: resolved.unresolvedName };

      // Unit: normalise; an unrecognised spelling is dropped, never guessed.
      const unit = unitRaw ? normalizeUnit(unitRaw) : undefined;

      const proposal: ProposedMeasurement = {
        metric,
        value: parsedValue.value,
        confidence: 'metricId' in resolved ? (date ? 'high' : 'medium') : 'low',
        rawText,
      };
      if (unit !== undefined) proposal.unit = unit;
      if (parsedValue.operator !== undefined) proposal.operator = parsedValue.operator;

      // Reference range: `low-high` from the source, as bare numbers.
      const range = rangeRaw ? RANGE_RE.exec(rangeRaw) : null;
      if (range) {
        const low = bound(range[1]);
        const high = bound(range[2]);
        if (low !== undefined) proposal.refLow = low;
        if (high !== undefined) proposal.refHigh = high;
        proposal.refText = rangeRaw;
      }

      if (date) {
        proposal.takenAt = date.iso;
        proposal.timePrecision = date.precision;
      }
      proposals.push(proposal);
    }

    return proposals;
  },
};
