/**
 * CSV export plugin (step K7).
 *
 * A tabular export for spreadsheets and doctors (design doc §5.2). Not a backup
 * format — it is lossy by design (display-oriented). Columns:
 *
 *   metric ; value ; unit ; operator ; takenAt ; refLow ; refHigh ; source ; note [; tags]
 *
 * The trailing `tags` column is appended only when tags are enabled
 * (`settings.useTags !== false`); it lists the metric's raw tag ids joined by a
 * single space (a space never collides with the ';'/',' delimiter, so the cell
 * needs no quoting). Existing columns are never reordered, keeping the format
 * stable. The CSV import maps known columns only, so this extra column is
 * ignored on round-trip — importing an exported file stays safe.
 *
 * Details:
 * - UTF-8 with a BOM so Excel opens accented text correctly.
 * - Delimiter: ';' for Czech (Excel-CZ uses ';' because ',' is the decimal mark),
 *   ',' otherwise — chosen from `ctx.locale`.
 * - Numbers: decimal comma for 'cs', decimal point otherwise; no thousands
 *   grouping (grouping would collide with the delimiter).
 * - Fields containing the delimiter, a quote or a newline are quoted per RFC 4180
 *   (wrapped in double quotes, inner quotes doubled).
 * - Metric name: resolved through the catalog + the locale string table. Built-in
 *   metrics use their translated `nameKey`; user metrics use `customName`. Honors
 *   `ExportSelection` (same metric/range filter as the JSON backup).
 */

import type { ExportContext, ExportPlugin, ExportSelection } from '../../core/contracts.js';
import type { Measurement, Metric } from '../../core/types.js';
import { en } from '../../i18n/en.js';
import { cs } from '../../i18n/cs.js';
import { selectMeasurements } from './json-backup.js';

const HEADERS = [
  'metric',
  'value',
  'unit',
  'operator',
  'takenAt',
  'refLow',
  'refHigh',
  'source',
  'note',
] as const;

/** Machine header (a field id, like the others) for the appended tags column. */
const TAGS_HEADER = 'tags';

/** Human-readable metric name for the given locale. */
function metricName(metric: Metric | undefined, locale: 'cs' | 'en'): string {
  if (!metric) return '';
  if (metric.customName) return metric.customName;
  if (metric.nameKey) {
    const table = locale === 'cs' ? cs : en;
    return table[metric.nameKey as keyof typeof en] ?? metric.nameKey;
  }
  return metric.key ?? metric.id;
}

/** Format a number with the locale decimal mark and no grouping. */
function formatNumber(value: number, locale: 'cs' | 'en'): string {
  const s = String(value);
  return locale === 'cs' ? s.replace('.', ',') : s;
}

/** Quote a field per RFC 4180 when it contains the delimiter, a quote or newline. */
function csvField(value: string, delimiter: string): string {
  if (value.includes(delimiter) || value.includes('"') || /[\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function rowFor(
  m: Measurement,
  ctx: ExportContext,
  delimiter: string,
  withTags: boolean,
): string {
  const metric = ctx.catalog.byId(m.metricId);
  const sourceName = m.sourceId
    ? (ctx.data.sources.find((s) => s.id === m.sourceId)?.name ?? '')
    : '';

  const cells = [
    metricName(metric, ctx.locale),
    m.value !== undefined ? formatNumber(m.value, ctx.locale) : (m.textValue ?? ''),
    m.unit,
    m.operator ?? '',
    m.takenAt,
    m.refLow !== undefined ? formatNumber(m.refLow, ctx.locale) : '',
    m.refHigh !== undefined ? formatNumber(m.refHigh, ctx.locale) : '',
    sourceName,
    m.note ?? '',
  ];

  // Raw tag ids joined by a space (empty for untagged metrics); appended last.
  if (withTags) cells.push((metric?.tags ?? []).join(' '));

  return cells.map((c) => csvField(c, delimiter)).join(delimiter);
}

export const csvExportPlugin: ExportPlugin = {
  id: 'csv',
  nameKey: 'export.csv',
  fileExtension: 'csv',

  async export(selection: ExportSelection, ctx: ExportContext): Promise<Blob> {
    const delimiter = ctx.locale === 'cs' ? ';' : ',';
    // Tags are on unless the profile explicitly disabled them.
    const withTags = ctx.data.settings?.useTags !== false;
    const rows = selectMeasurements(ctx.data.measurements, selection);

    const headers = withTags ? [...HEADERS, TAGS_HEADER] : [...HEADERS];
    const lines: string[] = [];
    // Snapshot mode: a leading comment records the reference date (ISO). The rows
    // are already one-per-metric (the shared resolver yields that); columns are
    // unchanged, so a spreadsheet import still finds the header on the next line.
    if (selection.mode === 'snapshot' && selection.asOfIso) {
      lines.push(`# stav k ${selection.asOfIso.slice(0, 10)}`);
    }
    lines.push(
      headers.map((h) => csvField(h, delimiter)).join(delimiter),
      ...rows.map((m) => rowFor(m, ctx, delimiter, withTags)),
    );

    // CRLF line endings + UTF-8 BOM: the combination Excel is happiest with.
    const body = lines.join('\r\n');
    const bom = '﻿';
    return new Blob([bom + body], { type: 'text/csv;charset=utf-8' });
  },
};
