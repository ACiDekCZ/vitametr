/**
 * Metric pack — the modular, data-driven way to add metrics (and their sample
 * values) to a profile. A pack is a declarative JSON document: metric
 * definitions (name, aliases, value type, unit, enum options) plus optional
 * measurements. Importing it registers any new metrics and proposes the values
 * through the normal review pipeline; the metrics carry the pack id so a whole
 * pack can be added or removed as a unit. Concrete-application catalogs ship as
 * packs — the core stays a stable domain, everything else plugs in around it.
 */

import type {
  ExternalCodes,
  ImportMappingDef,
  Metric,
  MetricCategory,
  Operator,
  TimePrecision,
  UnitDef,
} from '../../core/types';

export type { ImportMappingDef } from '../../core/types';

export const PACK_FORMAT = 'vitametr-pack' as const;
export const PACK_VERSION = 1 as const;

export interface PackMetricDef {
  /** Stable key within the pack (referenced by the pack's measurements). */
  key: string;
  /** Display name. */
  name: string;
  aliases?: string[];
  /** Defaults to 'number'. */
  valueType?: 'number' | 'text' | 'enum' | 'multi';
  /** Canonical/only unit, for a 'number' metric. */
  unit?: string;
  units?: string[];
  /** Allowed values, for 'enum'/'multi'. */
  enumValues?: string[];
  /** Defaults to 'custom'. */
  category?: MetricCategory;
  /**
   * Legacy single LOINC code. Kept for backward compatibility (old packs) and
   * as a shorthand; superseded by {@link externalCodes}. When both are present
   * `externalCodes.loinc` wins.
   */
  loinc?: string;
  /**
   * Full external codes, mirroring the core `Metric.externalCodes` (LOINC plus
   * any generic system/code pairs). Emitted only when the exporter's "include
   * codes" toggle is on; absent in older packs (backward compatible).
   */
  externalCodes?: ExternalCodes;
  /**
   * Cross-cutting grouping labels (see `core/tags.ts`). Emitted only when the
   * exporter's "include tags" toggle is on; absent in older packs.
   */
  tags?: string[];
  typicalRange?: { low?: number; high?: number };
  precision?: Record<string, number>;
}

export interface PackMeasurementDef {
  /** References a PackMetricDef.key. */
  metric: string;
  value?: number;
  textValue?: string;
  textValues?: string[];
  operator?: Operator;
  unit?: string;
  takenAt?: string;
  timePrecision?: TimePrecision;
  refLow?: number;
  refHigh?: number;
  note?: string;
}

export interface VitametrPack {
  format: typeof PACK_FORMAT;
  version: number;
  /** Pack id — tags every metric it registers (for add/remove as a group). */
  id: string;
  name?: string;
  /** Custom unit definitions (code, display, dimension, toBase). */
  units?: UnitDef[];
  metrics?: PackMetricDef[];
  measurements?: PackMeasurementDef[];
  /** Declarative import mappings (data-driven text/line lab parsers). */
  importMappings?: ImportMappingDef[];
}

export function isPack(value: unknown): value is VitametrPack {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { format?: unknown }).format === PACK_FORMAT &&
    typeof (value as { id?: unknown }).id === 'string'
  );
}

/** Parse + validate a pack document; throws on a malformed one. */
export function parsePack(raw: unknown): VitametrPack {
  const value = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  if (!isPack(value)) throw new Error('not a Vitametr pack');
  if (typeof value.version === 'number' && value.version > PACK_VERSION) {
    throw new Error(
      `Pack version ${value.version} is newer than supported ${PACK_VERSION}; update the app.`,
    );
  }
  for (const def of value.metrics ?? []) {
    if (!def.key || !def.name) throw new Error('pack metric needs a key and a name');
    const vt = def.valueType ?? 'number';
    if ((vt === 'enum' || vt === 'multi') && (!def.enumValues || def.enumValues.length === 0)) {
      throw new Error(`enum/multi metric "${def.key}" needs enumValues`);
    }
  }
  for (const m of value.importMappings ?? []) {
    validateImportMapping(m);
  }
  return value;
}

/**
 * Validate one declarative import mapping. The pattern is only ever compiled
 * (never executed as code), and the compile is wrapped in try/catch so a
 * malformed regex is rejected here rather than blowing up at parse time. A
 * pattern MUST expose a named `name` group — without it there is no metric to
 * resolve, so the mapping could never produce a proposal.
 */
export function validateImportMapping(m: ImportMappingDef): void {
  if (!m || typeof m !== 'object') throw new Error('import mapping must be an object');
  if (typeof m.id !== 'string' || m.id === '') throw new Error('import mapping needs an id');
  if (typeof m.sourceName !== 'string' || m.sourceName === '') {
    throw new Error(`import mapping "${m.id}" needs a sourceName`);
  }
  if (
    !m.detect ||
    !Array.isArray(m.detect.anyOf) ||
    m.detect.anyOf.length === 0 ||
    m.detect.anyOf.some((s) => typeof s !== 'string' || s === '')
  ) {
    throw new Error(`import mapping "${m.id}" needs a non-empty detect.anyOf`);
  }
  if (typeof m.pattern !== 'string' || m.pattern === '') {
    throw new Error(`import mapping "${m.id}" needs a pattern`);
  }
  if (!/\(\?<name>/.test(m.pattern)) {
    throw new Error(`import mapping "${m.id}" pattern needs a (?<name>…) group`);
  }
  try {
    new RegExp(m.pattern);
  } catch {
    throw new Error(`import mapping "${m.id}" has an invalid pattern`);
  }
  if (m.datePattern !== undefined) {
    if (typeof m.datePattern !== 'string') {
      throw new Error(`import mapping "${m.id}" datePattern must be a string`);
    }
    try {
      new RegExp(m.datePattern);
    } catch {
      throw new Error(`import mapping "${m.id}" has an invalid datePattern`);
    }
  }
}

/**
 * Build an `addUserMetric` spec from a pack metric definition. The display name
 * is seeded as an alias so future imports resolve it by name.
 */
export function packMetricToSpec(def: PackMetricDef, packId: string): Omit<Metric, 'id'> {
  const valueType = def.valueType ?? 'number';
  const numeric = valueType === 'number';
  const canonicalUnit = numeric ? (def.unit ?? '') : '';
  const units = numeric ? (def.units ?? (def.unit ? [def.unit] : [])) : [];
  const aliases = [def.name, ...(def.aliases ?? [])];
  const externalCodes = packExternalCodes(def);
  const tags = packTags(def);
  return {
    key: def.key,
    customName: def.name,
    aliases,
    category: def.category ?? 'custom',
    valueType,
    ...(def.enumValues ? { enumValues: def.enumValues } : {}),
    canonicalUnit,
    units,
    ...(externalCodes ? { externalCodes } : {}),
    ...(tags ? { tags } : {}),
    ...(def.typicalRange ? { typicalRange: def.typicalRange } : {}),
    ...(def.precision ? { precision: def.precision } : {}),
    pack: packId,
    origin: { kind: 'pack' },
  };
}

/**
 * Resolve a pack metric's external codes, tolerant of malformed input. Prefers
 * the full `externalCodes` object, falling back to the legacy `loinc` shorthand.
 * Generic `other` pairs are kept only when both `system` and `code` are strings.
 * Returns undefined when nothing valid is present.
 */
export function packExternalCodes(def: PackMetricDef): ExternalCodes | undefined {
  const codes: ExternalCodes = {};
  const loinc = def.externalCodes?.loinc ?? def.loinc;
  if (typeof loinc === 'string' && loinc !== '') codes.loinc = loinc;
  const others = Array.isArray(def.externalCodes?.other)
    ? def.externalCodes.other.filter(
        (o): o is { system: string; code: string } =>
          !!o && typeof o.system === 'string' && typeof o.code === 'string',
      )
    : [];
  if (others.length > 0) codes.other = others;
  return codes.loinc !== undefined || codes.other !== undefined ? codes : undefined;
}

/** A pack metric's tags, tolerant of malformed input (non-string entries dropped). */
export function packTags(def: PackMetricDef): string[] | undefined {
  if (!Array.isArray(def.tags)) return undefined;
  const tags = def.tags.filter((t): t is string => typeof t === 'string' && t !== '');
  return tags.length > 0 ? tags : undefined;
}
