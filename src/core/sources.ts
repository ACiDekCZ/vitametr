/**
 * Source suggestion for the import review — DOM-free logic.
 *
 * Imported measurements are attributed to a {@link Source} the same way manual
 * entry is. Lab parsers stamp a free-text `sourceName` on their proposals; this
 * module turns that name (plus the originating import plugin id) into a concrete
 * suggestion the review screen offers: reuse an existing source, create a new
 * one, or none. Pure and side-effect free — the caller persists the resolved
 * choice inside `ctx.mutate`.
 */

import type { Source, SourceId, SourceKind } from './types';

/**
 * Infer the most likely {@link SourceKind} for a source created from an import,
 * from the originating import plugin id. Lab-shaped formats map to `lab`, Apple
 * Health to `app`; anything else falls back to `other`.
 */
export function inferSourceKind(pluginId: string | undefined): SourceKind {
  switch (pluginId) {
    case 'pdf':
    case 'lab-text':
    case 'fhir':
    case 'hl7v2':
    case 'generic':
    case 'generic-lab':
      return 'lab';
    case 'apple-health':
      return 'app';
    default:
      return 'other';
  }
}

/** Case-insensitive, trimmed lookup of a source by display name. */
export function matchSourceByName(
  sources: readonly Source[],
  name: string,
): Source | undefined {
  const needle = name.trim().toLowerCase();
  if (!needle) return undefined;
  return sources.find((s) => s.name.trim().toLowerCase() === needle);
}

/**
 * What the review screen should suggest for the import's source:
 * - `existing` — the import's source name matches a stored source (reuse it);
 * - `new` — a source name is present but unknown (offer to create it);
 * - `none` — no source name was carried by the import.
 */
export type SourceSuggestion =
  | { mode: 'existing'; sourceId: SourceId; name: string; kind: SourceKind }
  | { mode: 'new'; name: string; kind: SourceKind }
  | { mode: 'none' };

/**
 * Suggest a source from the committable proposals' agreed `sourceName` and the
 * originating plugin id. Smart-matches the name against existing sources
 * (case-insensitive, trimmed); on a miss with a non-empty name it proposes a
 * new source with an inferred kind; with no name it suggests none.
 */
export function suggestSource(
  sources: readonly Source[],
  sourceName: string | undefined,
  pluginId: string | undefined,
): SourceSuggestion {
  const name = sourceName?.trim();
  if (!name) return { mode: 'none' };
  const existing = matchSourceByName(sources, name);
  if (existing) {
    return { mode: 'existing', sourceId: existing.id, name: existing.name, kind: existing.kind };
  }
  return { mode: 'new', name, kind: inferSourceKind(pluginId) };
}
