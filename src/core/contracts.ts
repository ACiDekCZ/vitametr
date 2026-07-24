/**
 * Module contracts — interfaces every implementation step builds against.
 * Owned by the architecture step (K2). Implementation steps must not modify
 * this file; ambiguities are escalated, not resolved ad hoc.
 */

import type {
  ImportMappingDef,
  Measurement,
  Metric,
  MetricId,
  ProfileData,
  ProposedMeasurement,
  SourceId,
  UnitDef,
} from './types';

// ---------------------------------------------------------------------------
// Units engine (K3)
// ---------------------------------------------------------------------------

export type ConversionResult =
  | { ok: true; value: number }
  | { ok: false; reason: 'unknown-unit' | 'not-convertible' };

export interface UnitsEngine {
  getUnit(code: string): UnitDef | undefined;

  /**
   * Replace the engine's unit table in place (same engine reference). Used to
   * merge a profile's custom units on top of the built-ins after a load or a
   * pack import, without re-wiring every `ctx.units` holder.
   */
  reloadUnits(units: readonly UnitDef[]): void;

  /** All units currently known to the engine (built-in + custom). */
  allUnits(): UnitDef[];

  /**
   * Convert a value between units. Resolution order (design doc §2.2):
   * 1. identity; 2. explicit MetricConversion of `metric` (invertible);
   * 3. same dimension via toBase ('arbitrary' allows identity only);
   * 4. molarMass bridge between mass- and molar-concentration;
   * 5. { ok: false } — never NaN, never a silent guess.
   */
  convert(value: number, fromUnit: string, toUnit: string, metric?: Metric): ConversionResult;

  /**
   * Convert value and reference range of a measurement together.
   * Returns undefined when not convertible.
   */
  convertMeasurement(
    m: Measurement,
    toUnit: string,
    metric: Metric,
  ): { value: number; refLow?: number; refHigh?: number } | undefined;

  /** Units reachable by conversion from the metric's canonical unit. */
  reachableUnits(metric: Metric): string[];

  /** Display rounding per metric precision; returns a plain number, not a string. */
  round(value: number, unitCode: string, metric?: Metric): number;
}

// ---------------------------------------------------------------------------
// Catalog (K4)
// ---------------------------------------------------------------------------

/**
 * Catalog of metrics: built-in seed merged with the profile's own metrics
 * (user-defined ones and per-profile overrides of built-ins).
 */
export interface Catalog {
  /** Every metric, UNFILTERED (built-ins + user) — the resolution surface. */
  all(): Metric[];
  /**
   * The pack-driven visibility subset of {@link all} — the metrics to SHOW the
   * user. A metric is visible when it is a user metric, has ≥1 measurement, or is
   * a built-in provided by an active pack; minus explicit hides, plus forced
   * shows. See `core/packs.ts`.
   */
  visible(): Metric[];
  byId(id: MetricId): Metric | undefined;
  byKey(key: string): Metric | undefined;
  /** Lookup by LOINC code (externalCodes.loinc); enables code-based import. */
  byLoinc(code: string): Metric | undefined;
  /** Lookup by an additional external code (externalCodes.other); local-only, forward-looking for code-based import. */
  byExternalCode(system: string, code: string): Metric | undefined;
  /** Case- and diacritics-insensitive lookup across names and aliases. */
  resolveAlias(name: string): Metric | undefined;
  /** Create a user-defined metric and persist it into ProfileData.metrics. */
  addUserMetric(spec: Omit<Metric, 'id'>): Metric;
  /** Remember a new alias for a metric (catalog learns from imports). */
  learnAlias(id: MetricId, alias: string): void;
  /** Forget a learned/custom alias (built-in seed aliases are not removable). */
  unlearnAlias(id: MetricId, alias: string): void;
  /** The editable aliases of a metric (learned ones / all of a custom metric). */
  customAliases(id: MetricId): string[];
  /**
   * Replace a metric's tags, persisting the change into ProfileData (for a
   * built-in this creates/updates an override entry, mirroring learnAlias).
   */
  setMetricTags(id: MetricId, tags: readonly string[]): void;
  /**
   * Set a metric's external codes — the special-cased LOINC plus a generic,
   * code-system-agnostic `other` list — persisting into ProfileData (for a
   * built-in this creates/updates an override entry, like setMetricTags). The
   * object is the full desired state: inputs are trimmed, empty pairs dropped,
   * an empty LOINC cleared. The additional codes are user-entered/local only.
   */
  setExternalCodes(
    id: MetricId,
    codes: { loinc?: string; other?: { system: string; code: string }[] },
  ): void;
  /** Add one tag to a metric (no-op when it already has it). */
  addTag(id: MetricId, tag: string): void;
  /** Remove one tag from a metric. */
  removeTag(id: MetricId, tag: string): void;
}

// ---------------------------------------------------------------------------
// Crypto (K5a)
// ---------------------------------------------------------------------------

/** Symmetric seal/open over an already-established data key. */
export interface CryptoBox {
  seal(plain: Uint8Array): Promise<Uint8Array>;
  open(sealed: Uint8Array): Promise<Uint8Array>;
}

/** Serialized key material stored in the 'keys' object store (plaintext metadata). */
export interface KeyRecord {
  mode: 'encrypted' | 'plaintext';
  /** KDF parameters + wrapped data key; opaque to callers. Absent in plaintext mode. */
  payload?: unknown;
}

export class WrongPassphraseError extends Error {}
export class TamperedDataError extends Error {}
/** An encrypted backup file was given without the password needed to open it. */
export class PassphraseRequiredError extends Error {}

export interface CryptoProvider {
  /** New profile with passphrase encryption. */
  createEncrypted(passphrase: string): Promise<{ box: CryptoBox; keyRecord: KeyRecord }>;
  /** Open an encrypted profile; throws WrongPassphraseError. */
  unlockEncrypted(passphrase: string, keyRecord: KeyRecord): Promise<CryptoBox>;
  /** Deliberately unencrypted profile — same API shape (identity box). */
  createPlaintext(): { box: CryptoBox; keyRecord: KeyRecord };
  unlockPlaintext(keyRecord: KeyRecord): CryptoBox;
  /** Re-wrap the data key under a new passphrase; data blobs stay untouched. */
  changePassphrase(oldPassphrase: string, newPassphrase: string, keyRecord: KeyRecord): Promise<KeyRecord>;
  /** Encrypt a previously plaintext profile: returns a box + record for re-sealing. */
  upgradeToEncrypted(passphrase: string): Promise<{ box: CryptoBox; keyRecord: KeyRecord }>;
}

// ---------------------------------------------------------------------------
// Storage backend + store (K5b)
// ---------------------------------------------------------------------------

/**
 * Minimal key-value backend. Production: IndexedDB object stores.
 * Tests: in-memory implementation (no fake-indexeddb dependency).
 */
export interface KvBackend {
  get(store: 'meta' | 'keys' | 'blobs', key: string): Promise<unknown>;
  put(store: 'meta' | 'keys' | 'blobs', key: string, value: unknown): Promise<void>;
  delete(store: 'meta' | 'keys' | 'blobs', key: string): Promise<void>;
  keys(store: 'meta' | 'keys' | 'blobs'): Promise<string[]>;
  /** Drop everything (the 'wipe all data' action). */
  clear(): Promise<void>;
}

export type StoreStatus = 'uninitialized' | 'locked' | 'unlocked';

export interface InitOptions {
  profileName: string;
  /** Omit for the deliberate plaintext mode. */
  passphrase?: string;
  locale?: 'cs' | 'en';
}

export interface StoreApi {
  status(): Promise<StoreStatus>;
  /** First run: create key record + empty ProfileData, persist, stay unlocked. */
  init(options: InitOptions): Promise<ProfileData>;
  /** Decrypt blob, run schema migrations, load into memory. */
  unlock(passphrase?: string): Promise<ProfileData>;
  /** Drop the key and in-memory data. Pending writes are flushed first. */
  lock(): Promise<void>;
  /** Throws when locked. */
  getData(): ProfileData;
  /** Apply a mutation and schedule a debounced persist. */
  mutate(fn: (data: ProfileData) => void): void;
  /** Persist immediately (called on lock, page hide, critical actions). */
  flush(): Promise<void>;
  changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<void>;
  enableEncryption(passphrase: string): Promise<void>;
  /** Re-seal data as plaintext; verifies the current passphrase first. */
  disableEncryption(currentPassphrase: string): Promise<void>;
  /**
   * Check a passphrase against the stored key record without side effects.
   * Encrypted profiles return `true` only for the correct passphrase; plaintext
   * profiles (no passphrase) always return `true`. Used to gate destructive
   * actions (e.g. wipe) behind re-authentication when a password is set.
   */
  verifyPassphrase(passphrase: string): Promise<boolean>;
  /** Encryption mode of the initialized profile (throws if uninitialized). */
  mode(): Promise<'encrypted' | 'plaintext'>;
  /** Delete all local data irreversibly. */
  wipe(): Promise<void>;
}

/** Pure functions ProfileData(vN) -> ProfileData(vN+1), applied in order on unlock. */
export type SchemaMigration = (data: ProfileData) => ProfileData;

// ---------------------------------------------------------------------------
// Plugins (K7)
// ---------------------------------------------------------------------------

export interface ImportContext {
  catalog: Catalog;
  /** Password for an encrypted backup file; absent for plain inputs. */
  password?: string;
  /**
   * The profile's declarative import mappings, if any. A text/PDF lab importer
   * turns these into extra parsers (via `declarativeLabParser`) and tries them
   * before the generic heuristic. Absent/empty keeps the built-in behaviour.
   */
  importMappings?: ImportMappingDef[];
}

export type ImportInput =
  | { kind: 'file'; file: File }
  | { kind: 'data'; data: unknown };

export interface ImportPlugin {
  id: string;
  /** i18n key of the display name. */
  nameKey: string;
  kind: 'interactive' | 'file';
  /** Accepted extensions/MIME types for kind 'file'. */
  accepts?: string[];
  parse(input: ImportInput, ctx: ImportContext): Promise<ProposedMeasurement[]>;
}

export interface ExportSelection {
  metricIds?: MetricId[];
  range?: { from?: string; to?: string };
  /**
   * Selection strategy. `'range'` (default when absent) keeps every measurement
   * inside `range`; `'snapshot'` keeps only the single latest measurement of each
   * metric taken at or before `asOfIso` (an "as of date" state view).
   */
  mode?: 'range' | 'snapshot';
  /**
   * Reference date for `mode: 'snapshot'` (ISO 8601, day-inclusive). Ignored in
   * range mode. Injected by the caller — no plugin reads the wall clock.
   */
  asOfIso?: string;
  /** When set, the backup file is encrypted under this password (like a .p12). */
  password?: string;
}

export interface ExportContext {
  data: ProfileData;
  catalog: Catalog;
  units: UnitsEngine;
  locale: 'cs' | 'en';
  /**
   * Caller-supplied "now" (ISO 8601). Optional: only the report export needs it,
   * to compute how recently each metric was measured (staleness). No plugin
   * reads the wall clock itself — the value is injected, never guessed.
   */
  nowIso?: string;
}

export interface ExportPlugin {
  id: string;
  nameKey: string;
  fileExtension: string;
  export(selection: ExportSelection, ctx: ExportContext): Promise<Blob>;
}

// ---------------------------------------------------------------------------
// Import review pipeline (K7)
// ---------------------------------------------------------------------------

export interface ReviewItem {
  proposed: ProposedMeasurement;
  /** Filled by normalization; undefined while the metric is unresolved. */
  resolvedMetricId?: MetricId;
  decision: 'pending' | 'accept' | 'reject';
}

export interface ImportPipeline {
  /** Normalize proposals and pair them with catalog metrics. */
  prepare(proposals: ProposedMeasurement[], ctx: ImportContext): ReviewItem[];
  /** Persist accepted items as measurements; returns their ids. Rejected items store nothing. */
  commit(items: ReviewItem[], defaults: { sourceId?: SourceId; pluginId: string }): Measurement[];
}
