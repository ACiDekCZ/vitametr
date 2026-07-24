import { describe, expect, it } from 'vitest';

import {
  applyResolutions,
  conflictKeyForMeasurement,
  conflictKind,
  detectConflicts,
  keepIncoming,
  DEFAULT_CONFLICT_CHOICE,
  type ConflictChoice,
  type ConflictGroup,
} from '../conflicts.js';
import type {
  Measurement,
  MeasurementId,
  MetricId,
  ProfileId,
} from '../types.js';

/** A measurement builder with sensible defaults, overridable per field. */
function m(over: Omit<Partial<Measurement>, 'id'> & { id: string }): Measurement {
  return {
    profileId: 'p1' as ProfileId,
    metricId: 'builtin:glucose' as MetricId,
    value: 5.4,
    unit: 'mmol/L',
    takenAt: '2026-02-10',
    timePrecision: 'date',
    status: 'confirmed',
    origin: { pluginId: 'csv' },
    createdAt: '2026-07-21T10:00',
    modifiedAt: '2026-07-21T10:00',
    ...over,
    id: over.id as MeasurementId,
  };
}

/** Resolve every group with one fixed choice. */
function withChoice(choice: ConflictChoice): (g: ConflictGroup) => ConflictChoice {
  return () => choice;
}

describe('detectConflicts', () => {
  it('returns nothing when there are no shared keys', () => {
    const existing = [m({ id: 'a', metricId: 'builtin:glucose' as MetricId, value: 5 })];
    const incoming = [m({ id: 'b', metricId: 'builtin:hemoglobin' as MetricId, value: 140, unit: 'g/L' })];
    expect(detectConflicts(existing, incoming)).toEqual([]);
  });

  it('ignores an exact duplicate (same metric+instant+value+unit)', () => {
    const existing = [m({ id: 'a', value: 5.4 })];
    const incoming = [m({ id: 'b', value: 5.4 })];
    expect(detectConflicts(existing, incoming)).toEqual([]);
  });

  it('detects an incoming-vs-stored conflict (same key, different numeric value)', () => {
    const existing = [m({ id: 'a', value: 5.4 })];
    const incoming = [m({ id: 'b', value: 6.9 })];
    const groups = detectConflicts(existing, incoming);
    expect(groups).toHaveLength(1);
    expect(groups[0].metricId).toBe('builtin:glucose');
    expect(groups[0].takenAt).toBe('2026-02-10');
    expect(groups[0].incoming.map((x) => x.id)).toEqual(['b']);
    expect(groups[0].existing.map((x) => x.id)).toEqual(['a']);
    expect(groups[0].key).toBe(conflictKeyForMeasurement(incoming[0]));
  });

  it('detects a within-batch conflict (two incoming, different values, nothing stored)', () => {
    const incoming = [m({ id: 'a', value: 5.4 }), m({ id: 'b', value: 6.9 })];
    const groups = detectConflicts([], incoming);
    expect(groups).toHaveLength(1);
    expect(groups[0].incoming.map((x) => x.id)).toEqual(['a', 'b']);
    expect(groups[0].existing).toEqual([]);
  });

  it('deduplicates identical incoming values within a batch (keeps first, no false conflict)', () => {
    const incoming = [m({ id: 'a', value: 5.4 }), m({ id: 'b', value: 5.4 })];
    // Two identical incoming = one distinct value = exact-dup, not a conflict.
    expect(detectConflicts([], incoming)).toEqual([]);
  });

  it('detects a text-vs-numeric conflict at the same key', () => {
    const existing = [
      m({ id: 'a', value: undefined, unit: '', textValue: 'negativní', metricId: 'builtin:urine-leukocyte-esterase' as MetricId }),
    ];
    const incoming = [
      m({ id: 'b', value: 3, operator: '<', unit: 'pocet/uL', metricId: 'builtin:urine-leukocyte-esterase' as MetricId }),
    ];
    const groups = detectConflicts(existing, incoming);
    expect(groups).toHaveLength(1);
    expect(groups[0].incoming.map((x) => x.id)).toEqual(['b']);
    expect(groups[0].existing.map((x) => x.id)).toEqual(['a']);
  });

  it('treats different units at the same key as a conflict', () => {
    const existing = [m({ id: 'a', value: 5.4, unit: 'mmol/L' })];
    const incoming = [m({ id: 'b', value: 5.4, unit: 'mg/dL' })];
    expect(detectConflicts(existing, incoming)).toHaveLength(1);
  });

  it('does not conflate different instants', () => {
    const existing = [m({ id: 'a', value: 5.4, takenAt: '2026-02-10' })];
    const incoming = [m({ id: 'b', value: 6.9, takenAt: '2026-02-11' })];
    expect(detectConflicts(existing, incoming)).toEqual([]);
  });

  it('handles a mix: one conflicting key and one clean key', () => {
    const existing = [
      m({ id: 'a', metricId: 'builtin:glucose' as MetricId, value: 5.4 }),
      m({ id: 'c', metricId: 'builtin:creatinine' as MetricId, value: 78, unit: 'umol/L' }),
    ];
    const incoming = [
      m({ id: 'b', metricId: 'builtin:glucose' as MetricId, value: 6.9 }), // conflict
      m({ id: 'd', metricId: 'builtin:creatinine' as MetricId, value: 78, unit: 'umol/L' }), // exact dup
      m({ id: 'e', metricId: 'builtin:hemoglobin' as MetricId, value: 140, unit: 'g/L' }), // new, no clash
    ];
    const groups = detectConflicts(existing, incoming);
    expect(groups).toHaveLength(1);
    expect(groups[0].metricId).toBe('builtin:glucose');
  });

  it('preserves incoming order across multiple conflict groups', () => {
    const existing = [
      m({ id: 'a', metricId: 'builtin:glucose' as MetricId, value: 5 }),
      m({ id: 'c', metricId: 'builtin:tsh' as MetricId, value: 2, unit: 'mIU/L' }),
    ];
    const incoming = [
      m({ id: 't', metricId: 'builtin:tsh' as MetricId, value: 3, unit: 'mIU/L' }),
      m({ id: 'g', metricId: 'builtin:glucose' as MetricId, value: 6 }),
    ];
    const groups = detectConflicts(existing, incoming);
    expect(groups.map((grp) => grp.metricId)).toEqual(['builtin:tsh', 'builtin:glucose']);
  });
});

describe('conflictKind', () => {
  it('classifies a stored-vs-import conflict (something already stored)', () => {
    const groups = detectConflicts([m({ id: 'a', value: 5.4 })], [m({ id: 'b', value: 6.9 })]);
    expect(conflictKind(groups[0])).toBe('stored-vs-import');
  });

  it('classifies an import-vs-import conflict (nothing stored)', () => {
    const groups = detectConflicts([], [m({ id: 'a', value: 5.4 }), m({ id: 'b', value: 6.9 })]);
    expect(conflictKind(groups[0])).toBe('import-vs-import');
  });
});

describe('applyResolutions', () => {
  it('keep-second within a batch: keeps the second new value, drops the first', () => {
    const incoming = [m({ id: 'a', value: 5.4 }), m({ id: 'b', value: 6.9 })];
    const groups = detectConflicts([], incoming);
    const { add, removeExistingIds } = applyResolutions(groups, withChoice('keep-second'));
    expect(add.map((x) => x.id)).toEqual(['b']);
    expect(removeExistingIds).toEqual([]);
  });

  it('keep-second with only one incoming falls back to the first', () => {
    const existing = [m({ id: 'a', value: 5.4 })];
    const incoming = [m({ id: 'b', value: 6.9 })];
    const groups = detectConflicts(existing, incoming);
    const { add, removeExistingIds } = applyResolutions(groups, withChoice('keep-second'));
    expect(add.map((x) => x.id)).toEqual(['b']);
    expect(removeExistingIds).toEqual(['a']);
  });


  it('keep-new: adds the new value and removes the replaced stored one', () => {
    const existing = [m({ id: 'a', value: 5.4 })];
    const incoming = [m({ id: 'b', value: 6.9 })];
    const groups = detectConflicts(existing, incoming);
    const { add, removeExistingIds } = applyResolutions(groups, withChoice('keep-new'));
    expect(add.map((x) => x.id)).toEqual(['b']);
    expect(removeExistingIds).toEqual(['a']);
  });

  it('keep-new within a batch: keeps the first new value, drops the rest, removes nothing', () => {
    const incoming = [m({ id: 'a', value: 5.4 }), m({ id: 'b', value: 6.9 })];
    const groups = detectConflicts([], incoming);
    const { add, removeExistingIds } = applyResolutions(groups, withChoice('keep-new'));
    expect(add.map((x) => x.id)).toEqual(['a']);
    expect(removeExistingIds).toEqual([]);
  });

  it('keep-existing: imports nothing and keeps the stored value', () => {
    const existing = [m({ id: 'a', value: 5.4 })];
    const incoming = [m({ id: 'b', value: 6.9 })];
    const groups = detectConflicts(existing, incoming);
    const { add, removeExistingIds } = applyResolutions(groups, withChoice('keep-existing'));
    expect(add).toEqual([]);
    expect(removeExistingIds).toEqual([]);
  });

  it('keep-existing within a batch with nothing stored: keeps the first new value', () => {
    const incoming = [m({ id: 'a', value: 5.4 }), m({ id: 'b', value: 6.9 })];
    const groups = detectConflicts([], incoming);
    const { add, removeExistingIds } = applyResolutions(groups, withChoice('keep-existing'));
    expect(add.map((x) => x.id)).toEqual(['a']);
    expect(removeExistingIds).toEqual([]);
  });

  it('keep-both: adds all new values and keeps the stored one', () => {
    const existing = [m({ id: 'a', value: 5.4 })];
    const incoming = [m({ id: 'b', value: 6.9 })];
    const groups = detectConflicts(existing, incoming);
    const { add, removeExistingIds } = applyResolutions(groups, withChoice('keep-both'));
    expect(add.map((x) => x.id)).toEqual(['b']);
    expect(removeExistingIds).toEqual([]);
  });

  it('keep-both within a batch: adds every distinct new value', () => {
    const incoming = [m({ id: 'a', value: 5.4 }), m({ id: 'b', value: 6.9 })];
    const groups = detectConflicts([], incoming);
    const { add } = applyResolutions(groups, withChoice('keep-both'));
    expect(add.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('keep-both does not re-add an incoming value already present in storage', () => {
    // Stored has both 5.4 (equal to an incoming) and 5.4->conflict via another
    // stored 6.9; the incoming 5.4 must not be duplicated.
    const existing = [m({ id: 'a', value: 5.4 }), m({ id: 'c', value: 6.9 })];
    const incoming = [m({ id: 'b', value: 5.4 })];
    const groups = detectConflicts(existing, incoming);
    expect(groups).toHaveLength(1);
    const { add } = applyResolutions(groups, withChoice('keep-both'));
    expect(add).toEqual([]); // 5.4 already stored, nothing to add
  });

  it('applies different choices to different groups', () => {
    const existing = [
      m({ id: 'a', metricId: 'builtin:glucose' as MetricId, value: 5 }),
      m({ id: 'c', metricId: 'builtin:tsh' as MetricId, value: 2, unit: 'mIU/L' }),
    ];
    const incoming = [
      m({ id: 'g', metricId: 'builtin:glucose' as MetricId, value: 6 }),
      m({ id: 't', metricId: 'builtin:tsh' as MetricId, value: 3, unit: 'mIU/L' }),
    ];
    const groups = detectConflicts(existing, incoming);
    const choiceByMetric: Record<string, ConflictChoice> = {
      'builtin:glucose': 'keep-new',
      'builtin:tsh': 'keep-existing',
    };
    const { add, removeExistingIds } = applyResolutions(
      groups,
      (grp) => choiceByMetric[grp.metricId] ?? DEFAULT_CONFLICT_CHOICE,
    );
    expect(add.map((x) => x.id)).toEqual(['g']); // glucose kept new
    expect(removeExistingIds).toEqual(['a']); // glucose old removed; tsh untouched
  });

  it('keep-latest (N=2, import×import): keeps the last incoming, drops the first', () => {
    const incoming = [m({ id: 'a', value: 5.4 }), m({ id: 'b', value: 6.9 })];
    const groups = detectConflicts([], incoming);
    const { add, removeExistingIds } = applyResolutions(groups, withChoice('keep-latest'));
    expect(add.map((x) => x.id)).toEqual(['b']);
    expect(removeExistingIds).toEqual([]);
  });

  it('keep-latest (N=2, stored×import): keeps the incoming, replaces the stored value', () => {
    const existing = [m({ id: 's', value: 5.4 })];
    const incoming = [m({ id: 'b', value: 6.9 })];
    const groups = detectConflicts(existing, incoming);
    const { add, removeExistingIds } = applyResolutions(groups, withChoice('keep-latest'));
    expect(add.map((x) => x.id)).toEqual(['b']);
    expect(removeExistingIds).toEqual(['s']);
  });

  it('keep-latest (N=10, import×import): keeps the last occurrence in file order', () => {
    const incoming = Array.from({ length: 10 }, (_, i) =>
      m({ id: `i${i}`, value: 5 + i * 0.1 }),
    );
    const groups = detectConflicts([], incoming);
    expect(groups[0].incoming).toHaveLength(10);
    const { add, removeExistingIds } = applyResolutions(groups, withChoice('keep-latest'));
    expect(add.map((x) => x.id)).toEqual(['i9']);
    expect(removeExistingIds).toEqual([]);
  });

  it('keep-latest (N=10, stored×import): keeps the last incoming and removes the stored value', () => {
    const existing = [m({ id: 's', value: 4.0 })];
    const incoming = Array.from({ length: 10 }, (_, i) =>
      m({ id: `i${i}`, value: 5 + i * 0.1 }),
    );
    const groups = detectConflicts(existing, incoming);
    const { add, removeExistingIds } = applyResolutions(groups, withChoice('keep-latest'));
    expect(add.map((x) => x.id)).toEqual(['i9']);
    expect(removeExistingIds).toEqual(['s']);
  });

  it('keep-latest is last-in-file, not the maximum value', () => {
    // The largest value is first; "latest" must still keep the final one.
    const incoming = [m({ id: 'big', value: 9.9 }), m({ id: 'last', value: 5.1 })];
    const groups = detectConflicts([], incoming);
    const { add } = applyResolutions(groups, withChoice('keep-latest'));
    expect(add.map((x) => x.id)).toEqual(['last']);
  });

  it('keep-incoming-<i>: keeps the specific occurrence at index i (middle block)', () => {
    const incoming = Array.from({ length: 5 }, (_, i) => m({ id: `i${i}`, value: 5 + i * 0.1 }));
    const groups = detectConflicts([], incoming);
    const { add, removeExistingIds } = applyResolutions(groups, () => keepIncoming(2));
    expect(add.map((x) => x.id)).toEqual(['i2']);
    expect(removeExistingIds).toEqual([]);
  });

  it('keep-incoming-<i> replaces any stored value, like keep-new', () => {
    const existing = [m({ id: 's', value: 4.0 })];
    const incoming = [m({ id: 'a', value: 5.4 }), m({ id: 'b', value: 6.9 }), m({ id: 'c', value: 7.2 })];
    const groups = detectConflicts(existing, incoming);
    const { add, removeExistingIds } = applyResolutions(groups, () => keepIncoming(2));
    expect(add.map((x) => x.id)).toEqual(['c']);
    expect(removeExistingIds).toEqual(['s']);
  });

  it('default choice is keep-new', () => {
    expect(DEFAULT_CONFLICT_CHOICE).toBe('keep-new');
  });

  it('does not mutate its inputs', () => {
    const existing = [m({ id: 'a', value: 5.4 })];
    const incoming = [m({ id: 'b', value: 6.9 })];
    const groups = detectConflicts(existing, incoming);
    const snapshot = JSON.stringify(groups);
    applyResolutions(groups, withChoice('keep-new'));
    expect(JSON.stringify(groups)).toBe(snapshot);
    expect(existing[0].id).toBe('a');
  });
});
