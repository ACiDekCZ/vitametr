/**
 * Timeline view model (K8f) — DOM-free.
 *
 * Turns a flat measurement list into a reverse-chronological list of event
 * groups, applying the timeline filters and resolving each measurement's
 * metric to its display name (i18n key or free-text custom name) and category.
 *
 * Ordering, grouping and the composite key are delegated to
 * `series.groupByEvent`, so this module never invents its own event identity.
 * It is pure: no clock, no DOM, no storage — everything derives from its args.
 */

import type { Catalog } from '../../core/contracts';
import { groupByEvent, measurementText, rangePosition } from '../../core/series';
import type {
  Measurement,
  MeasurementId,
  MetricCategory,
  MetricId,
  Operator,
  SourceId,
  TimePrecision,
} from '../../core/types';

/** Filter selection; an undefined field means "no filter on that axis". */
export interface TimelineFilters {
  /** Keep only measurements whose resolved metric has this category. */
  category?: MetricCategory;
  /** Keep only measurements attributed to this source. */
  sourceId?: SourceId;
}

/** A single value inside an event group. */
export interface TimelineValueModel {
  measurementId: MeasurementId;
  metricId: MetricId;
  /** i18n string key for a built-in metric name (exclusive with customName). */
  nameKey?: string;
  /** Free-text name for a user-defined metric (exclusive with nameKey). */
  customName?: string;
  category: MetricCategory;
  /** Numeric value; absent for a text (qualitative) result. */
  value?: number;
  /** Qualitative value (e.g. "negativní") for a text result. */
  textValue?: string;
  /** Present for censored results such as `< 0.1`. */
  operator?: Operator;
  /** UCUM code the value was measured in (shown as-is; no conversion). */
  unit: string;
  refLow?: number;
  refHigh?: number;
  /** Position of the value within its own stated reference range. */
  range: 'below' | 'in-range' | 'above' | 'unknown';
}

/** One dated event: a lab draw or a home session from a single source. */
export interface TimelineGroupModel {
  /** Stable composite key from groupByEvent (`${takenAt}|${sourceId ?? ''}`). */
  key: string;
  takenAt: string;
  /** Finest precision present among the group's items (datetime wins). */
  timePrecision: TimePrecision;
  sourceId?: SourceId;
  values: TimelineValueModel[];
}

/**
 * Build the reverse-chronological timeline.
 *
 * Filters are applied to individual measurements first, so grouping and the
 * descending order from `groupByEvent` fall out unchanged and empty events
 * simply disappear. A measurement whose metric is unknown to the catalog is
 * dropped only when a category filter is active (its category is unknowable).
 */
export function buildTimeline(
  measurements: Measurement[],
  catalog: Catalog,
  filters: TimelineFilters = {},
): TimelineGroupModel[] {
  const kept = measurements.filter((m) => {
    if (filters.sourceId !== undefined && m.sourceId !== filters.sourceId) return false;
    if (filters.category !== undefined) {
      const metric = catalog.byId(m.metricId);
      if (metric === undefined || metric.category !== filters.category) return false;
    }
    return true;
  });

  return groupByEvent(kept).map((group) => ({
    key: group.key,
    takenAt: group.takenAt,
    timePrecision: group.items.some((m) => m.timePrecision === 'datetime') ? 'datetime' : 'date',
    sourceId: group.sourceId,
    values: group.items.map((m) => toValueModel(m, catalog)),
  }));
}

/** Categories actually present in the given measurements, in catalog order. */
export function presentCategories(
  measurements: Measurement[],
  catalog: Catalog,
): MetricCategory[] {
  const seen = new Set<MetricCategory>();
  for (const m of measurements) {
    const metric = catalog.byId(m.metricId);
    if (metric) seen.add(metric.category);
  }
  const order: MetricCategory[] = ['lab', 'home', 'wearable', 'custom'];
  return order.filter((c) => seen.has(c));
}

/**
 * Reassign the source of every measurement in a timeline group (a batch),
 * leaving all others untouched. `sourceId === undefined` clears the attribution
 * ("None"). Pure: returns a new array with the affected measurements copied and
 * their `sourceId` replaced; the caller stores the result inside `ctx.mutate`.
 */
export function applySourceToGroup(
  measurements: Measurement[],
  memberIds: readonly MeasurementId[],
  sourceId: SourceId | undefined,
): Measurement[] {
  const members = new Set<MeasurementId>(memberIds);
  return measurements.map((m) => (members.has(m.id) ? { ...m, sourceId } : m));
}

/** Source ids actually referenced by the given measurements (first-seen order). */
export function presentSourceIds(measurements: Measurement[]): SourceId[] {
  const seen = new Set<SourceId>();
  const out: SourceId[] = [];
  for (const m of measurements) {
    if (m.sourceId !== undefined && !seen.has(m.sourceId)) {
      seen.add(m.sourceId);
      out.push(m.sourceId);
    }
  }
  return out;
}

function toValueModel(m: Measurement, catalog: Catalog): TimelineValueModel {
  const metric = catalog.byId(m.metricId);
  return {
    measurementId: m.id,
    metricId: m.metricId,
    nameKey: metric?.nameKey,
    customName: metric?.customName,
    // 'custom' is the safe fallback for an unknown metric: it never asserts a
    // clinical category the catalog does not actually claim.
    category: metric?.category ?? 'custom',
    value: m.value,
    textValue: measurementText(m),
    operator: m.operator,
    unit: m.unit,
    refLow: m.refLow,
    refHigh: m.refHigh,
    range: rangePosition(m),
  };
}
