/**
 * Catalog tools — shared between the Settings screen (transitional) and the
 * Metrics ("Veličiny") page (redesign IA, screen 2).
 *
 * These builders render the "Metrics & units" toolbox: a selective metric
 * checklist (with a tag-filter chip row) that exports the chosen metrics as a
 * self-contained, re-importable pack. The pack always carries the custom unit
 * definitions it needs; tags and external codes are opt-in toggles; the download
 * name is editable. The checklist is export-only; removing a single metric lives
 * in its detail on the Metrics page (guarded by usage), and turning off a bundled
 * pack (which tidies its unused metrics) lives in the pack manager above. All
 * user text goes through `ctx.t`.
 */

import type { AppContext } from '../app-context';
import type { ExternalCodes, Metric, MetricId, UnitDef } from '../../core/types';
import type { StringKey } from '../../i18n/index';
import { UNITS } from '../../core/units-data';
import { tagLabel, usedTags } from '../../core/tags';
import { tagChip } from '../components/tag-chip';
import {
  applyExtension,
  buildPackBaseName,
  sanitizeFilename,
} from './export-model';
import {
  PACK_FORMAT,
  PACK_VERSION,
  type PackMetricDef,
  type VitametrPack,
} from '../../plugins/import/pack';

/** Built-in unit codes — anything else in the engine is a custom (pack/user) unit. */
const BUILTIN_UNIT_CODES = new Set<string>(UNITS.map((u) => u.code));

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function textEl(tag: string, text: string, className?: string): HTMLElement {
  const node = el(tag, className);
  node.textContent = text;
  return node;
}

function button(label: string, className?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (className) b.className = className;
  return b;
}

function section(titleKey: StringKey, t: AppContext['t']): HTMLElement {
  const s = el('section', 'settings-section card');
  s.append(textEl('h2', t(titleKey)));
  return s;
}

/** Resolve a metric's display name (custom name, localized name, or key/id). */
export function metricName(metric: Metric, t: AppContext['t']): string {
  if (metric.customName) return metric.customName;
  if (metric.nameKey) return t(metric.nameKey as StringKey);
  return metric.key ?? metric.id;
}

// ---------------------------------------------------------------------------
// Pack export helpers
// ---------------------------------------------------------------------------

export interface PackExportOptions {
  /** Include each metric's `tags` in the pack. */
  includeTags: boolean;
  /** Include each metric's external codes (LOINC + generic system/code pairs). */
  includeCodes: boolean;
}

export function metricToPackDef(ctx: AppContext, m: Metric, opts: PackExportOptions): PackMetricDef {
  const def: PackMetricDef = {
    key: m.key ?? m.id,
    name: metricName(m, ctx.t),
    aliases: m.aliases,
    valueType: m.valueType,
    category: m.category,
  };
  if (m.valueType === 'number' && m.canonicalUnit) def.unit = m.canonicalUnit;
  if (m.units.length > 1) def.units = m.units;
  if (m.enumValues) def.enumValues = m.enumValues;
  if (opts.includeCodes) {
    const codes = normalizeExternalCodes(m.externalCodes);
    if (codes) def.externalCodes = codes;
  }
  if (opts.includeTags && m.tags && m.tags.length > 0) def.tags = [...m.tags];
  if (m.typicalRange) def.typicalRange = m.typicalRange;
  if (m.precision) def.precision = m.precision;
  return def;
}

/** A metric's external codes, trimmed to the non-empty parts (or undefined). */
function normalizeExternalCodes(codes: ExternalCodes | undefined): ExternalCodes | undefined {
  if (!codes) return undefined;
  const out: ExternalCodes = {};
  if (codes.loinc) out.loinc = codes.loinc;
  if (codes.other && codes.other.length > 0) out.other = codes.other.map((o) => ({ ...o }));
  return out.loinc !== undefined || out.other !== undefined ? out : undefined;
}

/** Custom (non-built-in) units known to the engine — always packed for self-containment. */
function customUnits(ctx: AppContext): UnitDef[] {
  return ctx.units.allUnits().filter((u) => !BUILTIN_UNIT_CODES.has(u.code));
}

function downloadJson(obj: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------------------
// Catalog tools: export metrics/units as a pack, remove selected, or reset.
// ---------------------------------------------------------------------------

export function renderCatalogTools(ctx: AppContext): HTMLElement {
  const { t } = ctx;
  const s = section('settings.catalogTools', t);
  s.append(textEl('p', t('settings.catalogToolsHint'), 'muted'));

  // Export the metrics the user actually tracks → the pack-driven visible set.
  const all = ctx.catalog().visible();
  const selected = new Set<MetricId>(all.map((m) => m.id));
  const useTags = ctx.data().settings.useTags !== false;
  let customOnly = false;
  let tag: string | undefined; // active tag filter (only when useTags)
  // Units are always packed (a pack must be self-contained). Tags default on
  // (only offered when tags are enabled); external codes default off.
  let includeTags = useTags;
  let includeCodes = false;

  const listHost = el('div', 'settings-catalog-list');

  /** Metrics after the "only my own" toggle (the tag chips' universe). */
  function baseMetrics(): Metric[] {
    return customOnly ? all.filter((m) => m.customName !== undefined) : all;
  }
  /** Metrics shown in the checklist after BOTH the customOnly and tag filters. */
  function visible(): Metric[] {
    return baseMetrics().filter((m) => tag === undefined || (m.tags ?? []).includes(tag));
  }
  function paintList(): void {
    listHost.replaceChildren();
    for (const m of visible()) {
      const row = el('label', 'settings-check-row');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selected.has(m.id);
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(m.id);
        else selected.delete(m.id);
      });
      row.append(cb, textEl('span', metricName(m, t)));
      listHost.append(row);
    }
  }

  // Tag filter chip row (union of tags among the customOnly-filtered metrics).
  // Same pattern as the data-export wizard: chips narrow the shown list;
  // Select all/none act on the filtered subset. Only when tags are enabled.
  const tagFilter = el('div', 'export-tag-filter');
  function paintTagFilter(): void {
    if (!useTags) return;
    tagFilter.replaceChildren();
    const tags = usedTags(baseMetrics());
    if (tags.length === 0) return;
    const makeChip = (label: string, value: string | undefined): HTMLButtonElement =>
      tagChip({
        label,
        isActive: tag === value,
        onToggle: () => {
          tag = tag === value ? undefined : value;
          paintTagFilter();
          paintList();
        },
      });
    tagFilter.append(makeChip(t('tags.all'), undefined));
    for (const tg of tags) tagFilter.append(makeChip(tagLabel(tg, t), tg));
  }

  // Controls: select all / none, "only my own".
  const controls = el('div', 'settings-choice');
  const allBtn = button(t('settings.selectAll'));
  allBtn.addEventListener('click', () => {
    for (const m of visible()) selected.add(m.id);
    paintList();
  });
  const noneBtn = button(t('settings.selectNone'));
  noneBtn.addEventListener('click', () => {
    for (const m of visible()) selected.delete(m.id);
    paintList();
  });
  const customRow = el('label', 'settings-check-row');
  const customCb = document.createElement('input');
  customCb.type = 'checkbox';
  customCb.addEventListener('change', () => {
    customOnly = customCb.checked;
    // The tag universe changed — repaint chips (and drop a now-absent filter).
    if (useTags && tag !== undefined && !usedTags(baseMetrics()).includes(tag)) tag = undefined;
    paintTagFilter();
    paintList();
  });
  customRow.append(customCb, textEl('span', t('settings.customOnly')));
  controls.append(allBtn, noneBtn, customRow);

  // Content toggles: include tags (default on, only when tags are enabled) and
  // include external codes (default off). Units are always packed.
  const toggles = el('div', 'settings-choice');
  if (useTags) {
    const tagsRow = el('label', 'settings-check-row');
    const tagsCb = document.createElement('input');
    tagsCb.type = 'checkbox';
    tagsCb.checked = includeTags;
    tagsCb.addEventListener('change', () => {
      includeTags = tagsCb.checked;
    });
    tagsRow.append(tagsCb, textEl('span', t('settings.includeTags')));
    toggles.append(tagsRow);
  }
  const codesRow = el('label', 'settings-check-row');
  const codesCb = document.createElement('input');
  codesCb.type = 'checkbox';
  codesCb.checked = includeCodes;
  codesCb.addEventListener('change', () => {
    includeCodes = codesCb.checked;
  });
  codesRow.append(codesCb, textEl('span', t('settings.includeCodes')));
  toggles.append(codesRow);

  // Editable filename (pre-filled with a dated default; `.json` appended).
  const nameField = el('label', 'settings-field');
  nameField.append(textEl('span', t('settings.packFilename'), 'settings-field-label'));
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'settings-pack-filename';
  nameInput.value = buildPackBaseName(ctx.now());
  nameInput.setAttribute('aria-label', t('settings.packFilename'));
  nameInput.placeholder = t('settings.packFilenamePlaceholder');
  nameField.append(nameInput);

  const exportBtn = button(t('settings.exportCatalog'), 'primary');
  exportBtn.addEventListener('click', () => {
    const metrics = [...selected]
      .map((id) => ctx.catalog().byId(id))
      .filter((m): m is Metric => m !== undefined)
      .map((m) => metricToPackDef(ctx, m, { includeTags, includeCodes }));
    const pack: VitametrPack = {
      format: PACK_FORMAT,
      version: PACK_VERSION,
      id: 'catalog-export',
      name: 'Vitametr catalog',
      metrics,
    };
    // A pack must be self-contained: always ship the custom unit definitions.
    const units = customUnits(ctx);
    if (units.length > 0) pack.units = units;
    const base = sanitizeFilename(nameInput.value, buildPackBaseName(ctx.now()));
    nameInput.value = base;
    downloadJson(pack, applyExtension(base, 'json'));
  });

  paintTagFilter();
  paintList();
  s.append(controls, tagFilter, listHost, toggles, nameField, exportBtn);

  return s;
}
