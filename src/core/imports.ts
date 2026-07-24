/**
 * Import history — pure logic for recording, querying and undoing file imports.
 *
 * Every file import is recorded as one {@link ImportRecord}; each committed
 * measurement is stamped with that record's `importId`. This module holds the
 * DOM-free, clock-free functions the UI composes: the UI supplies the id, the
 * timestamp and the mutation boundary (`ctx.mutate`), these functions do the
 * shaping and filtering. No `Math.random()`, no `Date.now()` here.
 */

import type { ImportRecord, Measurement, Metric, ProfileData } from './types.js';

/** Inputs for a new import record — the UI provides id + timestamp. */
export interface BuildImportRecordInput {
  id: string;
  importedAt: string;
  pluginId: string;
  sourceName?: string;
  fileName?: string;
  count: number;
}

/**
 * Build one import record, omitting optional fields that were not provided
 * (so the stored object stays as small as its inputs, matching the codebase's
 * "only set present fields" convention).
 */
export function buildImportRecord(input: BuildImportRecordInput): ImportRecord {
  return {
    id: input.id,
    importedAt: input.importedAt,
    pluginId: input.pluginId,
    ...(input.sourceName !== undefined ? { sourceName: input.sourceName } : {}),
    ...(input.fileName !== undefined ? { fileName: input.fileName } : {}),
    count: input.count,
  };
}

/**
 * Return copies of `measurements` with `importId` stamped on each. Pure: the
 * input objects are not mutated; new objects are returned in the same order.
 */
export function stampImportId(
  measurements: readonly Measurement[],
  importId: string,
): Measurement[] {
  return measurements.map((m) => ({ ...m, importId }));
}

/** The measurements created by a given import. */
export function measurementsForImport(
  measurements: readonly Measurement[],
  importId: string,
): Measurement[] {
  return measurements.filter((m) => m.importId === importId);
}

/** Import records newest-first (by `importedAt`, ties broken by id for stability). */
export function importsNewestFirst(imports: readonly ImportRecord[]): ImportRecord[] {
  return [...imports].sort((a, b) => {
    if (a.importedAt < b.importedAt) return 1;
    if (a.importedAt > b.importedAt) return -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

/**
 * Undo an import in place: drop every measurement it created and the record
 * itself. Mutates `data` (the caller owns the mutation boundary) and returns
 * the number of measurements removed. A no-op for an unknown id.
 */
export function removeImport(data: ProfileData, importId: string): number {
  const before = data.measurements.length;
  data.measurements = data.measurements.filter((m) => m.importId !== importId);
  const removed = before - data.measurements.length;
  if (data.imports) {
    data.imports = data.imports.filter((r) => r.id !== importId);
  }
  return removed;
}

/**
 * The custom metrics an import created (provenance `origin.importId === importId`).
 * A metric is stamped with its owning import at commit time; a built-in or a
 * manually/pack-created metric is never listed here.
 */
export function metricsCreatedByImport(data: ProfileData, importId: string): Metric[] {
  return data.metrics.filter((m) => m.origin?.importId === importId);
}

/**
 * Of the metrics this import created, the ones that would be left unused once the
 * import is undone — i.e. no measurement references them AFTER this import's
 * measurements are removed. A metric also fed by another import/source is
 * therefore NOT listed (it is still in use), so undoing one import never strands
 * another's data. This is the set safe to delete on undo.
 */
export function unusedMetricsCreatedByImport(data: ProfileData, importId: string): Metric[] {
  const created = metricsCreatedByImport(data, importId);
  if (created.length === 0) return [];
  // The measurement set as it will be AFTER this import is undone.
  const usedElsewhere = new Set(
    data.measurements.filter((m) => m.importId !== importId).map((m) => m.metricId),
  );
  return created.filter((m) => !usedElsewhere.has(m.id));
}

/**
 * Undo an import and, when `removeMetrics`, also delete the metrics it created
 * that are left unused by the undo. Guard: only ever removes metrics returned by
 * {@link unusedMetricsCreatedByImport} (computed BEFORE the measurements are
 * dropped), so a metric still referenced by another source is never deleted.
 * Returns how many measurements and metrics were removed.
 */
export function removeImportAndMetrics(
  data: ProfileData,
  importId: string,
  removeMetrics: boolean,
): { measurements: number; metrics: number } {
  // Compute the unused set first: it depends on the post-removal measurement set,
  // which it derives itself by excluding this import's measurements.
  const unused = removeMetrics ? unusedMetricsCreatedByImport(data, importId) : [];
  const measurements = removeImport(data, importId);
  let metrics = 0;
  if (unused.length > 0) {
    const removeSet = new Set(unused.map((m) => m.id));
    const before = data.metrics.length;
    data.metrics = data.metrics.filter((m) => !removeSet.has(m.id));
    metrics = before - data.metrics.length;
  }
  return { measurements, metrics };
}
