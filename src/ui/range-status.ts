/**
 * The single mapping of a value's position against its reference range to its
 * i18n label key. Every view that WORDS that position — the overview list status
 * pill, the metric-detail range pill, the timeline status dot, and the on-screen
 * plus exported report — resolves through here, so the copy never drifts into
 * per-view variants. `unknown` maps to `range.none` ("no range"); callers that
 * want to render nothing for an absent range check the state before calling.
 */

import type { StringKey } from '../i18n/index';

/** Position of a value against its own stated reference range. */
export type RangePos = 'below' | 'in-range' | 'above' | 'unknown';

/** i18n label key for a range position — the one source of truth for the copy. */
export function rangeStatusKey(pos: RangePos): StringKey {
  switch (pos) {
    case 'above':
      return 'range.above';
    case 'below':
      return 'range.below';
    case 'in-range':
      return 'range.within';
    default:
      return 'range.none';
  }
}
