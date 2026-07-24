/**
 * Composition root helpers (K8a) — the boundary where real ids and wall-clock
 * time enter the app. The pure core stays clock- and randomness-free; these
 * two functions are the only sanctioned sources, injected downward as deps.
 */

import type { MeasurementId } from '../core/types';

/** Current instant as an ISO 8601 string. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** A collision-resistant measurement id. */
export function newMeasurementId(): MeasurementId {
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : fallbackId();
  return `m_${id}` as MeasurementId;
}

/** Only used where crypto.randomUUID is unavailable (older embedded engines). */
function fallbackId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
