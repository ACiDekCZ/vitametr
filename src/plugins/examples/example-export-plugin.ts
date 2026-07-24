// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Milan Víšek

/**
 * EXAMPLE — a minimal `ExportPlugin` (teaching template).
 *
 * This file is MIT-licensed (the rest of the repository is MPL-2.0) and is NOT
 * registered in the running app — it exists only as a copy-and-adapt starting
 * point for plugin authors. See `PLUGINS.md` for the full developer contract.
 *
 * What it demonstrates
 * --------------------
 * The smallest possible exporter: it produces a tiny, human-readable text
 * summary of the selected measurements and returns it as a `Blob`. The two
 * things every exporter must get right are shown here:
 *
 * 1. **Honour the `ExportSelection`.** `metricIds` and `range` narrow what is
 *    exported, exactly like the real csv / json-backup plugins. This example
 *    reuses the very same shared filter (`selectMeasurements`) so its behaviour
 *    can never drift from theirs.
 * 2. **Read only from `ExportContext`** — `data`, `catalog`, `units`, `locale`
 *    (and the injected `nowIso` when a plugin needs "now"). A plugin never
 *    reaches for storage or the wall clock itself.
 *
 * `fileExtension` names the file the UI offers to save. The output here is
 * intentionally lossy and display-oriented (like csv) — for a lossless backup
 * see `export/json-backup.ts` instead.
 */

import type { ExportContext, ExportPlugin, ExportSelection } from '../../core/contracts.js';
import type { Measurement } from '../../core/types.js';
import { selectMeasurements } from '../export/json-backup.js';

/** A measurement's value as a short string (numeric or qualitative). */
function valueText(m: Measurement): string {
  if (m.value !== undefined) {
    const op = m.operator ? `${m.operator} ` : '';
    const unit = m.unit ? ` ${m.unit}` : '';
    return `${op}${m.value}${unit}`;
  }
  if (m.textValue !== undefined) return m.textValue;
  if (m.textValues !== undefined) return m.textValues.join(', ');
  return '';
}

/** A metric's display name, resolved through the catalog for the UI locale. */
function metricName(m: Measurement, ctx: ExportContext): string {
  const metric = ctx.catalog.byId(m.metricId);
  // A real plugin would translate `nameKey` via the i18n tables (see csv.ts);
  // for a self-contained example we fall back to the stable key / id.
  return metric?.customName ?? metric?.key ?? m.metricId;
}

export const exampleExportPlugin: ExportPlugin = {
  id: 'example-summary',
  // A real plugin points this at an i18n key that exists in `src/i18n/`.
  nameKey: 'example.export.name',
  fileExtension: 'txt',

  async export(selection: ExportSelection, ctx: ExportContext): Promise<Blob> {
    // The one line that makes the selection matter: the same metric/range
    // filter the built-in exporters use.
    const rows = selectMeasurements(ctx.data.measurements, selection);

    const header = `Vitametr summary — ${ctx.data.profile.name}` +
      (ctx.nowIso ? ` (as of ${ctx.nowIso})` : '');

    const lines = [
      header,
      '='.repeat(header.length),
      `${rows.length} measurement(s)`,
      '',
      ...rows.map((m) => `${m.takenAt}  ${metricName(m, ctx)}: ${valueText(m)}`),
    ];

    return new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  },
};
