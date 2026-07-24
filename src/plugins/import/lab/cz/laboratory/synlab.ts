/**
 * SYNLAB lab-sheet parser (phase 3).
 *
 * SYNLAB result sheets use the standard analyte-row layout, so the value this
 * parser adds is detection (by the provider name in the header) and source
 * labeling. The row-level work — including the reference-range and censored
 * value styles SYNLAB favors (`< X`, `do X`, `nad X`) — is handled by the
 * shared, improved {@link parseLabLines}.
 */

import type { Catalog } from '../../../../../core/contracts';
import type { ProposedMeasurement } from '../../../../../core/types';
import type { LabParser } from '../../../lab-parsers';
import { parseLabLines } from '../../../lab-text';

/** How many leading lines to scan for the provider name. */
const HEADER_SCAN = 5;

export const synlabParser: LabParser = {
  id: 'synlab',
  sourceName: 'SYNLAB',
  detect(lines: string[]): boolean {
    return lines.slice(0, HEADER_SCAN).some((line) => line.toLowerCase().includes('synlab'));
  },
  parse(lines: string[], catalog: Catalog): ProposedMeasurement[] {
    return parseLabLines(lines, catalog);
  },
};
