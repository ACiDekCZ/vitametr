/**
 * Shared source-picker resolution — DOM-free.
 *
 * The source picker (used by import review, manual entry, the measurement edit
 * row and the timeline bulk-change dialog) tracks a small {@link SourceSelection}
 * and, on commit, resolves it to a concrete {@link SourceId} — reusing an
 * existing source, minting a new one, mapping to the built-in manual source, or
 * clearing the attribution. This module is the pure resolver: no DOM, no clock,
 * no storage. The caller persists any returned `newSource` inside `ctx.mutate`.
 */

import type { Source, SourceId, SourceKind } from '../../core/types';
import { matchSourceByName } from '../../core/sources';
import { buildSource } from '../views/settings-model';

/** Raw selection state of a source picker. */
export type SourceSelection =
  | { mode: 'none' }
  | { mode: 'manual' }
  | { mode: 'existing'; sourceId: SourceId }
  | { mode: 'new'; name: string; kind: SourceKind };

/** Result of resolving a selection against the current sources. */
export interface ResolvedSource {
  /** The concrete source id, or undefined when the selection resolves to none. */
  sourceId: SourceId | undefined;
  /** A freshly built source the caller must append to `d.sources` (in a mutate). */
  newSource?: Source;
}

/**
 * Resolve a picker selection to a concrete source id, minting a new Source when
 * needed. A typed new-source name that matches an existing source (case-
 * insensitive, trimmed) reuses it rather than creating a duplicate. `manual`
 * maps to the profile's built-in manual source, creating one (named `manualName`)
 * when absent. A stale `existing` id (source removed since the picker opened)
 * falls back to none. Pure: the caller persists any returned `newSource`.
 */
export function resolveSourceSelection(
  sources: readonly Source[],
  selection: SourceSelection,
  manualName?: string,
): ResolvedSource {
  switch (selection.mode) {
    case 'none':
      return { sourceId: undefined };
    case 'existing': {
      const found = sources.find((s) => s.id === selection.sourceId);
      return { sourceId: found ? found.id : undefined };
    }
    case 'manual': {
      const manual = sources.find((s) => s.kind === 'manual');
      if (manual) return { sourceId: manual.id };
      const created = buildSource(sources, manualName ?? 'Manual', 'manual');
      return created ? { sourceId: created.id, newSource: created } : { sourceId: undefined };
    }
    case 'new': {
      const match = matchSourceByName(sources, selection.name);
      if (match) return { sourceId: match.id };
      const created = buildSource(sources, selection.name, selection.kind);
      // A blank name yields no source (buildSource → undefined): treat as none.
      return created ? { sourceId: created.id, newSource: created } : { sourceId: undefined };
    }
  }
}

/**
 * Display name of a resolved selection (for records/labels that carry the
 * source's name rather than its id): the new source's name, the matched
 * existing source's name, or undefined for none.
 */
export function selectionSourceName(
  sources: readonly Source[],
  selection: SourceSelection,
  manualName?: string,
): string | undefined {
  const resolved = resolveSourceSelection(sources, selection, manualName);
  if (resolved.newSource) return resolved.newSource.name;
  if (resolved.sourceId) return sources.find((s) => s.id === resolved.sourceId)?.name;
  return undefined;
}
