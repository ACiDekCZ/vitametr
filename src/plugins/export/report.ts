/**
 * Report export plugin (phase 3, interop).
 *
 * Produces a SELF-CONTAINED, printable HTML document summarizing the selected
 * data: a "needs attention" list, then one table per category with each metric's
 * latest value + unit, its reference range and in/above/below-range state. The
 * data comes from the shared `buildReport()` model — the same one the on-screen
 * report uses — so the two stay consistent.
 *
 * Self-contained by construction: all CSS is inlined in a single `<style>`, there
 * are NO external references (no `<link>`, no remote fonts, no `src=`, no
 * `http(s)://` URLs), so it renders and prints with zero network access. An
 * `@media print` block sizes it for A4; the user opens the file and prints to PDF.
 *
 * Only descriptive, data-backed statements — never a diagnosis (spec §11). All
 * user/metric text is HTML-escaped. Honors `ExportSelection.metricIds` + `range`
 * by filtering the measurements before the model is built.
 */

import type { ExportContext, ExportPlugin, ExportSelection } from '../../core/contracts.js';
import type { MetricCategory } from '../../core/types.js';
import { en } from '../../i18n/en.js';
import { cs } from '../../i18n/cs.js';
import {
  ageMonths,
  buildReport,
  buildSnapshotReport,
  SNAPSHOT_AGE_DAYS,
  type AttentionItem,
  type ReportRow,
  type SnapshotReportRow,
} from '../../ui/views/report-model.js';
import { isSeededTag } from '../../core/tags.js';
import { profileDisplayName } from '../../ui/views/settings-model.js';
import { valueWithUnitText } from '../../ui/format-value.js';
import { selectMeasurements } from './json-backup.js';

const INTL_TAG: Record<'cs' | 'en', string> = { cs: 'cs-CZ', en: 'en-US' };

const CATEGORY_KEY: Record<MetricCategory, keyof typeof en> = {
  lab: 'report.category.lab',
  home: 'report.category.home',
  wearable: 'report.category.wearable',
  custom: 'report.category.custom',
};

const RANGE_KEY: Record<ReportRow['rangeState'], keyof typeof en | undefined> = {
  below: 'range.below',
  above: 'range.above',
  'in-range': 'range.within',
  unknown: undefined,
};

/** Escape the five HTML-significant characters so any text is inert markup. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const reportExportPlugin: ExportPlugin = {
  id: 'report',
  nameKey: 'export.report',
  fileExtension: 'html',

  async export(selection: ExportSelection, ctx: ExportContext): Promise<Blob> {
    const { locale } = ctx;
    const table = locale === 'cs' ? cs : en;
    const tag = INTL_TAG[locale];

    const t = (key: keyof typeof en, params?: Record<string, string | number>): string => {
      const raw = table[key] ?? String(key);
      return params
        ? raw.replace(/\{(\w+)\}/g, (m, name: string) =>
            name in params ? String(params[name]) : m,
          )
        : raw;
    };
    const num = (value: number): string => new Intl.NumberFormat(tag).format(value);
    const rawDate = (iso: string): string => {
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat(tag).format(d);
    };
    const date = (iso: string): string => esc(rawDate(iso));

    // A row shape shared by the range report (ReportRow) and the snapshot report
    // (SnapshotReportRow): just the cells the HTML table renders.
    type CellRow = {
      metricId: ReportRow['metricId'];
      nameKey?: string;
      customName?: string;
      value?: number;
      textValue?: string;
      operator?: ReportRow['operator'];
      unit: string;
      rangeState: ReportRow['rangeState'];
      refLow?: number;
      refHigh?: number;
    };

    const metricName = (r: { nameKey?: string; customName?: string }): string => {
      if (r.customName) return esc(r.customName);
      if (r.nameKey) return esc(t(r.nameKey as keyof typeof en));
      return '';
    };

    // Tags are on unless the profile explicitly disabled them.
    const withTags = ctx.data.settings?.useTags !== false;
    // Localized label for a seeded tag (`tag.<id>`); custom tags shown verbatim.
    const tagLabel = (tag: string): string =>
      isSeededTag(tag) ? t(('tag.' + tag) as keyof typeof en) : tag;
    // Inline chips after a metric name; empty string when off or untagged.
    const tagsHtml = (r: CellRow): string => {
      if (!withTags) return '';
      const tags = ctx.catalog.byId(r.metricId)?.tags ?? [];
      if (tags.length === 0) return '';
      const chips = tags
        .map((tag) => `<span class="tag">${esc(tagLabel(tag))}</span>`)
        .join('');
      return ` <span class="tags">${chips}</span>`;
    };

    const valueText = (r: CellRow): string => {
      if (r.value === undefined) return esc(r.textValue ?? '');
      const unit = ctx.units.getUnit(r.unit)?.display ?? r.unit;
      // Shared value+unit typography with <sup> powers (10⁹/l), the plugin's own
      // locale-pinned number formatter, and HTML escaping of literal parts.
      return valueWithUnitText({
        value: r.value,
        ...(unit ? { unit } : {}),
        ...(r.operator ? { operator: r.operator } : {}),
        markup: true,
        escape: esc,
        formatNumber: num,
      });
    };

    const referenceText = (r: CellRow): string => {
      const hasRange = r.refLow !== undefined || r.refHigh !== undefined;
      if (!hasRange) return '—';
      const low = r.refLow !== undefined ? num(r.refLow) : '';
      const high = r.refHigh !== undefined ? num(r.refHigh) : '';
      return `${low}–${high}`;
    };

    const stateBadge = (r: CellRow): string => {
      const key = RANGE_KEY[r.rangeState];
      if (!key || (r.rangeState !== 'above' && r.rangeState !== 'below')) return '';
      return ` <span class="badge ${r.rangeState}">${esc(t(key))}</span>`;
    };

    const attentionText = (item: AttentionItem): string => {
      if (item.reason === 'out-of-range') return esc(t('report.outOfRange'));
      if (item.reason === 'stale') return esc(t('report.stale', { days: item.days ?? 0 }));
      return esc(t('report.mixedUnits'));
    };

    const profileName = profileDisplayName(ctx.data.profile.name, t);
    const snapshot = selection.mode === 'snapshot' && !!selection.asOfIso;

    let heading: string;
    let bodyHtml: string;

    if (snapshot) {
      // Snapshot ("state as of date"): a single flat table (Metric | Value |
      // Reference | Measured | Source); age is relative to the as-of date.
      const asOfIso = selection.asOfIso as string;
      heading = t('report.snapshotTitle', { date: rawDate(asOfIso) });
      const snap = buildSnapshotReport(
        ctx.data,
        ctx.catalog,
        ctx.units,
        locale,
        asOfIso,
        selection.metricIds,
      );
      if (snap.totalMetrics === 0) {
        bodyHtml = `<p class="muted">${esc(t('report.empty'))}</p>`;
      } else {
        const head =
          `<tr><th>${esc(t('report.metric'))}</th>` +
          `<th>${esc(t('report.value'))}</th>` +
          `<th>${esc(t('report.reference'))}</th>` +
          `<th>${esc(t('report.measured'))}</th>` +
          `<th>${esc(t('report.source'))}</th></tr>`;
        const body = snap.rows
          .map((r: SnapshotReportRow) => {
            const outOfRange = r.rangeState === 'above' || r.rangeState === 'below';
            const age =
              r.ageDays >= SNAPSHOT_AGE_DAYS
                ? ` <span class="age">${esc(t('report.snapshotAge', { months: ageMonths(r.ageDays) }))}</span>`
                : '';
            const source = r.sourceName ? esc(r.sourceName) : '—';
            return (
              `<tr${outOfRange ? ' class="out-of-range"' : ''}>` +
              `<td>${metricName(r)}${tagsHtml(r)}</td>` +
              `<td class="num">${valueText(r)}</td>` +
              `<td>${referenceText(r)}${stateBadge(r)}</td>` +
              `<td>${date(r.measuredIso)}${age}</td>` +
              `<td>${source}</td></tr>`
            );
          })
          .join('');
        bodyHtml =
          `<section><table><thead>${head}</thead><tbody>${body}</tbody></table></section>`;
      }
    } else {
      heading = t('report.title');
      // Honor the selection by filtering the measurements before the model builds:
      // only selected metrics keep a series (so only they get a row), and range
      // trims each series to the window.
      const filtered = selectMeasurements(ctx.data.measurements, selection);
      // No clock in a plugin: fall back to the latest kept measurement so staleness
      // never falsely fires when the caller injects no `nowIso`.
      const nowIso =
        ctx.nowIso ??
        filtered.reduce((acc, m) => (m.takenAt > acc ? m.takenAt : acc), '0000');
      const model = buildReport(
        { ...ctx.data, measurements: filtered },
        ctx.catalog,
        ctx.units,
        locale,
        nowIso,
      );

      const parts: string[] = [];

      // Attention section (interpretation first), if any.
      if (model.attention.length > 0) {
        const items = model.attention
          .map((item) => `<li>${metricName(item)} — ${attentionText(item)}</li>`)
          .join('');
        parts.push(
          `<section class="attention"><h2>${esc(t('report.attention'))}</h2><ul>${items}</ul></section>`,
        );
      }

      // One table per category.
      for (const cat of model.categories) {
        const head =
          `<tr><th>${esc(t('report.metric'))}</th>` +
          `<th>${esc(t('report.latest'))}</th>` +
          `<th>${esc(t('report.reference'))}</th>` +
          `<th>${esc(t('report.measured'))}</th></tr>`;
        const body = cat.rows
          .map((r) => {
            const outOfRange = r.rangeState === 'above' || r.rangeState === 'below';
            return (
              `<tr${outOfRange ? ' class="out-of-range"' : ''}>` +
              `<td>${metricName(r)}${tagsHtml(r)}</td>` +
              `<td class="num">${valueText(r)}</td>` +
              `<td>${referenceText(r)}${stateBadge(r)}</td>` +
              `<td>${date(r.lastMeasuredIso)}</td></tr>`
            );
          })
          .join('');
        parts.push(
          `<section><h2>${esc(t(CATEGORY_KEY[cat.category]))}</h2>` +
            `<table><thead>${head}</thead><tbody>${body}</tbody></table></section>`,
        );
      }

      bodyHtml =
        model.totalMetrics === 0
          ? `<p class="muted">${esc(t('report.empty'))}</p>`
          : parts.join('');
    }

    const metaLine =
      `${esc(t('report.profile'))}: ${esc(profileName)}` +
      (ctx.nowIso ? ` · ${esc(t('report.generated', { date: '' })).trim()} ${date(ctx.nowIso)}` : '');

    const html = `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(heading)} — ${esc(profileName)}</title>
<style>
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { font-family: -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; color: #1a1a1a; background: #fff; margin: 0; padding: 24px; line-height: 1.5; }
.page { max-width: 800px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .04em; color: #555; margin: 28px 0 8px; }
.meta { color: #666; margin: 0 0 8px; font-size: 13px; }
.muted { color: #666; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #e2e2e2; vertical-align: top; }
th { font-weight: 600; color: #444; background: #f7f7f8; }
td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
tr.out-of-range td { background: #fdf3f2; }
.age { color: #888; font-size: 12px; white-space: nowrap; }
.tags { display: inline; }
.tag { display: inline-block; font-size: 11px; padding: 1px 7px; margin-left: 4px; border-radius: 999px; font-weight: 500; background: #eef0f2; color: #555; white-space: nowrap; }
.badge { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 999px; font-weight: 600; }
.badge.above { background: #f6d9d5; color: #8a2318; }
.badge.below { background: #d7e6f7; color: #1c4a78; }
.attention { border: 1px solid #f0d9d5; background: #fdf6f4; border-radius: 8px; padding: 4px 16px 12px; }
.attention ul { margin: 6px 0 0; padding-left: 18px; }
.attention li { margin: 3px 0; }
.disclaimer { margin-top: 32px; font-size: 12px; color: #777; border-top: 1px solid #e2e2e2; padding-top: 12px; }
@media print {
  @page { size: A4; margin: 16mm; }
  body { padding: 0; }
  h2 { break-after: avoid; }
  section, tr { break-inside: avoid; }
}
</style>
</head>
<body>
<main class="page">
<h1>${esc(heading)}</h1>
<p class="meta">${metaLine}</p>
${bodyHtml}
<p class="disclaimer">${esc(t('report.disclaimer'))}</p>
</main>
</body>
</html>`;

    return new Blob([html], { type: 'text/html;charset=utf-8' });
  },
};
