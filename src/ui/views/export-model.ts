/**
 * Export wizard (phase 3) — DOM-free view model.
 *
 * Pure pieces the export view builds on, kept here so they can be unit-tested
 * without a DOM: the interop format tiles, the period presets and their
 * period→range mapping, the selectable-metric list, the metric search predicate,
 * the ExportSelection builder and the download filename. No DOM, no i18n, no
 * clock — the caller injects "now" as an ISO string and translates the returned
 * keys itself.
 *
 * The period→range logic and the "metrics that have data" listing are shared with
 * the Compare screen (`compare-model.ts`) and re-used here rather than duplicated.
 */

import type { Catalog, ExportSelection } from '../../core/contracts';
import type { Measurement, MetricId } from '../../core/types';
import type { StringKey } from '../../i18n/index';
import {
  metricsWithData,
  periodRange,
  type ComparePeriod,
  type CompareRange,
} from './compare-model';

// ---------------------------------------------------------------------------
// Formats (interop only — the JSON backup stays the separate Backup action)
// ---------------------------------------------------------------------------

/** The interop export formats offered as tiles, in display order. */
export type ExportFormatId = 'csv' | 'fhir' | 'report';

export interface ExportFormatTile {
  id: ExportFormatId;
  /** Registered export-plugin id to run (matches {@link ExportFormatId} here). */
  pluginId: string;
  /** Short acronym shown in the tile (a format label, not prose). */
  tag: string;
  nameKey: StringKey;
  descKey: StringKey;
  /** File extension of the produced blob (for the download filename). */
  extension: string;
}

/**
 * Interop formats only — `json-backup` is deliberately excluded (it is the
 * separate "Backup" action in Settings, always full and optionally encrypted).
 */
export const EXPORT_FORMATS: readonly ExportFormatTile[] = [
  {
    id: 'csv',
    pluginId: 'csv',
    tag: 'CSV',
    nameKey: 'export.format.csv.name',
    descKey: 'export.format.csv.desc',
    extension: 'csv',
  },
  {
    id: 'fhir',
    pluginId: 'fhir',
    tag: 'FHIR',
    nameKey: 'export.format.fhir.name',
    descKey: 'export.format.fhir.desc',
    extension: 'json',
  },
  {
    id: 'report',
    pluginId: 'report',
    tag: 'HTML',
    nameKey: 'export.format.report.name',
    descKey: 'export.format.report.desc',
    extension: 'html',
  },
] as const;

/** The plugin ids that are "interop" (offered by the wizard), as a set. */
export const INTEROP_PLUGIN_IDS: readonly string[] = EXPORT_FORMATS.map((f) => f.pluginId);

export function isInteropFormat(pluginId: string): boolean {
  return INTEROP_PLUGIN_IDS.includes(pluginId);
}

export function formatById(id: string): ExportFormatTile | undefined {
  return EXPORT_FORMATS.find((f) => f.id === id);
}

// ---------------------------------------------------------------------------
// Period presets
// ---------------------------------------------------------------------------

/** Period presets, mirroring the metric-detail / compare screens. */
export type ExportPeriod = ComparePeriod;

export interface ExportPeriodOption {
  id: ExportPeriod;
  labelKey: StringKey;
}

/** The segmented period control's options, in display order. */
export function periodOptions(): ExportPeriodOption[] {
  return [
    { id: '3m', labelKey: 'metric.detail.period3m' },
    { id: 'year', labelKey: 'metric.detail.periodYear' },
    { id: '5y', labelKey: 'metric.detail.period5y' },
    { id: 'all', labelKey: 'metric.detail.periodAll' },
  ];
}

/** The `from`/`to` range for a period (only a lower bound is ever set). */
export function periodToRange(period: ExportPeriod, nowIso: string): CompareRange {
  return periodRange(period, nowIso);
}

// ---------------------------------------------------------------------------
// Metric selection
// ---------------------------------------------------------------------------

/** One selectable metric in the checklist (only metrics that have data). */
export interface ExportMetricItem {
  metricId: MetricId;
  nameKey?: string;
  customName?: string;
  /** The metric's tags, for the tag filter (empty when untagged). */
  tags: string[];
  /** How many measurements the metric has (all-time). */
  count: number;
}

/**
 * Metrics that have at least one measurement, as checklist items sorted by a
 * stable display key (custom name / name key / id). These are the only metrics
 * worth exporting — a metric with no data would produce nothing.
 */
export function buildMetricItems(
  measurements: Measurement[],
  catalog: Catalog,
): ExportMetricItem[] {
  const counts = new Map<MetricId, number>();
  for (const m of measurements) counts.set(m.metricId, (counts.get(m.metricId) ?? 0) + 1);

  return metricsWithData(measurements, catalog)
    .map((metric) => ({
      metricId: metric.id,
      nameKey: metric.nameKey,
      customName: metric.customName,
      tags: metric.tags ?? [],
      count: counts.get(metric.id) ?? 0,
    }))
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
}

function sortKey(item: ExportMetricItem): string {
  return item.customName ?? item.nameKey ?? String(item.metricId);
}

/**
 * Case- and diacritics-insensitive substring match of a metric's resolved
 * display `name` against a search `query`. An empty/blank query matches all.
 */
export function metricMatchesQuery(name: string, query: string): boolean {
  const q = fold(query);
  if (q === '') return true;
  return fold(name).includes(q);
}

function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

// ---------------------------------------------------------------------------
// Selection + filename
// ---------------------------------------------------------------------------

/** The two export selection strategies offered by the wizard. */
export type ExportMode = 'range' | 'snapshot';

/** The calendar day (YYYY-MM-DD) of an ISO instant, or '' when unparseable. */
export function isoDay(iso?: string): string {
  return iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : '';
}

/**
 * Build the ExportSelection from the chosen metric ids and either a period
 * (range mode) or an as-of date (snapshot mode). The selected metric ids are
 * always passed explicitly. Range mode adds a `from` bound (the "all" period
 * omits it, exporting the whole history); snapshot mode carries `asOfIso` (the
 * reference date, defaulting to the injected `nowIso`'s day). Export is plain —
 * no password (encryption is Backup's job).
 */
export function buildExportSelection(
  selectedMetricIds: readonly MetricId[],
  period: ExportPeriod,
  nowIso: string,
  opts?: { mode?: ExportMode; asOfIso?: string },
): ExportSelection {
  const selection: ExportSelection = { metricIds: [...selectedMetricIds] };
  if (opts?.mode === 'snapshot') {
    selection.mode = 'snapshot';
    selection.asOfIso = isoDay(opts.asOfIso) || isoDay(nowIso) || nowIso;
    return selection;
  }
  const range = periodToRange(period, nowIso);
  if (range) selection.range = range;
  return selection;
}

/** True when at least one metric is selected (the Export action's guard). */
export function canExport(selectedMetricIds: readonly MetricId[]): boolean {
  return selectedMetricIds.length > 0;
}

/**
 * A dated base filename (no extension), e.g. `vitametr-export-2026-07-23`.
 * The date is the calendar day of the injected `nowIso` (no clock read here);
 * when it is absent or unparseable the date segment is dropped. Shared by both
 * the data-export wizard and the metric-pack export dialog, which pre-fill an
 * editable filename input with the returned value.
 */
export function buildExportBaseName(nowIso?: string): string {
  return datedBaseName('vitametr-export', nowIso);
}

/** A dated base filename for a metric-pack export, e.g. `vitametr-pack-2026-07-23`. */
export function buildPackBaseName(nowIso?: string): string {
  return datedBaseName('vitametr-pack', nowIso);
}

/**
 * A dated base filename for a snapshot ("as of date") export, e.g.
 * `vitametr-stav-2026-07-23`. The date is the as-of day (already a calendar
 * date); when it is absent or unparseable the date segment is dropped.
 */
export function buildSnapshotBaseName(asOfIso?: string): string {
  return datedBaseName('vitametr-stav', asOfIso);
}

function datedBaseName(prefix: string, nowIso?: string): string {
  const day = nowIso && /^\d{4}-\d{2}-\d{2}/.test(nowIso) ? nowIso.slice(0, 10) : '';
  return day ? `${prefix}-${day}` : prefix;
}

/**
 * Download filename for a wizard export, e.g. `vitametr-export-2026-07-23.csv`.
 * The date is the calendar day of the injected `nowIso` (no clock read here);
 * when it is absent or unparseable the date segment is dropped.
 */
export function buildExportFilename(extension: string, nowIso?: string): string {
  return applyExtension(buildExportBaseName(nowIso), extension);
}

/**
 * Sanitize a user-typed filename into a safe base name (the extension is added
 * separately by {@link applyExtension}). Strips path separators and control
 * characters, then any leading dots (so no hidden files / `..` traversal), and
 * trims surrounding whitespace. Falls back to `fallback` when nothing usable
 * remains. Pure — no clock, no DOM.
 */
export function sanitizeFilename(input: string, fallback: string): string {
  const cleaned = input
    .replace(/[/\\]/g, '') // path separators
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '') // control chars
    .trim()
    .replace(/^\.+/, '') // leading dots (hidden files / traversal)
    .trim();
  return cleaned === '' ? fallback : cleaned;
}

/**
 * Append `.<extension>` to a base name unless it already ends with it
 * (case-insensitive), so a user who typed the extension does not get it twice.
 */
export function applyExtension(name: string, extension: string): string {
  const suffix = `.${extension}`;
  return name.toLowerCase().endsWith(suffix.toLowerCase()) ? name : `${name}${suffix}`;
}
