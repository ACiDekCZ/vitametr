/**
 * Metrics management ("Veličiny") screen — DOM-free view model (redesign IA,
 * screen 2).
 *
 * Pure helpers the metrics-manage view builds on: the "used / all / custom"
 * partitioning, free-text search, the meta-line decision (count vs. "no
 * measurements"), and building a user-metric spec from the add form. No DOM, no
 * clock, no storage — everything is derived from the arguments so it can be
 * unit-tested in a node environment.
 */

import type { ExternalCodes, Metric, MetricId, ProfileData } from '../../core/types';
import { metricMatchesTag } from '../../core/tags';

// ---------------------------------------------------------------------------
// Name normalization (mirrors the catalog's / entry's case+diacritics folding)
// ---------------------------------------------------------------------------

function foldName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/** Segmented filter: metrics that have measurements, all, or user-created. */
export type MetricFilter = 'used' | 'all' | 'custom';

/** A user-created metric — one with a `customName` (matches settings' "only my own"). */
export function isCustomMetric(metric: Metric): boolean {
  return metric.customName !== undefined;
}

/** Count of measurements per metric id (empty ids are ignored). */
export function measurementCounts(
  measurements: readonly { metricId: MetricId }[],
): Map<MetricId, number> {
  const counts = new Map<MetricId, number>();
  for (const m of measurements) {
    counts.set(m.metricId, (counts.get(m.metricId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Whether a metric matches a free-text query across its key, custom name,
 * aliases and (optionally) its resolved display name. An empty query matches
 * everything.
 */
export function matchesQuery(
  metric: Metric,
  query: string,
  nameOf?: (metric: Metric) => string,
): boolean {
  const needle = foldName(query);
  if (needle === '') return true;
  const candidates = [metric.key, metric.customName, ...metric.aliases];
  if (nameOf) candidates.push(nameOf(metric));
  return candidates.some((c) => c !== undefined && foldName(c).includes(needle));
}

export interface SelectMetricsOptions {
  metrics: readonly Metric[];
  filter: MetricFilter;
  query: string;
  counts: Map<MetricId, number>;
  nameOf?: (metric: Metric) => string;
  /** When set, keep only metrics carrying this tag (combined with the rest). */
  tag?: string;
}

/**
 * Apply the segmented filter, the search query and an optional tag, preserving
 * catalog order. `used` keeps metrics with at least one measurement, `custom`
 * keeps user-created metrics, `all` keeps everything; a `tag` narrows to the
 * metrics carrying it.
 */
export function selectMetrics(opts: SelectMetricsOptions): Metric[] {
  const { metrics, filter, query, counts, nameOf, tag } = opts;
  return metrics.filter((m) => {
    if (filter === 'used' && (counts.get(m.id) ?? 0) === 0) return false;
    if (filter === 'custom' && !isCustomMetric(m)) return false;
    if (tag !== undefined && !metricMatchesTag(m, tag)) return false;
    return matchesQuery(m, query, nameOf);
  });
}

// ---------------------------------------------------------------------------
// Meta line
// ---------------------------------------------------------------------------

/**
 * The meta line under a metric name. `none` when the metric has no measurements
 * ("no measurements"); otherwise the (optional) unit and the count, which the
 * view renders as "<unit> · <N> measurements".
 */
export type MetricMeta =
  | { kind: 'none' }
  | { kind: 'counted'; unit: string | undefined; count: number };

export function metricMeta(metric: Metric, count: number): MetricMeta {
  if (count <= 0) return { kind: 'none' };
  const unit = metric.canonicalUnit ? metric.canonicalUnit : undefined;
  return { kind: 'counted', unit, count };
}

// ---------------------------------------------------------------------------
// New user metric (the header "+" add form)
// ---------------------------------------------------------------------------

export type NewMetricValueType = 'number' | 'text' | 'enum' | 'multi';

export interface NewMetricInput {
  name: string;
  valueType: NewMetricValueType;
  /** For a number metric — its (optional) unit. */
  unit?: string;
  /** For an enum/multi metric — comma-separated allowed values. */
  enumValues?: string;
  /**
   * Extra recognised names. Either a comma-separated string (legacy) or an
   * already-split list (the chip editor produces this).
   */
  aliases?: string | string[];
  /**
   * Tags — a comma-separated string (legacy) or an already-split list of
   * seeded ids / free-text labels (the chip editor produces this).
   */
  tags?: string | string[];
  /** Optional LOINC code — kept only when it looks like `\d+-\d`. */
  loinc?: string;
  /** Optional generic external code system label (kept only paired with a code). */
  codeSystem?: string;
  /** Optional generic external code value (kept only paired with a system). */
  codeValue?: string;
  /**
   * Optional list of generic external code pairs (the chip editor produces
   * this). Merged with the single `codeSystem`/`codeValue` pair when both are
   * given; a pair is kept only when both halves are non-empty.
   */
  codePairs?: { system: string; code: string }[];
}

/** Split a comma-separated string or normalize an already-split list. */
function splitList(raw: string | string[] | undefined): string[] {
  const parts = Array.isArray(raw) ? raw : (raw ?? '').split(',');
  return parts.map((v) => v.trim()).filter((v) => v !== '');
}

/**
 * Build the optional metadata common to every value type: tags (trimmed,
 * empties dropped) and external codes (a valid LOINC and/or one generic
 * system+code pair). Each field is included only when it carries data, so the
 * created metric stays as sparse as one built by the detail editor.
 */
function buildMetadata(input: NewMetricInput): Pick<Metric, 'tags' | 'externalCodes'> {
  const meta: Pick<Metric, 'tags' | 'externalCodes'> = {};

  const tags = splitList(input.tags);
  if (tags.length > 0) meta.tags = tags;

  const codes: ExternalCodes = {};
  const loinc = (input.loinc ?? '').trim();
  // Keep a LOINC only when it looks like `\d+-\d`; an invalid one is ignored
  // (the dialog also flags it inline) rather than failing the whole create.
  if (loinc !== '' && /^\d+-\d$/.test(loinc)) codes.loinc = loinc;

  // Generic pairs: the chip-editor list plus the single system/value fallback.
  // Each pair is kept only when both halves are filled.
  const pairs: { system: string; code: string }[] = [];
  for (const p of input.codePairs ?? []) {
    const system = p.system.trim();
    const code = p.code.trim();
    if (system !== '' && code !== '') pairs.push({ system, code });
  }
  const soleSystem = (input.codeSystem ?? '').trim();
  const soleCode = (input.codeValue ?? '').trim();
  if (soleSystem !== '' && soleCode !== '') pairs.push({ system: soleSystem, code: soleCode });
  if (pairs.length > 0) codes.other = pairs;

  if (codes.loinc !== undefined || codes.other !== undefined) meta.externalCodes = codes;

  return meta;
}

/**
 * Build the `addUserMetric` spec from the add-metric form, or undefined when the
 * name is blank. Mirrors the entry screen's new-metric rules: the metric's own
 * name is always its first alias; a text/enum/multi metric carries no unit.
 * Optional tags and external codes (LOINC / one generic pair) are attached when
 * present, matching what the metric detail lets the user edit afterwards.
 */
export function buildUserMetricSpec(input: NewMetricInput): Omit<Metric, 'id'> | undefined {
  const name = input.name.trim();
  if (name === '') return undefined;
  const aliases = [name, ...splitList(input.aliases)];
  const meta = buildMetadata(input);

  if (input.valueType === 'enum' || input.valueType === 'multi') {
    return {
      customName: name,
      aliases,
      category: 'custom',
      valueType: input.valueType,
      enumValues: splitList(input.enumValues),
      canonicalUnit: '',
      units: [],
      ...meta,
    };
  }
  if (input.valueType === 'text') {
    return {
      customName: name,
      aliases,
      category: 'custom',
      valueType: 'text',
      canonicalUnit: '',
      units: [],
      ...meta,
    };
  }
  const unit = (input.unit ?? '').trim();
  return {
    customName: name,
    aliases,
    category: 'custom',
    valueType: 'number',
    canonicalUnit: unit,
    units: unit ? [unit] : [],
    ...meta,
  };
}

// ---------------------------------------------------------------------------
// Metrics (hide / show)
// ---------------------------------------------------------------------------

/**
 * Apply a hide/show toggle to a metric inside ProfileData. To be called from
 * within `ctx.mutate`. For a user metric (already present in `data.metrics`)
 * the flag is set in place; for a built-in without an override yet, a
 * field-by-field override is appended (mirroring the catalog's own convention
 * in `learnAlias`).
 */
export function applyMetricHidden(data: ProfileData, metric: Metric, hidden: boolean): void {
  const existing = data.metrics.find((m) => m.id === metric.id);
  if (existing) {
    existing.hidden = hidden;
    return;
  }
  // Copy the aliases array too: a shallow `{ ...metric }` would share the
  // built-in's seed `aliases` reference, so a later `learnAlias` on this
  // override would silently mutate the seed and its new alias would then be
  // filtered out of `customAliases`.
  data.metrics.push({ ...metric, aliases: [...metric.aliases], hidden });
}

// ---------------------------------------------------------------------------
// Metrics (remove) — guarded by usage
// ---------------------------------------------------------------------------

/** How many stored measurements reference a metric (its removal guard). */
export function metricUsageCount(
  measurements: readonly { metricId: MetricId }[],
  metricId: MetricId,
): number {
  let count = 0;
  for (const m of measurements) if (m.metricId === metricId) count += 1;
  return count;
}

/**
 * A metric is removable only when nothing references it. A metric that is used
 * somewhere must not vanish silently — the user deletes its measurements first.
 */
export function isMetricRemovable(usageCount: number): boolean {
  return usageCount === 0;
}

/** Whether a metric comes from the built-in seed (vs. a user-created one). */
export function isBuiltinMetric(metric: Metric): boolean {
  return metric.id.startsWith('builtin:');
}

/**
 * Remove a metric from ProfileData. To be called from within `ctx.mutate`, and
 * only for a metric with zero measurements (the caller guards this) — so NO
 * measurement deletion happens here. A built-in is switched off by adding its
 * id to `disabledMetrics` (deduped) and dropping any override entry (learned
 * aliases / tags / hidden) it may have; a user/custom metric is deleted from
 * `data.metrics` outright.
 */
export function applyMetricRemoval(data: ProfileData, metric: Metric): void {
  if (isBuiltinMetric(metric)) {
    if (!data.disabledMetrics) data.disabledMetrics = [];
    if (!data.disabledMetrics.includes(metric.id)) data.disabledMetrics.push(metric.id);
  }
  // Drop the profile entry — the user metric itself, or a built-in's override.
  data.metrics = data.metrics.filter((m) => m.id !== metric.id);
}
