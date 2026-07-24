/**
 * Domain types — the single source of truth for the whole application.
 *
 * Design notes:
 * - Measurements are stored exactly as measured (value + unit + original
 *   text); conversions are display-time operations only.
 * - Reference ranges belong to a measurement, not to a metric: every lab
 *   ships its own ranges and they change over time.
 * - External code systems (LOINC and user-added ones) are attributes of a
 *   metric, never its identity. The internal model does not depend on any
 *   code system.
 */

// ---------------------------------------------------------------------------
// Branded identifiers
// ---------------------------------------------------------------------------

export type MetricId = string & { readonly __brand: 'MetricId' };
export type MeasurementId = string & { readonly __brand: 'MeasurementId' };
export type SourceId = string & { readonly __brand: 'SourceId' };
export type ProfileId = string & { readonly __brand: 'ProfileId' };

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/**
 * Every unit belongs to exactly one dimension. Units of the same dimension
 * are mutually convertible through the dimension's base unit — except the
 * 'arbitrary' dimension, where only identity conversion is allowed.
 */
export type DimensionId =
  | 'mass'
  | 'length'
  | 'temperature'
  | 'pressure'
  | 'mass-concentration'
  | 'molar-concentration'
  | 'count-concentration'
  | 'fraction'
  | 'rate'
  | 'enzymatic-activity'
  | 'arbitrary';

export interface UnitDef {
  /** UCUM code, e.g. 'mmol/L', 'mm[Hg]', 'Cel', '[degF]'. */
  code: string;
  /** Human-readable symbol, e.g. 'mmol/l', 'mmHg', '°C'. */
  display: string;
  dimension: DimensionId;
  /** Linear map to the dimension's base unit: base = value * factor + offset. */
  toBase: { factor: number; offset?: number };
}

/**
 * Metric-specific affine conversion between two concrete units. Takes
 * precedence over any derived conversion (dimensional or molar-mass based).
 * The engine may invert it to convert in the opposite direction.
 * Example (HbA1c): mmol/mol -> % with factor 0.09148, offset 2.152.
 */
export interface MetricConversion {
  fromUnit: string;
  toUnit: string;
  factor: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Metric (health quantity)
// ---------------------------------------------------------------------------

export type MetricCategory = 'lab' | 'home' | 'wearable' | 'custom';

export interface ExternalCodes {
  /** LOINC code — public seed data (license permits embedding a subset). */
  loinc?: string;
  /**
   * Additional, code-system-agnostic external codes the user adds to a metric,
   * each a free-text {@link system} label plus its {@link code}. User's local
   * data only — the built-in catalog never ships any of these (only LOINC is
   * seeded, under its open license); they are never sent off-device.
   */
  other?: { system: string; code: string }[];
}

export interface Metric {
  id: MetricId;
  /** Stable key of a built-in metric (e.g. 'glucose'); absent for user metrics. */
  key?: string;
  /** i18n string key for built-in metrics. Exactly one of nameKey/customName is set. */
  nameKey?: string;
  /** Free-text name for user-defined metrics. */
  customName?: string;
  /** Recognized names for alias resolution (case/diacritics-insensitive). */
  aliases: string[];
  category: MetricCategory;
  /**
   * Value kind:
   * - 'number' — a quantity with a unit (charted, ranged, correlated).
   * - 'text'   — a free-text qualitative result (e.g. "negativní").
   * - 'enum'   — a single value constrained to `enumValues`.
   * - 'multi'  — several values chosen from `enumValues`.
   * 'text'/'enum' store their value in `Measurement.textValue`; 'multi' stores
   * `Measurement.textValues`. None of the three is charted or unit-converted.
   */
  valueType: 'number' | 'text' | 'enum' | 'multi';
  /** Allowed values for an 'enum'/'multi' metric, in display order (e.g. Neg/Pos). */
  enumValues?: string[];
  /** Unit used for charts and internal computations (UCUM code). */
  canonicalUnit: string;
  /** Units this metric may be recorded/displayed in (UCUM codes, incl. canonical). */
  units: string[];
  /** g/mol — enables mass-concentration <-> molar-concentration conversion. */
  molarMass?: number;
  /** Explicit conversions; take precedence over derived ones. */
  conversions?: MetricConversion[];
  externalCodes?: ExternalCodes;
  /** Display decimals per unit code (display-time rounding only). */
  precision?: Record<string, number>;
  /** Sanity range in canonicalUnit for input validation (typo detection, not medical advice). */
  typicalRange?: { low?: number; high?: number };
  /** Preferred display unit per UI locale, e.g. { cs: 'mmol/L', en: 'mg/dL' }. */
  preferredUnitByLocale?: Record<string, string>;
  /** Metrics entered together (e.g. 'blood-pressure' groups sys + dia + pulse). */
  entryGroup?: string;
  /** User hid this metric from the overview. */
  hidden?: boolean;
  /**
   * Cross-cutting, multi-valued grouping labels (specimen + clinical panel).
   * Values are tag ids: seeded ids are stable kebab keys with i18n labels
   * (`tag.<id>`); user-added tags are raw strings stored verbatim. Additive and
   * optional — a metric without tags falls into the "other" group. See
   * `core/tags.ts` for the vocabulary and the primary-tag / grouping helpers.
   */
  tags?: string[];
  /** Id of the metric pack this definition came from (for add/remove as a group). */
  pack?: string;
  /**
   * How this (custom) metric came to exist — its provenance. Additive & optional:
   * a metric without it behaves exactly as before. `kind` is 'manual' (created
   * from the entry form), 'import' (created while resolving an import) or 'pack'
   * (installed from a metric pack). For an import-created metric, `importId` is
   * back-stamped at commit with the owning import's id, so undoing that import can
   * offer to also remove the (now-unused) metrics it created. See `core/imports.ts`.
   */
  origin?: { kind: 'manual' | 'import' | 'pack'; importId?: string };
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

export type Operator = '<' | '>' | '<=' | '>=';

/** Data-quality state of a record (spec §16): correctness over auto-storage. */
export type MeasurementStatus =
  | 'confirmed'
  | 'auto-high-confidence'
  | 'needs-review'
  | 'corrected'
  | 'ambiguous'
  | 'rejected';

export type TimePrecision = 'date' | 'datetime';

export interface MeasurementOrigin {
  /** Import plugin that produced the record ('manual', 'json-backup', ...). */
  pluginId: string;
  /** Original text from the source; never overwritten by normalization. */
  rawText?: string;
  /** Link to a source document (phase 2+). */
  documentRef?: string;
}

export interface Measurement {
  id: MeasurementId;
  profileId: ProfileId;
  metricId: MetricId;
  /** The numeric value, for a 'number' metric. Absent for a qualitative one. */
  value?: number;
  /** The qualitative value, for a 'text'/'enum' metric (e.g. "negativní"). */
  textValue?: string;
  /** Several chosen values, for a 'multi' metric. */
  textValues?: string[];
  /** Present for censored results such as '< 0.1'. */
  operator?: Operator;
  /** UCUM code of the unit the value was measured in. Absent for text values. */
  unit: string;
  /** ISO 8601; interpret according to timePrecision. */
  takenAt: string;
  timePrecision: TimePrecision;
  /** Reference range as stated by the source, in `unit`. */
  refLow?: number;
  refHigh?: number;
  /** Original textual range expression from the source. */
  refText?: string;
  sourceId?: SourceId;
  note?: string;
  status: MeasurementStatus;
  origin: MeasurementOrigin;
  /**
   * Id of the {@link ImportRecord} that created this measurement (file imports
   * only). Absent for manual entry and for data written before import history
   * existed. Additive/optional — enables per-import provenance and undo.
   */
  importId?: string;
  createdAt: string;
  modifiedAt: string;
}

// ---------------------------------------------------------------------------
// Import history
// ---------------------------------------------------------------------------

/**
 * One recorded file import — a first-class entity so the user can see what they
 * imported and undo it, and so later features (conflict provenance, "export the
 * results of import X") can reference a concrete import. Manual entry does NOT
 * produce an ImportRecord; only file imports do.
 */
export interface ImportRecord {
  id: string;
  /** ISO 8601 instant the import was committed. */
  importedAt: string;
  /** Import plugin that produced the measurements ('pdf', 'json-backup', ...). */
  pluginId: string;
  /** Source name carried by the import, when the plugin/file provided one. */
  sourceName?: string;
  /** Original file name, when the import came from a picked/dropped file. */
  fileName?: string;
  /** Number of measurements actually committed by this import (after de-dup). */
  count: number;
}

// ---------------------------------------------------------------------------
// Source & Profile
// ---------------------------------------------------------------------------

export type SourceKind = 'lab' | 'doctor' | 'device' | 'app' | 'manual' | 'other';

export interface Source {
  id: SourceId;
  name: string;
  kind: SourceKind;
  note?: string;
}

export interface Profile {
  id: ProfileId;
  name: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Import pipeline data
// ---------------------------------------------------------------------------

/**
 * A measurement candidate produced by an import plugin, before user review.
 * `metric` is either resolved against the catalog or carries the raw name
 * for the user to decide (never guessed silently — spec §16).
 */
export interface ProposedMeasurement {
  metric: MetricId | { unresolvedName: string };
  /** Numeric value; absent when the proposal is a qualitative result. */
  value?: number;
  /** Qualitative value (e.g. "negativní"); absent for numeric proposals. */
  textValue?: string;
  /** Several chosen values, for a 'multi' metric. */
  textValues?: string[];
  operator?: Operator;
  unit?: string;
  takenAt?: string;
  timePrecision?: TimePrecision;
  refLow?: number;
  refHigh?: number;
  refText?: string;
  sourceName?: string;
  note?: string;
  rawText?: string;
  confidence: 'high' | 'medium' | 'low';
}

// ---------------------------------------------------------------------------
// Persisted profile data (the content of one storage blob)
// ---------------------------------------------------------------------------

/**
 * Global measurement-unit convention, independent of the UI language.
 * - 'auto' (default when absent) — follow the UI locale, as before.
 * - 'si'   — prefer SI/metric units (mmol/L, kg, °C, …).
 * - 'us'   — prefer US/conventional units (mg/dL, lb, °F, …).
 * This is the sole driver of display units — there is no per-metric override.
 */
export type UnitSystem = 'auto' | 'si' | 'us';

export interface ProfileSettings {
  locale?: 'cs' | 'en';
  autoLockMinutes?: number;
  /**
   * Global unit-system preference, decoupled from {@link locale}. Optional and
   * additive: treated as 'auto' (follow the language) when absent, so no schema
   * bump or migration is needed.
   */
  unitSystem?: UnitSystem;
  /**
   * Appearance preference. Optional and additive: 'auto' (follow the system
   * scheme) when absent, so no schema bump or migration is needed. The UI
   * resolves this to a concrete light/dark theme (see src/ui/theme.ts).
   */
  theme?: 'auto' | 'light' | 'dark';
  /**
   * Import filter: when true, an import proposes only measurements whose metric
   * already resolves to a catalog entry — unresolved names are dropped rather
   * than turned into new metrics. Optional, defaults to false; additive field,
   * no migration needed.
   */
  importKnownOnly?: boolean;
  /**
   * Import recognition: when true (the default), an import also recognises
   * metrics from currently-INACTIVE packs and offers to reveal them in review
   * (activate the pack / show just this metric / create your own). When false, a
   * name that would resolve ONLY to a hidden metric is treated as unresolved, so
   * it flows into the normal create-new / skip path instead of being attached to
   * a hidden metric. Optional/additive: absent ⇒ true. No migration needed.
   */
  offerHiddenMetrics?: boolean;
  /**
   * Whether the tag UI (per-metric chips, tag filters, and overview grouping by
   * tag) is shown. Additive/optional: tags are ON when the field is absent;
   * only an explicit `false` hides the tag UI app-wide.
   */
  useTags?: boolean;
  /**
   * How the overview groups metrics into tag sections. When false/absent (the
   * default) each metric appears under exactly one section — its
   * {@link primaryTag}. When true, a metric appears under EVERY tag it carries,
   * so a custom tag forms its own visible section. Only relevant when
   * {@link useTags} is on. Additive/optional: absent ⇒ false. No migration.
   */
  overviewGroupByAllTags?: boolean;
  /**
   * How the overview lays out its metrics: 'grid' (cards) or 'list' (dense
   * rows). Additive/optional: when absent the layout defaults to the card grid
   * at every width (see overview-model `defaultLayout`); an explicit choice
   * applies at both widths. No migration needed.
   */
  overviewLayout?: 'grid' | 'list';
  /**
   * Ids of the packs the user has activated — the "Core" pack (`builtin:core`)
   * plus any bundled category packs (see `core/packs.ts` / `core/packs-data.ts`).
   * Packs control metric VISIBILITY, not membership. Additive/optional and
   * normalized on read: absent ⇒ treated as `['builtin:core']` (Core on = the
   * routine set visible, backward-compatible with older profiles). Once written
   * the array is explicit; deactivating Core removes its id. No schema bump.
   * `activatePack`/`deactivatePack` maintain this list.
   */
  activePacks?: string[];
  /**
   * Metric ids the user forced to be shown regardless of pack membership (from
   * the import-review "show just this metric" flow). Additive/optional: absent ⇒
   * none forced. Complements the pack-driven visibility in `core/packs.ts`.
   */
  shownMetrics?: MetricId[];
}

/**
 * The content of one storage blob.
 *
 * Two versions are tracked independently and MUST NOT be conflated:
 * - `schemaVersion` — the DATA format version. It changes ONLY when the shape
 *   of this structure changes in a way that needs a migration. On load, the
 *   store migrates older versions up; it refuses versions NEWER than it
 *   understands (rather than risk corrupting them). Additive changes that stay
 *   readable (new optional fields) do NOT bump it — unknown fields are
 *   preserved verbatim through load→save, so an older app never strips data a
 *   newer app wrote.
 * - `appVersion` — the Vitametr build that last WROTE the blob (diagnostics
 *   only; never drives behavior). The store stamps it on every write.
 *
 * See `VERSIONING.md` (repo root) for the full policy and the recipe for
 * adding a migration.
 */
/**
 * A declarative import mapping — the data-only definition of a text/line lab
 * parser that a user can add by importing a JSON pack (no code execution: it is
 * interpreted as regex data, never run as script, so it stays within the app's
 * strict `script-src 'self'` CSP and the offline privacy model). Turned into a
 * `LabParser` at import time by `declarativeLabParser` (see
 * `src/plugins/import/declarative-lab.ts`).
 */
export interface ImportMappingDef {
  /** Stable id (dedupe key when merged into a profile / a pack). */
  id: string;
  /** Source label stamped on every measurement this mapping produces. */
  sourceName: string;
  /**
   * Auto-detection: the format matches when the extracted text contains ANY of
   * these substrings (compared case-insensitively). Must be non-empty.
   */
  detect: { anyOf: string[] };
  /** Optional: split each line into entries on this literal (e.g. ";"). */
  entrySplit?: string;
  /**
   * Regex applied per entry, with NAMED groups. `(?<name>…)` is REQUIRED; the
   * optional `(?<value>…)` `(?<unit>…)` `(?<low>…)` `(?<high>…)` groups fill the
   * value, unit and reference range. Compiled with a try/catch + input-length
   * guard — that is the safety boundary (data, never executed as code).
   */
  pattern: string;
  /**
   * Optional regex for the document date: a named `(?<date>…)` group, or the
   * first capture group, yields the date shared by every proposal.
   */
  datePattern?: string;
}

export interface ProfileData {
  schemaVersion: number;
  /** Build that last wrote this blob (e.g. '0.1.0'); informational only. */
  appVersion?: string;
  profile: Profile;
  /** User-defined metrics and per-profile overrides of built-ins (learned aliases, hidden, external codes). */
  metrics: Metric[];
  sources: Source[];
  measurements: Measurement[];
  /** Custom units added by the user / a pack, merged on top of the built-ins. */
  units?: UnitDef[];
  /**
   * Built-in metric ids the user removed. The built-in catalog is the app's
   * default pack: metrics can be switched off per profile (so a user can keep
   * only the few they care about) and brought back by "reset to default".
   */
  disabledMetrics?: MetricId[];
  /** Recorded file imports, newest-first is imposed by the UI (not the storage order). */
  imports?: ImportRecord[];
  /**
   * User-added declarative import mappings (text/line lab parsers defined as
   * data, added by importing a pack). Merged, deduped by id. Additive: an older
   * app that does not model this field preserves it verbatim through load→save.
   */
  importMappings?: ImportMappingDef[];
  settings: ProfileSettings;
  // Forward compatibility: fields written by a NEWER app that this version does
  // not model are NOT declared here, but they DO survive a load→save round-trip
  // — the blob is JSON-parsed into this object (keeping every key) and mutated
  // in place, never reconstructed, so unknown keys are re-emitted verbatim.
  // (Enforced by the "preserves unknown fields" store test.) Migrations must
  // spread `...data` rather than rebuild the object, to keep this guarantee.
}

export const CURRENT_SCHEMA_VERSION = 1;
