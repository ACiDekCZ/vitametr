/**
 * Health summary report model (pure, DOM- and i18n-free).
 *
 * Turns the whole profile into a structured, display-first summary: per-category
 * rows (latest value in the display unit, reference position, change, long-term
 * trend, how recently measured, record count) plus an "attention" list. All
 * statements are DESCRIPTIVE and data-backed only — never diagnostic (spec §11).
 * The view translates the returned keys/values.
 */

import type { Catalog, UnitsEngine } from '../../core/contracts';
import type {
  Measurement,
  Metric,
  MetricCategory,
  MetricId,
  Operator,
  ProfileData,
} from '../../core/types';
import type { Locale } from '../../i18n/index';
import {
  ageDays,
  delta,
  latest,
  measurementText,
  mixedUnits,
  previous,
  rangePosition,
  seriesFor,
  trend,
} from '../../core/series';
import { snapshotMeasurements } from '../../core/snapshot';
import { resolveDisplayUnit } from './overview-model';

/** A value not measured for at least this long is flagged for attention. */
export const STALE_DAYS = 365;

/** A snapshot value at least this old (relative to the as-of date) shows an age note. */
export const SNAPSHOT_AGE_DAYS = 365;

/** Whole months (approx.) for an age in days — used only for the descriptive age note. */
export function ageMonths(days: number): number {
  return Math.floor(days / 30);
}

export type RangeState = 'below' | 'in-range' | 'above' | 'unknown';
export type DeltaKind = 'up' | 'down' | 'same' | 'na';

export interface ReportRow {
  metricId: MetricId;
  nameKey?: string;
  customName?: string;
  category: MetricCategory;
  /** Latest value converted into the display unit (or its own unit if not convertible). */
  value?: number;
  /** Qualitative value (e.g. "negativní") for a text metric. */
  textValue?: string;
  operator?: Operator;
  unit: string;
  rangeState: RangeState;
  refLow?: number;
  refHigh?: number;
  deltaKind: DeltaKind;
  /** Absolute change in the display unit (present only when deltaKind is up/down). */
  deltaAmount?: number;
  deltaPercent?: number;
  trend: 'rising' | 'falling' | 'fluctuating' | 'flat' | 'insufficient';
  lastMeasuredIso: string;
  ageDays: number;
  mixedUnits: boolean;
  count: number;
}

export interface ReportCategory {
  category: MetricCategory;
  rows: ReportRow[];
}

export type AttentionReason = 'out-of-range' | 'stale' | 'mixed-units';

export interface AttentionItem {
  metricId: MetricId;
  nameKey?: string;
  customName?: string;
  reason: AttentionReason;
  /** For 'stale': how many days since the last measurement. */
  days?: number;
}

export interface ReportModel {
  categories: ReportCategory[];
  attention: AttentionItem[];
  totalMetrics: number;
  totalRecords: number;
}

const CATEGORY_ORDER: readonly MetricCategory[] = ['lab', 'home', 'wearable', 'custom'];

function nameOf(metric: Metric): Pick<ReportRow, 'nameKey' | 'customName'> {
  return { nameKey: metric.nameKey, customName: metric.customName };
}

function buildRow(
  metric: Metric,
  measurements: Measurement[],
  units: UnitsEngine,
  displayUnit: string,
  nowIso: string,
): ReportRow | undefined {
  const series = seriesFor(measurements, metric.id);
  const last = latest(series);
  if (!last) return undefined;

  // A text (qualitative) metric: a minimal row — string value, no unit, range,
  // delta or trend.
  if (last.value === undefined) {
    return {
      metricId: metric.id,
      ...nameOf(metric),
      category: metric.category,
      textValue: measurementText(last),
      unit: '',
      rangeState: 'unknown',
      deltaKind: 'na',
      trend: 'insufficient',
      lastMeasuredIso: last.takenAt,
      ageDays: ageDays(last, nowIso),
      mixedUnits: false,
      count: series.length,
    };
  }

  // Convert the latest value + its reference range into the display unit;
  // fall back to the measurement's own unit if not convertible.
  const converted = units.convertMeasurement(last, displayUnit, metric);
  const unit = converted ? displayUnit : last.unit;
  const valueRaw = converted ? converted.value : last.value;
  const value = units.round(valueRaw, unit, metric);
  const refLow = converted ? converted.refLow : last.refLow;
  const refHigh = converted ? converted.refHigh : last.refHigh;

  // Change vs previous, in the SAME (display) unit as the shown value so they
  // are consistent. `delta` decides availability (operator/insufficient/not
  // convertible); the magnitude is recomputed from the display-unit endpoints.
  const d = delta(series, units, metric);
  let deltaKind: DeltaKind = 'na';
  let deltaAmount: number | undefined;
  let deltaPercent: number | undefined;
  if (d.ok) {
    const prev = previous(series);
    const prevConv = prev ? units.convertMeasurement(prev, unit, metric) : undefined;
    const prevRaw = prevConv ? prevConv.value : (prev?.value ?? valueRaw);
    const diff = valueRaw - prevRaw;
    deltaAmount = Math.abs(diff);
    deltaPercent = d.percent;
    deltaKind = diff > 0 ? 'up' : diff < 0 ? 'down' : 'same';
  }

  return {
    metricId: metric.id,
    ...nameOf(metric),
    category: metric.category,
    value,
    operator: last.operator,
    unit,
    rangeState: rangePosition(last),
    refLow,
    refHigh,
    deltaKind,
    deltaAmount,
    deltaPercent,
    trend: trend(series, units, metric),
    lastMeasuredIso: last.takenAt,
    ageDays: ageDays(last, nowIso),
    mixedUnits: mixedUnits(series),
    count: series.length,
  };
}

/**
 * Build the full report. `nowIso` is supplied by the caller (no clock here).
 */
export function buildReport(
  data: ProfileData,
  catalog: Catalog,
  units: UnitsEngine,
  locale: Locale,
  nowIso: string,
  metricIds?: readonly MetricId[],
): ReportModel {
  const only = metricIds ? new Set<MetricId>(metricIds) : undefined;
  const rows: ReportRow[] = [];
  for (const metric of catalog.all()) {
    if (metric.hidden) continue;
    if (only && !only.has(metric.id)) continue;
    const displayUnit = resolveDisplayUnit(metric, data.settings, locale);
    const row = buildRow(metric, data.measurements, units, displayUnit, nowIso);
    if (row) rows.push(row);
  }

  const categories: ReportCategory[] = CATEGORY_ORDER.map((category) => ({
    category,
    rows: rows
      .filter((r) => r.category === category)
      .sort((a, b) => sortName(a).localeCompare(sortName(b))),
  })).filter((c) => c.rows.length > 0);

  const attention: AttentionItem[] = [];
  for (const r of rows) {
    if (r.rangeState === 'above' || r.rangeState === 'below') {
      attention.push({ metricId: r.metricId, nameKey: r.nameKey, customName: r.customName, reason: 'out-of-range' });
    }
    if (r.ageDays >= STALE_DAYS) {
      attention.push({ metricId: r.metricId, nameKey: r.nameKey, customName: r.customName, reason: 'stale', days: r.ageDays });
    }
    if (r.mixedUnits) {
      attention.push({ metricId: r.metricId, nameKey: r.nameKey, customName: r.customName, reason: 'mixed-units' });
    }
  }

  return {
    categories,
    attention,
    totalMetrics: rows.length,
    totalRecords: rows.reduce((sum, r) => sum + r.count, 0),
  };
}

/** A stable string for alphabetical sorting (key or custom name). */
function sortName(r: ReportRow): string {
  return r.customName ?? r.nameKey ?? String(r.metricId);
}

/**
 * Compose a report title from its base (the mode's own title, e.g. the snapshot
 * "State as of {date}") and an optional subset label, joined with an em dash:
 * `State as of 1/1/2025 — Lipids`. Without a label the base is returned
 * unchanged. Pure — the caller supplies already-translated strings.
 */
export function composeReportTitle(base: string, label?: string): string {
  return label ? `${base} — ${label}` : base;
}

// ---------------------------------------------------------------------------
// Snapshot ("as of date") report
// ---------------------------------------------------------------------------

/** One row of the snapshot report: a metric's latest value at/before the date. */
export interface SnapshotReportRow {
  metricId: MetricId;
  nameKey?: string;
  customName?: string;
  category: MetricCategory;
  /** Latest value converted into the display unit (or its own unit if not convertible). */
  value?: number;
  /** Qualitative value for a text metric. */
  textValue?: string;
  operator?: Operator;
  unit: string;
  rangeState: RangeState;
  refLow?: number;
  refHigh?: number;
  /** When the value was measured (ISO). */
  measuredIso: string;
  /** Whole days between the measurement and the as-of date. */
  ageDays: number;
  /** Source (device / lab) display name, if any. */
  sourceName?: string;
}

export interface SnapshotReportModel {
  rows: SnapshotReportRow[];
  /** The reference date the snapshot was resolved to (ISO). */
  asOfIso: string;
  totalMetrics: number;
}

/**
 * Build the "state as of date" report: for each metric (optionally restricted to
 * `metricIds`), its single latest measurement at or before `asOfIso` (the shared
 * {@link snapshotMeasurements} resolver), converted into the display unit. Age is
 * computed relative to the as-of date, not to today. Rows are sorted by display
 * name. Pure — no DOM, no clock (the caller supplies the reference date).
 */
export function buildSnapshotReport(
  data: ProfileData,
  catalog: Catalog,
  units: UnitsEngine,
  locale: Locale,
  asOfIso: string,
  metricIds?: MetricId[],
): SnapshotReportModel {
  const snapshot = snapshotMeasurements(data.measurements, metricIds, asOfIso);
  const rows: SnapshotReportRow[] = [];

  for (const m of snapshot) {
    const metric = catalog.byId(m.metricId);
    if (!metric || metric.hidden) continue;

    const sourceName = m.sourceId
      ? data.sources.find((s) => s.id === m.sourceId)?.name
      : undefined;
    const nameFields = { nameKey: metric.nameKey, customName: metric.customName };

    // Text (qualitative) metric — minimal row.
    if (m.value === undefined) {
      rows.push({
        metricId: metric.id,
        ...nameFields,
        category: metric.category,
        textValue: measurementText(m),
        unit: '',
        rangeState: 'unknown',
        measuredIso: m.takenAt,
        ageDays: ageDays(m, asOfIso),
        sourceName,
      });
      continue;
    }

    const displayUnit = resolveDisplayUnit(metric, data.settings, locale);
    const converted = units.convertMeasurement(m, displayUnit, metric);
    const unit = converted ? displayUnit : m.unit;
    const value = units.round(converted ? converted.value : m.value, unit, metric);
    const refLow = converted ? converted.refLow : m.refLow;
    const refHigh = converted ? converted.refHigh : m.refHigh;

    rows.push({
      metricId: metric.id,
      ...nameFields,
      category: metric.category,
      value,
      operator: m.operator,
      unit,
      rangeState: rangePosition(m),
      refLow,
      refHigh,
      measuredIso: m.takenAt,
      ageDays: ageDays(m, asOfIso),
      sourceName,
    });
  }

  rows.sort((a, b) => snapshotSortName(a).localeCompare(snapshotSortName(b)));
  return { rows, asOfIso, totalMetrics: rows.length };
}

function snapshotSortName(r: SnapshotReportRow): string {
  return r.customName ?? r.nameKey ?? String(r.metricId);
}
