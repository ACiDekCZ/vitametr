/**
 * Generic pre-import filter ("What to import") — DOM-free view model.
 *
 * A large import (Apple Health's years of records, a long CSV) should not be
 * dumped wholesale into the review screen. Between parse and review a generic
 * step lets the user narrow by PERIOD (a date range) and by METRIC (which of the
 * distinct metrics/types present to keep). This module holds all of that step's
 * pure arithmetic so it can be unit-tested without a DOM: the "is it worth
 * showing" threshold, the per-metric aggregation, the file summary, the
 * apply/keep logic, the live per-period counts and the default preset.
 *
 * It is generic across every import format: it operates on the pipeline's
 * `ReviewItem[]` (the same batch the review screen consumes), never on any
 * plugin's raw shape. Nothing is ever silently dropped — the default preset is
 * "all" and every metric starts selected (an unresolved metric starts unselected
 * only when the caller's "known only" mode is on, and even then it is shown, not
 * hidden). No DOM, no i18n, no clock: the caller injects a name resolver and the
 * current time as an ISO string.
 */

import type { ReviewItem } from '../../core/contracts';
import type { MetricId } from '../../core/types';
import { endOfDayMs } from '../../core/snapshot';

// ---------------------------------------------------------------------------
// Thresholds — when the step is worth showing (doc §1)
// ---------------------------------------------------------------------------

/** A batch larger than this many items is worth a filter step. */
export const FILTER_MIN_ITEMS = 50;
/** A batch whose dated items span more than this is worth a filter step. */
export const FILTER_SPAN_MS = 365 * 24 * 60 * 60 * 1000; // ~1 year
/** A batch with more than this many distinct metrics is worth a filter step. */
export const FILTER_MIN_METRICS = 8;
/** A span wider than this pre-selects the "last year" preset (doc §2). */
export const FILTER_PRESELECT_SPAN_MS = 5 * FILTER_SPAN_MS; // ~5 years

/**
 * Whether the pre-import filter is worth showing for this batch. True when the
 * batch is big enough to be a burden in review: more than {@link FILTER_MIN_ITEMS}
 * items, OR its dated items span more than {@link FILTER_SPAN_MS}, OR it holds more
 * than {@link FILTER_MIN_METRICS} distinct metrics. A small import returns false
 * and goes straight to review — no extra friction.
 */
export function shouldShowImportFilter(items: ReviewItem[]): boolean {
  if (items.length > FILTER_MIN_ITEMS) return true;
  if (distinctMetricCount(items) > FILTER_MIN_METRICS) return true;
  const span = datedSpanMs(items);
  return span !== undefined && span > FILTER_SPAN_MS;
}

// ---------------------------------------------------------------------------
// Item → metric identity
// ---------------------------------------------------------------------------

/**
 * The catalog metric id an item resolves to, if any: an explicit resolution wins,
 * otherwise the proposal's own metric when it is already an id (a string). An
 * unresolved proposal (a `{ unresolvedName }`) has none.
 */
export function itemMetricId(item: ReviewItem): MetricId | undefined {
  if (item.resolvedMetricId) return item.resolvedMetricId;
  const m = item.proposed.metric;
  return typeof m === 'string' ? m : undefined;
}

/** The raw unresolved name of an item, or undefined when it resolves to a metric. */
function unresolvedName(item: ReviewItem): string | undefined {
  const m = item.proposed.metric;
  return typeof m === 'string' ? undefined : m.unresolvedName;
}

/**
 * Stable grouping key for an item: its resolved metric id, or an `unresolved:`
 * prefix + the raw name so two proposals for the same unrecognized name group
 * together while never colliding with a real metric id.
 */
export function groupKey(item: ReviewItem): string {
  const id = itemMetricId(item);
  if (id !== undefined) return id;
  return `unresolved:${unresolvedName(item) ?? ''}`;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface MetricGroup {
  /** {@link groupKey} — the selection key the view checks/unchecks. */
  key: string;
  /** Resolved catalog metric id; absent for an unresolved group. */
  metricId?: MetricId;
  /** Display name (resolved catalog name, or the raw unresolved name). */
  name: string;
  /** True when this group is an unrecognized raw name (review's "Unresolved"). */
  unresolved: boolean;
  /** How many items fall in this group (over the whole batch). */
  count: number;
  /** Earliest / latest `takenAt` in the group (ISO), when any item is dated. */
  minIso?: string;
  maxIso?: string;
}

/**
 * One {@link MetricGroup} per distinct metric — resolved items group by catalog
 * id, unresolved items by raw name — with a count and date span over the group.
 * `resolveName(item)` is injected so the model stays free of the catalog and
 * i18n; the first item seen in a group provides its display name. Groups come out
 * in first-seen order (stable, deterministic).
 */
export function aggregateByMetric(
  items: ReviewItem[],
  resolveName: (item: ReviewItem) => string,
): MetricGroup[] {
  const groups = new Map<string, MetricGroup>();
  for (const item of items) {
    const key = groupKey(item);
    const iso = item.proposed.takenAt;
    const t = iso ? Date.parse(iso) : NaN;
    let g = groups.get(key);
    if (g === undefined) {
      const id = itemMetricId(item);
      g = {
        key,
        ...(id !== undefined ? { metricId: id } : {}),
        name: resolveName(item),
        unresolved: id === undefined,
        count: 0,
      };
      groups.set(key, g);
    }
    g.count += 1;
    if (iso && !Number.isNaN(t)) {
      if (g.minIso === undefined || t < Date.parse(g.minIso)) g.minIso = iso;
      if (g.maxIso === undefined || t > Date.parse(g.maxIso)) g.maxIso = iso;
    }
  }
  return [...groups.values()];
}

/** Distinct metric groups in the batch (resolved ids + unresolved raw names). */
function distinctMetricCount(items: ReviewItem[]): number {
  const keys = new Set<string>();
  for (const item of items) keys.add(groupKey(item));
  return keys.size;
}

// ---------------------------------------------------------------------------
// File summary
// ---------------------------------------------------------------------------

export interface FileSummary {
  count: number;
  minIso?: string;
  maxIso?: string;
}

/** Total item count and overall date span (ISO min/max) for the summary line. */
export function fileSummary(items: ReviewItem[]): FileSummary {
  let minIso: string | undefined;
  let maxIso: string | undefined;
  for (const item of items) {
    const iso = item.proposed.takenAt;
    if (!iso) continue;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) continue;
    if (minIso === undefined || t < Date.parse(minIso)) minIso = iso;
    if (maxIso === undefined || t > Date.parse(maxIso)) maxIso = iso;
  }
  return {
    count: items.length,
    ...(minIso !== undefined ? { minIso } : {}),
    ...(maxIso !== undefined ? { maxIso } : {}),
  };
}

/** The dated span of a batch in ms, or undefined when fewer than two items are dated. */
function datedSpanMs(items: ReviewItem[]): number | undefined {
  const { minIso, maxIso } = fileSummary(items);
  if (minIso === undefined || maxIso === undefined) return undefined;
  return Date.parse(maxIso) - Date.parse(minIso);
}

// ---------------------------------------------------------------------------
// Period presets & range
// ---------------------------------------------------------------------------

export type FilterPreset = 'all' | 'year' | 'month' | 'custom';

export interface FilterRange {
  fromIso?: string;
  toIso?: string;
}

/**
 * The date range for a preset relative to `nowIso`: "all" clears the range,
 * "year"/"month" set a lower bound one year / one month before now, "custom" is
 * driven by the view's own Od/Do inputs (undefined here). Month/year arithmetic
 * is calendar-based (`setMonth`/`setFullYear`).
 */
export function presetRange(preset: FilterPreset, nowIso: string): FilterRange | undefined {
  if (preset === 'all' || preset === 'custom') return undefined;
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) return undefined;
  const from = new Date(now);
  if (preset === 'year') from.setFullYear(from.getFullYear() - 1);
  else from.setMonth(from.getMonth() - 1);
  return { fromIso: from.toISOString() };
}

/**
 * The default preset for a batch: "all" (nothing silently narrowed), unless the
 * dated span is wider than {@link FILTER_PRESELECT_SPAN_MS} (~5 years) — a very
 * large history — in which case "last year" is pre-selected and its range
 * returned, and the view says so (doc §2).
 */
export function defaultRange(
  items: ReviewItem[],
  nowIso: string,
): { presetId: FilterPreset; range?: FilterRange } {
  const span = datedSpanMs(items);
  if (span !== undefined && span > FILTER_PRESELECT_SPAN_MS) {
    const range = presetRange('year', nowIso);
    return range ? { presetId: 'year', range } : { presetId: 'year' };
  }
  return { presetId: 'all' };
}

// ---------------------------------------------------------------------------
// Range membership
// ---------------------------------------------------------------------------

/** True when the range has neither a from nor a to bound (i.e. keeps everything). */
function rangeIsOpen(range?: FilterRange): boolean {
  return !range || (range.fromIso === undefined && range.toIso === undefined);
}

/** Inclusive lower bound (ms) for a from-date: start of that calendar day (UTC). */
function startOfDayMs(iso: string): number {
  return Date.parse(`${iso.slice(0, 10)}T00:00:00.000Z`);
}

/**
 * Whether an item's `takenAt` falls within `range` (day-inclusive on both bounds,
 * reusing the snapshot day-boundary helper for the upper bound). An item with NO
 * `takenAt` is kept when the range is open (default) and dropped once a range is
 * set — it cannot be placed in a period, and the CTA count reflects that live.
 */
export function itemInRange(item: ReviewItem, range?: FilterRange): boolean {
  if (rangeIsOpen(range)) return true;
  const iso = item.proposed.takenAt;
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  if (range?.fromIso !== undefined && t < startOfDayMs(range.fromIso)) return false;
  if (range?.toIso !== undefined && t > endOfDayMs(range.toIso)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Apply & live counts
// ---------------------------------------------------------------------------

export interface ApplyOptions {
  range?: FilterRange;
  selectedKeys: Set<string>;
}

/**
 * The narrowed batch: keep only items whose metric group is in `selectedKeys`
 * AND whose `takenAt` is inside `range` (see {@link itemInRange}). Item order is
 * preserved. This is exactly what the review screen receives on "Continue".
 */
export function applyImportFilter(items: ReviewItem[], opts: ApplyOptions): ReviewItem[] {
  return items.filter(
    (item) => opts.selectedKeys.has(groupKey(item)) && itemInRange(item, opts.range),
  );
}

/**
 * Per-group item count for the current period (ignoring selection) — the live
 * "{count} in period" each row shows; a group at 0 has its checkbox disabled in
 * the view. Every group present in the batch appears in the map (0 when the
 * period excludes all of its items).
 */
export function countsInPeriod(items: ReviewItem[], range?: FilterRange): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = groupKey(item);
    if (!counts.has(key)) counts.set(key, 0);
    if (itemInRange(item, range)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * The initial checked selection: every group by default. When `knownOnly` is on,
 * unresolved groups start UNCHECKED (visible but off, doc §4) rather than hidden,
 * mirroring the "known only" import switch without silently discarding anything.
 */
export function initialSelection(
  groups: MetricGroup[],
  opts?: { knownOnly?: boolean },
): Set<string> {
  const selected = new Set<string>();
  for (const g of groups) {
    if (opts?.knownOnly && g.unresolved) continue;
    selected.add(g.key);
  }
  return selected;
}
