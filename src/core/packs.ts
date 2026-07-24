/**
 * Pack model — pure logic. Packs control the VISIBILITY of built-in metrics;
 * they no longer add or remove anything. See `docs/PLAN-BALICKY-VIDITELNOST.md`.
 *
 * A metric is VISIBLE (overview, metrics list, tag filters, pickers of tracked
 * metrics) iff:
 *  - it is a user/import/manual metric (not a built-in) — always visible; OR
 *  - it has ≥1 measurement (data is never hidden) — always visible; OR
 *  - it is a built-in provided by an ACTIVE pack: Core active and its key is in
 *    {@link CORE_METRIC_KEYS}, OR some active category pack's tag is in its tags;
 *  MINUS `data.disabledMetrics` (an explicit user hide wins, even over data);
 *  PLUS `settings.shownMetrics` (forced show, from the import-review flow).
 *
 * RESOLUTION (`catalog.byKey/byLoinc/resolveAlias`) runs over the UNFILTERED
 * catalog, so an import always finds a hidden metric and can offer to reveal it.
 *
 * `activatePack`/`deactivatePack` only toggle the pack id in `settings.activePacks`
 * — they mutate the passed {@link ProfileData} in place (the caller owns the
 * mutation boundary) and delete NOTHING. Core is a normal, deactivatable pack.
 *
 * Normalization: `settings.activePacks` absent ⇒ treated as `['builtin:core']`
 * (Core on by default, backward-compatible). Reading never mutates stored
 * settings — {@link effectiveActivePacks} returns the normalized view.
 */

import type { Catalog } from './contracts';
import type { Metric, MetricId, ProfileData, ProfileSettings } from './types';
import type { VitametrPack } from '../plugins/import/pack';
import {
  CORE_METRIC_KEYS,
  CORE_PACK_ID,
  bundledPackById,
  bundledPackId,
  packProvidedKeys,
} from './packs-data';
import { primaryTag } from './tags';
import { t, type StringKey } from '../i18n/index';

export { CORE_PACK_ID };

/**
 * Backward-compatible alias. The always-on seed is now the deactivatable "Core"
 * pack; its id is {@link CORE_PACK_ID}. Kept so existing imports keep compiling.
 */
export const SEED_PACK_ID = CORE_PACK_ID;

const CORE_KEY_SET = new Set<string>(CORE_METRIC_KEYS);

// ---------------------------------------------------------------------------
// Active packs (with the absent ⇒ ['builtin:core'] normalization)
// ---------------------------------------------------------------------------

/**
 * The normalized active-pack list: the stored ids, or `['builtin:core']` when
 * `settings.activePacks` is absent (Core on by default). Pure — never mutates
 * the settings object.
 */
export function effectiveActivePacks(settings: ProfileSettings): string[] {
  return settings.activePacks ?? [CORE_PACK_ID];
}

/** The profile's currently-active pack ids (normalized). */
export function activePacks(data: ProfileData): string[] {
  return effectiveActivePacks(data.settings);
}

/** Whether a pack id is currently active (respecting normalization). */
export function isPackActive(data: ProfileData, packId: string): boolean {
  return activePacks(data).includes(packId);
}

// ---------------------------------------------------------------------------
// Visibility predicate
// ---------------------------------------------------------------------------

interface VisibilityContext {
  active: string[];
  usedIds: Set<MetricId>;
  disabled: Set<MetricId>;
  shown: Set<MetricId>;
}

/** Build the sets the visibility predicate needs, once, for a given active list. */
function visibilityContext(data: ProfileData, active: string[]): VisibilityContext {
  return {
    active,
    usedIds: new Set<MetricId>(data.measurements.map((m) => m.metricId)),
    disabled: new Set<MetricId>(data.disabledMetrics ?? []),
    shown: new Set<MetricId>(data.settings.shownMetrics ?? []),
  };
}

/** The visibility predicate for one metric under a prepared context. */
function isVisibleIn(metric: Metric, ctx: VisibilityContext): boolean {
  if (ctx.shown.has(metric.id)) return true; // forced show wins
  if (ctx.disabled.has(metric.id)) return false; // explicit hide wins over data
  if (!metric.id.startsWith('builtin:')) return true; // user / import / manual
  if (ctx.usedIds.has(metric.id)) return true; // data is never hidden
  // Provided by an active pack?
  if (ctx.active.includes(CORE_PACK_ID) && metric.key !== undefined && CORE_KEY_SET.has(metric.key)) {
    return true;
  }
  const tags = metric.tags ?? [];
  for (const packId of ctx.active) {
    if (packId === CORE_PACK_ID) continue;
    if (packId.startsWith('bundled:') && tags.includes(packId.slice('bundled:'.length))) return true;
  }
  return false;
}

/** Whether a single metric is currently visible in the profile. */
export function isMetricVisible(data: ProfileData, metric: Metric): boolean {
  return isVisibleIn(metric, visibilityContext(data, activePacks(data)));
}

/** Filter a metric list to the currently-visible ones (the `catalog.visible()` set). */
export function visibleMetrics(data: ProfileData, metrics: readonly Metric[]): Metric[] {
  const ctx = visibilityContext(data, activePacks(data));
  return metrics.filter((m) => isVisibleIn(m, ctx));
}

// ---------------------------------------------------------------------------
// Hidden-metric detection (import-review "belongs to a disabled pack" flow)
// ---------------------------------------------------------------------------

/**
 * The pack whose activation would REVEAL a currently-hidden built-in metric, for
 * the import-review "activate the pack" action. Prefers an INACTIVE bundled
 * category pack whose tag the metric carries (its primary panel tag first, then
 * any other tag); falls back to the Core pack when the metric's key is in
 * {@link CORE_METRIC_KEYS} and Core is inactive. `undefined` when nothing on
 * offer would reveal it (e.g. a tagless non-core built-in). Pure — no mutation.
 */
export function suggestPackForMetric(
  data: ProfileData,
  _catalog: Catalog,
  metric: Metric,
): string | undefined {
  const active = new Set(activePacks(data));
  const tags = metric.tags ?? [];
  // Primary panel tag first, then the remaining tags — an inactive bundled
  // category pack for any of them would make the metric visible again.
  const primary = primaryTag(tags);
  const ordered = [primary, ...tags.filter((tag) => tag !== primary)];
  for (const tag of ordered) {
    const packId = bundledPackId(tag);
    if (bundledPackById(packId) && !active.has(packId)) return packId;
  }
  // Else the Core pack, when it provides this metric and is currently off.
  if (metric.key !== undefined && CORE_KEY_SET.has(metric.key) && !active.has(CORE_PACK_ID)) {
    return CORE_PACK_ID;
  }
  return undefined;
}

/** Whether a resolved metric is currently hidden, plus the pack that would reveal it. */
export interface HiddenMetricState {
  /** True when the metric exists but no active pack makes it visible. */
  hidden: boolean;
  /** The pack whose activation would reveal it (see {@link suggestPackForMetric}). */
  suggestedPackId?: string;
}

/**
 * Detect the import-review "belongs to a disabled pack" state: given a resolved
 * metric, whether it is currently hidden and, if so, which pack would reveal it.
 * A visible metric (active pack provides it, has data, or is the user's own)
 * returns `{ hidden: false }`. Pure — no DOM, no mutation.
 */
export function hiddenMetricState(
  data: ProfileData,
  catalog: Catalog,
  metric: Metric,
): HiddenMetricState {
  if (isMetricVisible(data, metric)) return { hidden: false };
  const suggestedPackId = suggestPackForMetric(data, catalog, metric);
  return { hidden: true, ...(suggestedPackId ? { suggestedPackId } : {}) };
}

// ---------------------------------------------------------------------------
// Activate / deactivate — pure visibility flags
// ---------------------------------------------------------------------------

export interface ActivateResult {
  /** Built-in metrics that become NEWLY visible because of this pack. */
  shown: number;
  /** Its provided metrics that were already visible (Core / other pack / data). */
  alreadyVisible: number;
}

export interface DeactivateResult {
  /** Metrics that become hidden by turning this pack off. */
  hidden: number;
  /** Its metrics that stay visible (data, or another active pack provides them). */
  keptVisible: number;
}

/** The provided built-in metrics of a pack, resolved against the catalog. */
function providedMetrics(catalog: Catalog, packId: string): Metric[] {
  const out: Metric[] = [];
  for (const key of packProvidedKeys(packId, catalog)) {
    const m = catalog.byKey(key);
    if (m) out.push(m);
  }
  return out;
}

/**
 * Activate a pack: add its id to `settings.activePacks` (normalizing absent ⇒
 * `['builtin:core']` first, deduped). Deletes/creates nothing. Returns how many
 * of its provided metrics become newly visible vs. were already visible.
 */
export function activatePack(data: ProfileData, catalog: Catalog, packId: string): ActivateResult {
  const metrics = providedMetrics(catalog, packId);
  const before = visibilityContext(data, activePacks(data));
  const wasVisible = metrics.map((m) => isVisibleIn(m, before));

  const list = [...activePacks(data)];
  if (!list.includes(packId)) list.push(packId);
  data.settings.activePacks = list;

  const after = visibilityContext(data, list);
  let shown = 0;
  let alreadyVisible = 0;
  metrics.forEach((m, i) => {
    if (wasVisible[i]) alreadyVisible += 1;
    else if (isVisibleIn(m, after)) shown += 1;
  });
  return { shown, alreadyVisible };
}

/**
 * The shared, non-mutating computation behind {@link deactivatePack} and
 * {@link previewDeactivate}: of the pack's currently-visible provided metrics,
 * how many would be hidden vs. stay visible if the pack were turned off.
 */
function planVisibilityChange(
  data: ProfileData,
  catalog: Catalog,
  packId: string,
): DeactivateResult {
  const metrics = providedMetrics(catalog, packId);
  const current = visibilityContext(data, activePacks(data));
  const without = visibilityContext(
    data,
    activePacks(data).filter((id) => id !== packId),
  );
  let hidden = 0;
  let keptVisible = 0;
  for (const m of metrics) {
    if (!isVisibleIn(m, current)) continue; // not currently visible → unaffected
    if (isVisibleIn(m, without)) keptVisible += 1;
    else hidden += 1;
  }
  return { hidden, keptVisible };
}

/**
 * Deactivate a pack: remove its id from `settings.activePacks`. Deletes NOTHING —
 * its metrics simply stop being pack-provided (they stay visible if they have
 * data or another active pack provides them). Returns the hidden / kept counts.
 */
export function deactivatePack(
  data: ProfileData,
  catalog: Catalog,
  packId: string,
): DeactivateResult {
  const result = planVisibilityChange(data, catalog, packId);
  data.settings.activePacks = activePacks(data).filter((id) => id !== packId);
  return result;
}

/**
 * Dry-run of {@link deactivatePack}: the same hidden / kept counts WITHOUT
 * mutating, via the shared {@link planVisibilityChange}.
 */
export function previewDeactivate(
  data: ProfileData,
  catalog: Catalog,
  packId: string,
): DeactivateResult {
  return planVisibilityChange(data, catalog, packId);
}

// ---------------------------------------------------------------------------
// Pure preview helpers (for the GUI)
// ---------------------------------------------------------------------------

export interface PackOverlap {
  /** Total metrics the pack provides. */
  total: number;
  /** How many of them are ALREADY visible without this pack active. */
  alreadyHave: number;
}

/** A metric's display name, mirroring the UI's `metricName` resolution. */
function metricDisplayName(m: Metric): string {
  if (m.customName) return m.customName;
  if (m.nameKey) return t(m.nameKey as StringKey);
  return m.key ?? m.id;
}

/**
 * How much of a pack the user already has visible WITHOUT it active — total
 * provided metrics and how many are already visible (via Core / another pack /
 * data). Full overlap (`total === alreadyHave`) drives the "you already have
 * everything" chip. Pure: no mutation.
 */
export function packOverlap(data: ProfileData, catalog: Catalog, pack: VitametrPack): PackOverlap {
  const metrics = providedMetrics(catalog, pack.id);
  const without = visibilityContext(
    data,
    activePacks(data).filter((id) => id !== pack.id),
  );
  let alreadyHave = 0;
  for (const m of metrics) if (isVisibleIn(m, without)) alreadyHave += 1;
  return { total: metrics.length, alreadyHave };
}

export interface PackContentItem {
  /** Display name (localised metric name when present, else the pack def name). */
  name: string;
  /** Canonical unit (empty for non-numeric metrics). */
  unit: string;
  /** Whether the profile has ≥1 measurement for this metric (a value on record). */
  hasData: boolean;
  /** ISO `takenAt` of the latest measurement — present only when {@link hasData}. */
  lastMeasuredAtIso?: string;
}

/**
 * The pack's metrics as a display list for the row-expansion preview: each
 * metric's name + canonical unit, plus whether the user already has a measured
 * value for it and when it was last recorded. "Has a value" is a clearer, always-
 * meaningful signal than raw visibility (a pack's own metrics are trivially
 * visible when it is active). Pure: no mutation, no clock.
 */
export function packContents(
  data: ProfileData,
  catalog: Catalog,
  pack: VitametrPack,
): PackContentItem[] {
  // Latest measurement instant per metric id (ISO compared via Date.parse).
  const lastAt = new Map<MetricId, string>();
  for (const m of data.measurements) {
    const cur = lastAt.get(m.metricId);
    if (cur === undefined || Date.parse(m.takenAt) > Date.parse(cur)) {
      lastAt.set(m.metricId, m.takenAt);
    }
  }
  return (pack.metrics ?? []).map((def) => {
    const existing = catalog.byKey(def.key);
    const numeric = (def.valueType ?? 'number') === 'number';
    const iso = existing ? lastAt.get(existing.id) : undefined;
    return {
      name: existing ? metricDisplayName(existing) : def.name,
      unit: numeric ? (def.unit ?? existing?.canonicalUnit ?? '') : '',
      hasData: iso !== undefined,
      ...(iso !== undefined ? { lastMeasuredAtIso: iso } : {}),
    };
  });
}

// Re-export so callers get the whole model from one module.
export {
  bundledPacks,
  bundledPackById,
  bundledPackNameKey,
  BUNDLED_PACKS,
  CORE_PACK,
  CORE_METRIC_KEYS,
  packProvidedKeys,
} from './packs-data';
