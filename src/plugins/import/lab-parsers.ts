/**
 * Lab-document parser framework (phase 3).
 *
 * A lab result sheet's layout varies by provider. Each provider can have its
 * own `LabParser` that recognizes its sheets (by header text) and reads them;
 * a generic heuristic parser handles everything else. `parseLabDocument` picks
 * the first specific parser that claims the document, else the generic one.
 *
 * Adding support for a new lab is a new parser + registry entry — the PDF
 * plugin and the rest of the app never change.
 */

import type { Catalog } from '../../core/contracts';
import type { ProposedMeasurement } from '../../core/types';
import { parseLabLines } from './lab-text';
import { synlabParser } from './lab/cz/laboratory/synlab';
import { smartmedixDailyPatientRecordParser } from './lab/cz/practitioner-software/smartmedix-daily-patient-record';
import { LOCAL_LAB_PARSERS } from './lab/local';

export interface LabParser {
  /** Stable id, also used as a default source name hint. */
  id: string;
  /** Human-facing source label for measurements this parser produces. */
  sourceName?: string;
  /** True when this parser recognizes the document (e.g. by header text). */
  detect(lines: string[]): boolean;
  parse(lines: string[], catalog: Catalog): ProposedMeasurement[];
}

export interface LabParseResult {
  /** Which parser handled the document ('generic' when no specific match). */
  parserId: string;
  sourceName?: string;
  proposals: ProposedMeasurement[];
}

/** The always-applicable fallback; must be tried LAST. */
export const genericLabParser: LabParser = {
  id: 'generic',
  detect: () => true,
  parse: (lines, catalog) => parseLabLines(lines, catalog),
};

/**
 * Specific parsers, tried in order before the generic fallback. Source-specific
 * parsers live under `./lab/<country>/<type>/` (e.g. `cz/laboratory/synlab`,
 * `cz/practitioner-software/smartmedix-daily-patient-record`). `LOCAL_LAB_PARSERS`
 * is the extension point for private, uncommitted parsers.
 */
export const LAB_PARSERS: readonly LabParser[] = Object.freeze([
  synlabParser,
  smartmedixDailyPatientRecordParser,
  ...LOCAL_LAB_PARSERS,
]);

/**
 * Pick the first specific parser that claims the document, else generic.
 *
 * `extraParsers` are user-supplied declarative parsers (built from a profile's
 * import mappings via `declarativeLabParser`). They are tried AFTER the built-in
 * specific parsers but BEFORE the generic fallback, so a user mapping can claim
 * a format the generic heuristic would otherwise handle. With no extra parsers
 * behaviour is identical to before.
 */
export function parseLabDocument(
  lines: string[],
  catalog: Catalog,
  extraParsers: readonly LabParser[] = [],
): LabParseResult {
  const chain = [...LAB_PARSERS, ...extraParsers];
  const parser = chain.find((p) => p.detect(lines)) ?? genericLabParser;
  return {
    parserId: parser.id,
    sourceName: parser.sourceName,
    proposals: parser.parse(lines, catalog),
  };
}
