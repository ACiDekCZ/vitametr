/**
 * Bundled category packs — data, not code.
 *
 * Packs no longer ADD metrics; they control the VISIBILITY of built-in metrics
 * that are all compiled into `BUILTIN_METRICS` (see `catalog-data.ts`). A bundled
 * category pack is the set of built-ins carrying its panel tag; the special
 * "Core" pack is the routine cross-category slice the app shows by default. See
 * `docs/PLAN-BALICKY-VIDITELNOST.md` and `core/packs.ts`.
 *
 * Each bundled pack is still a real {@link VitametrPack} document (so it can flow
 * through the export path and round-trip through {@link parsePack}); its metric
 * list is DERIVED from the tag over `BUILTIN_METRICS` — never hand-duplicated —
 * so it stays in lockstep with the catalog.
 *
 * Categories map 1:1 onto the panel tags in `core/tags.ts` (pack id
 * `bundled:<tag>`). Categories are NON-DISJOINT: an analyte may carry several
 * category tags and thus belong to several packs (e.g. `pth` is both a hormone
 * and a bone-turnover marker). A metric stays visible while ANY pack that
 * provides it is active.
 */

import type { StringKey } from '../i18n/index';
import { BUILTIN_METRICS } from './catalog-data';
import { PACK_FORMAT, PACK_VERSION, type PackMetricDef, type VitametrPack } from '../plugins/import/pack';
import type { Catalog } from './contracts';
import type { Metric } from './types';

// ---------------------------------------------------------------------------
// Core pack
// ---------------------------------------------------------------------------

/** Stable id of the "Core" pack — the routine set shown by default. */
export const CORE_PACK_ID = 'builtin:core';

/**
 * The routine core set: the keys of the 95 built-in metrics that existed before
 * the category "extras" were compiled into the catalog. This is what the "Core"
 * pack provides. It is an EXPLICIT list (Core is not a tag), captured verbatim so
 * a later catalog growth never silently changes what Core shows.
 */
export const CORE_METRIC_KEYS: readonly string[] = [
  'total-cholesterol', 'ldl-cholesterol', 'hdl-cholesterol', 'triglycerides', 'glucose',
  'hba1c', 'creatinine', 'egfr', 'uric-acid', 'alt', 'ast', 'ggt', 'alp', 'bilirubin-total',
  'crp', 'tsh', 'vitamin-d', 'vitamin-b12', 'folate', 'ferritin', 'iron', 'psa', 'hemoglobin',
  'leukocytes', 'thrombocytes', 'bp-systolic', 'bp-diastolic', 'heart-rate', 'body-weight',
  'waist', 'body-temperature', 'spo2', 'lipoprotein-a', 'nt-probnp', 'urea', 'ft4', 'c-peptide',
  'anti-gad', 'urine-protein', 'urine-glucose', 'urine-ketones', 'urine-bilirubin',
  'urine-urobilinogen', 'urine-nitrite', 'urine-blood', 'urine-leukocyte-esterase', 'urine-ph',
  'urine-albumin', 'urine-creatinine', 'acr', 'fob', 'psa-free', 'p2psa', 'erythrocytes',
  'hematocrit', 'mcv', 'mch', 'mchc', 'rdw', 'mpv', 'sodium', 'potassium', 'chloride', 'calcium',
  'magnesium', 'albumin', 'total-protein', 'lipase', 'non-hdl-cholesterol', 'apolipoprotein-a1',
  'apolipoprotein-b', 'amylase', 'amylase-pancreatic', 'ld', 'ck', 'cholinesterase', 'phosphate',
  'osmolality', 'homocysteine', 'bilirubin-direct', 'transferrin', 'tibc', 'transferrin-saturation',
  'ft3', 'aslo', 'rheumatoid-factor', 'reticulocytes', 'esr', 'neutrophils', 'lymphocytes',
  'monocytes', 'eosinophils', 'basophils', 'urine-erythrocytes', 'urine-leukocytes',
];

const CORE_KEY_SET = new Set<string>(CORE_METRIC_KEYS);

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/** Stable pack id for a category tag. */
export function bundledPackId(tag: string): string {
  return `bundled:${tag}`;
}

/**
 * The i18n key for a pack's display name: `pack.core` for the Core pack, else
 * `pack.<id>` (e.g. `pack.bundled:lipids`).
 */
export function bundledPackNameKey(packId: string): StringKey {
  if (packId === CORE_PACK_ID) return 'pack.core' as StringKey;
  return `pack.${packId}` as StringKey;
}

/** Convert one built-in metric into a self-contained, exportable pack def. */
function builtinToPackDef(m: Metric): PackMetricDef {
  const numeric = m.valueType === 'number';
  return {
    key: m.key!,
    // A stable display name: the metric's first alias (a real lab name).
    name: m.aliases[0] ?? m.key!,
    aliases: [...m.aliases],
    valueType: m.valueType,
    category: m.category,
    ...(numeric ? { unit: m.canonicalUnit, units: [...m.units] } : {}),
    ...(m.enumValues ? { enumValues: [...m.enumValues] } : {}),
    ...(m.externalCodes ? { externalCodes: m.externalCodes } : {}),
    ...(m.tags ? { tags: [...m.tags] } : {}),
    ...(m.typicalRange ? { typicalRange: m.typicalRange } : {}),
    ...(m.precision ? { precision: m.precision } : {}),
  };
}

/**
 * Build a category pack: every built-in metric carrying `tag`, derived straight
 * from `BUILTIN_METRICS` (never hand-duplicated), so the pack stays in lockstep
 * with the catalog.
 */
export function buildBundledPack(packId: string, tag: string): VitametrPack {
  const metrics = BUILTIN_METRICS.filter((m) => (m.tags ?? []).includes(tag)).map(builtinToPackDef);
  return {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    id: packId,
    name: packId,
    metrics,
  };
}

/**
 * The bundled categories, in a sensible display order. One pack per clinical
 * category the corpus analysis flagged as a routine grouping — the panel tags
 * plus three category tags (cardiac / coagulation / bone).
 */
const BUNDLED_TAGS: readonly string[] = [
  'lipids',
  'liver',
  'kidney',
  'thyroid',
  'diabetes',
  'iron',
  'cbc',
  'biochemistry',
  'vitamins',
  'hormones',
  'tumor-markers',
  'cardiac',
  'coagulation',
  'bone',
];

/** All bundled category packs. */
export const BUNDLED_PACKS: readonly VitametrPack[] = BUNDLED_TAGS.map((tag) =>
  buildBundledPack(bundledPackId(tag), tag),
);

/** The "Core" pack — the routine set the app shows by default (id `builtin:core`). */
export const CORE_PACK: VitametrPack = {
  format: PACK_FORMAT,
  version: PACK_VERSION,
  id: CORE_PACK_ID,
  name: CORE_PACK_ID,
  metrics: BUILTIN_METRICS.filter((m) => m.key !== undefined && CORE_KEY_SET.has(m.key)).map(
    builtinToPackDef,
  ),
};

/** The bundled packs (defensive copy of the array). */
export function bundledPacks(): VitametrPack[] {
  return [...BUNDLED_PACKS];
}

/** A pack by id — a bundled category pack (`bundled:<tag>`) or the Core pack. */
export function bundledPackById(id: string): VitametrPack | undefined {
  if (id === CORE_PACK_ID) return CORE_PACK;
  return BUNDLED_PACKS.find((p) => p.id === id);
}

/**
 * The built-in metric keys a pack PROVIDES (its visibility set): for the Core
 * pack the explicit {@link CORE_METRIC_KEYS}; for a category pack, every built-in
 * whose tags include the pack's tag. User metrics are never "provided" by a pack.
 */
export function packProvidedKeys(packId: string, catalog: Catalog): string[] {
  if (packId === CORE_PACK_ID) return [...CORE_METRIC_KEYS];
  const tag = packId.startsWith('bundled:') ? packId.slice('bundled:'.length) : undefined;
  if (tag === undefined) return [];
  const keys: string[] = [];
  for (const m of catalog.all()) {
    if (m.id.startsWith('builtin:') && m.key !== undefined && (m.tags ?? []).includes(tag)) {
      keys.push(m.key);
    }
  }
  return keys;
}
