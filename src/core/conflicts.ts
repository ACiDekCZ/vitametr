/**
 * Import conflict detection and resolution (feature 2 of the import trilogy).
 *
 * A CONFLICT is two measurements that share the same metric and the same instant
 * (`metricId` + `takenAt`) but carry a DIFFERENT value — a different numeric
 * `value`, `textValue`/`textValues`, or `unit`. Two real cases:
 *
 * 1. Re-importing a lab without wiping first: a new value lands at the same
 *    `takenAt` as an already-stored value. Left alone this piles up two points at
 *    one instant and fabricates a "decreased since last time" trend.
 * 2. A single source file that states the same reading two ways (e.g. a urine
 *    block with both "Leukocyty: negativní" and "Leukocyty: <3 počet/μL", both
 *    mapping to one metric at one time).
 *
 * A conflict is DISTINCT from an EXACT duplicate (same metric + instant + value +
 * unit): exact duplicates are dropped silently by `partitionDuplicates`
 * (`src/core/review.ts`) and are NOT surfaced here. This module only reports keys
 * where genuinely different values compete, and applies the user's per-conflict
 * choice into a concrete add/remove set.
 *
 * Everything here is pure: no DOM, no clock, no id generation, no mutation of the
 * inputs. The UI (`src/ui/views/review.ts`) computes groups, collects the user's
 * choices, and applies them inside its own mutation boundary.
 */

import type { Measurement, MeasurementId, MetricId, TimePrecision } from './types.js';

/**
 * How to resolve one conflict group.
 * - `keep-new`      — import the new value; a conflicting stored value is
 *                     replaced (removed). Within a batch, keep the first new
 *                     value and drop the other new one(s). This is the default:
 *                     re-import intent is usually "update", and it avoids the
 *                     false-trend duplicate.
 * - `keep-existing` — do not import the new value(s); keep the stored value. In a
 *                     within-batch conflict with nothing stored yet, keep the
 *                     first new value and drop the rest.
 * - `keep-both`     — import every new value AND keep the stored one(s): the user
 *                     explicitly accepts multiple values at the same instant.
 * - `keep-second`   — for an import×import group (nothing stored), keep the
 *                     SECOND distinct incoming value and drop the first. There is
 *                     no `existing` to remove. For a stored×import group it falls
 *                     back to the second incoming, if any, else the first — the UI
 *                     only offers it where a second incoming exists.
 * - `keep-latest`   — keep the LAST incoming occurrence in FILE ORDER
 *                     (`incoming[incoming.length - 1]`) and drop every other
 *                     incoming value plus any stored value. "Latest" here means
 *                     last-in-the-file, NOT the maximum value: the common reimport
 *                     case where the final revision in a file supersedes the
 *                     earlier ones.
 * - `keep-incoming-<i>` — keep one specific incoming occurrence by its index
 *                     `<i>` (the per-block "Keep this" for occurrences beyond the
 *                     second, where the coarse keep-new/keep-second slots do not
 *                     reach), dropping the other incoming values and any stored
 *                     value. Build it via {@link keepIncoming}.
 */
export type ConflictChoice =
  | 'keep-new'
  | 'keep-existing'
  | 'keep-both'
  | 'keep-second'
  | 'keep-latest'
  | `keep-incoming-${number}`;

/** The choice that keeps the incoming occurrence at index `i` (see ConflictChoice). */
export function keepIncoming(i: number): ConflictChoice {
  return `keep-incoming-${i}`;
}

/** Parse a `keep-incoming-<i>` choice back to its index, or undefined otherwise. */
function incomingIndex(choice: ConflictChoice): number | undefined {
  const match = /^keep-incoming-(\d+)$/.exec(choice);
  return match ? Number(match[1]) : undefined;
}

/** The safe default applied to any group the user does not touch. */
export const DEFAULT_CONFLICT_CHOICE: ConflictChoice = 'keep-new';

/**
 * The two shapes a conflict takes, derived purely from the group:
 * - `stored-vs-import` — a new import value clashes with an already-stored value
 *   (`existing.length > 0`).
 * - `import-vs-import` — two distinct new values from the same import batch clash,
 *   with nothing stored yet (`existing.length === 0`).
 *
 * The UI labels/badges/buttons switch on this: an import×import conflict must
 * never speak of a "stored"/"current" value, because there is none.
 */
export type ConflictKind = 'stored-vs-import' | 'import-vs-import';

/** Classify a conflict group by whether a stored value participates. */
export function conflictKind(group: ConflictGroup): ConflictKind {
  return group.existing.length > 0 ? 'stored-vs-import' : 'import-vs-import';
}

/**
 * One contested (metricId, takenAt) key. `incoming` holds the distinct new
 * values (deduplicated by value signature, first occurrence kept, order
 * preserved); `existing` holds the stored measurements at that key. A group is
 * only produced when at least two distinct values compete at the key.
 */
export interface ConflictGroup {
  /** Stable string identity of the key — the UI keys its choice map by this. */
  key: string;
  metricId: MetricId;
  takenAt: string;
  /** Precision of a representative candidate, for date/time formatting. */
  timePrecision: TimePrecision;
  /** Distinct new values proposed at this key (deduped, order preserved). */
  incoming: Measurement[];
  /** Stored measurements already at this key. */
  existing: Measurement[];
}

/** The concrete effect of applying resolutions: what to store, what to delete. */
export interface ResolvedConflicts {
  /** Incoming measurements to store. */
  add: Measurement[];
  /** Ids of stored measurements that were replaced and must be removed. */
  removeExistingIds: MeasurementId[];
}

/**
 * Value identity WITHIN a key — everything that distinguishes two readings that
 * share metric + instant. Kept consistent with `measurementKey` in
 * `review.ts` (value, qualitative text, unit) so that what the duplicate filter
 * treats as "the same reading" this module treats as the same value (never a
 * conflict), and vice versa. `operator` is intentionally excluded, matching the
 * duplicate filter.
 */
function valueSignature(m: Measurement): string {
  const text = m.textValue ?? (m.textValues ? m.textValues.join('') : '');
  return [m.value ?? '', text, m.unit].join('');
}

/** Stable identity of the (metricId, takenAt) bucket a measurement falls into. */
function conflictKey(metricId: MetricId, takenAt: string): string {
  return metricId + '' + takenAt;
}

/** The conflict-group key a measurement belongs to (metric + instant). */
export function conflictKeyForMeasurement(m: Measurement): string {
  return conflictKey(m.metricId, m.takenAt);
}

/**
 * Find every conflict between the `incoming` measurements and what is already
 * stored (`existing`), plus conflicts within the incoming batch itself.
 *
 * A key becomes a group only when two or more DISTINCT values meet there. Keys
 * where every value is identical (pure exact duplicates) are excluded — those
 * are the duplicate filter's job. Groups are returned in first-seen order of the
 * incoming measurements, so the UI order is stable and predictable.
 */
export function detectConflicts(
  existing: readonly Measurement[],
  incoming: readonly Measurement[],
): ConflictGroup[] {
  // Index stored measurements by key for O(1) lookup.
  const existingByKey = new Map<string, Measurement[]>();
  for (const m of existing) {
    const key = conflictKeyForMeasurement(m);
    const bucket = existingByKey.get(key);
    if (bucket) bucket.push(m);
    else existingByKey.set(key, [m]);
  }

  // Bucket the incoming measurements by key, deduplicating identical values
  // within the batch (first occurrence wins) and preserving key order.
  const order: string[] = [];
  const incomingByKey = new Map<string, Measurement[]>();
  const incomingSigsByKey = new Map<string, Set<string>>();
  for (const m of incoming) {
    const key = conflictKeyForMeasurement(m);
    let bucket = incomingByKey.get(key);
    let sigs = incomingSigsByKey.get(key);
    if (!bucket || !sigs) {
      bucket = [];
      sigs = new Set<string>();
      incomingByKey.set(key, bucket);
      incomingSigsByKey.set(key, sigs);
      order.push(key);
    }
    const sig = valueSignature(m);
    if (!sigs.has(sig)) {
      sigs.add(sig);
      bucket.push(m);
    }
  }

  const groups: ConflictGroup[] = [];
  for (const key of order) {
    const incomingAtKey = incomingByKey.get(key) ?? [];
    const existingAtKey = existingByKey.get(key) ?? [];

    // Distinct values across new + stored. One distinct value means everything
    // at this key is the same reading (an exact duplicate) — not a conflict.
    const distinct = new Set<string>(incomingSigsByKey.get(key));
    for (const m of existingAtKey) distinct.add(valueSignature(m));
    if (distinct.size < 2) continue;

    const representative = incomingAtKey[0];
    groups.push({
      key,
      metricId: representative.metricId,
      takenAt: representative.takenAt,
      timePrecision: representative.timePrecision,
      incoming: incomingAtKey,
      existing: existingAtKey,
    });
  }
  return groups;
}

/**
 * Turn conflict groups plus a per-group choice into the exact set of
 * measurements to add and stored ids to remove. Pure — the caller owns the
 * mutation. Semantics per {@link ConflictChoice} above.
 */
export function applyResolutions(
  groups: readonly ConflictGroup[],
  choiceFor: (group: ConflictGroup) => ConflictChoice,
): ResolvedConflicts {
  const add: Measurement[] = [];
  const removeExistingIds: MeasurementId[] = [];

  for (const group of groups) {
    const choice = choiceFor(group);
    const existingSigs = new Set(group.existing.map(valueSignature));

    switch (choice) {
      case 'keep-new': {
        // The first new value becomes the sole authoritative reading at the key:
        // every stored value here is replaced.
        add.push(group.incoming[0]);
        for (const m of group.existing) removeExistingIds.push(m.id);
        break;
      }
      case 'keep-second': {
        // Keep the SECOND distinct incoming value (import×import "keep second");
        // fall back to the first when there is only one. Any stored value at the
        // key is replaced, mirroring keep-new.
        add.push(group.incoming[1] ?? group.incoming[0]);
        for (const m of group.existing) removeExistingIds.push(m.id);
        break;
      }
      case 'keep-existing': {
        // Keep the stored value(s) untouched and drop the new value(s). With
        // nothing stored yet (a pure within-batch conflict) keep the first new
        // value so the reading is not lost entirely.
        if (group.existing.length === 0) add.push(group.incoming[0]);
        break;
      }
      case 'keep-both': {
        // Store every new value that is not already present, and keep all stored
        // ones. Multiple values at one instant, by the user's explicit choice.
        for (const m of group.incoming) {
          if (!existingSigs.has(valueSignature(m))) add.push(m);
        }
        break;
      }
      case 'keep-latest': {
        // Keep the LAST incoming occurrence in FILE ORDER (not the max value);
        // drop the earlier incoming values and replace any stored value.
        add.push(group.incoming[group.incoming.length - 1]);
        for (const m of group.existing) removeExistingIds.push(m.id);
        break;
      }
      default: {
        // keep-incoming-<i>: keep one specific incoming occurrence by index and
        // replace any stored value, mirroring keep-new for that slot. An out-of-
        // range index falls back to the first incoming so a reading is never lost.
        const idx = incomingIndex(choice);
        if (idx !== undefined) {
          add.push(group.incoming[idx] ?? group.incoming[0]);
          for (const m of group.existing) removeExistingIds.push(m.id);
        }
        break;
      }
    }
  }

  return { add, removeExistingIds };
}
