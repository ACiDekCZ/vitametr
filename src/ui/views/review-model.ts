/**
 * DOM-free logic for the import review screen (K8g).
 *
 * The review screen lets the user confirm a batch of proposed measurements
 * before anything is stored. Correctness over convenience (spec §16): a
 * proposal whose metric the catalog could not resolve must be resolved by the
 * user first — it can never be accepted (and therefore never committed) while
 * unresolved. All of that decision arithmetic lives here, free of the DOM, so
 * it can be unit-tested in isolation; `review.ts` is only the glue to the DOM.
 */

import type { Catalog, ReviewItem, UnitsEngine } from '../../core/contracts';
import type { Metric, MetricId, ProfileData } from '../../core/types';
import type { ConflictChoice, ConflictGroup } from '../../core/conflicts';
import { isUnitCompatibleWithMetric } from '../../core/units';
import { hiddenMetricState, isMetricVisible } from '../../core/packs';
import { normalizeUnit } from '../../core/normalize';

/** Aggregate counts used by the header/footer of the review screen. */
export interface ReviewSummary {
  /** Every proposed row. */
  total: number;
  /** Rows whose metric resolved against the catalog. */
  resolved: number;
  /** Rows still lacking a resolved metric. */
  unresolved: number;
  /** Rows the user marked to keep. */
  accepted: number;
}

/** A row is resolved once it carries a concrete catalog metric id. */
export function isResolved(item: ReviewItem): boolean {
  return item.resolvedMetricId !== undefined;
}

/**
 * Whether a row may be accepted. An unresolved row can never be accepted —
 * the metric must be assigned or created first (spec §16: never guessed).
 */
export function canAccept(item: ReviewItem): boolean {
  return isResolved(item);
}

/** Count totals across a batch of review items. */
export function summarize(items: readonly ReviewItem[]): ReviewSummary {
  let resolved = 0;
  let accepted = 0;
  for (const item of items) {
    if (isResolved(item)) resolved += 1;
    if (item.decision === 'accept') accepted += 1;
  }
  return {
    total: items.length,
    resolved,
    unresolved: items.length - resolved,
    accepted,
  };
}

/**
 * The rows that will actually be committed: accepted *and* resolved. Excludes
 * rejected, still-pending and unresolved rows. Mirrors the pipeline's own
 * `commit` filter, so the UI can preview the exact count before persisting.
 */
export function toCommitList(items: readonly ReviewItem[]): ReviewItem[] {
  return items.filter((item) => item.decision === 'accept' && isResolved(item));
}

/** True when there is at least one accepted, resolved row to import. */
export function canCommit(items: readonly ReviewItem[]): boolean {
  return toCommitList(items).length > 0;
}

// ---------------------------------------------------------------------------
// Hidden-metric gate (offerHiddenMetrics === false)
// ---------------------------------------------------------------------------

/**
 * Downgrade any prepared item that resolved ONLY to a currently-hidden metric
 * (its providing pack inactive) back to unresolved, so it flows into the normal
 * create-new / skip path instead of being silently attached to a hidden metric.
 * This is the `offerHiddenMetrics === false` gate; the caller applies it only
 * when the setting is off (when on, review surfaces the hidden-pack row itself).
 *
 * A downgraded item loses its `resolvedMetricId`, returns to a `pending`
 * decision, and gets a `{ unresolvedName }` proposal — the name it originally
 * matched, or the metric's display name when the plugin resolved it by id/code.
 * A visible resolution is returned unchanged. Pure — no DOM, no mutation of the
 * inputs (new item objects are produced for downgraded rows).
 */
export function downgradeHiddenResolutions(
  items: readonly ReviewItem[],
  data: ProfileData,
  catalog: Catalog,
  metricName: (metric: Metric) => string,
): ReviewItem[] {
  return items.map((item) => {
    if (item.resolvedMetricId === undefined) return item;
    const metric = catalog.byId(item.resolvedMetricId);
    if (!metric || isMetricVisible(data, metric)) return item;
    const proposedMetric = item.proposed.metric;
    const name =
      typeof proposedMetric === 'object' && 'unresolvedName' in proposedMetric
        ? proposedMetric.unresolvedName
        : metricName(metric);
    return {
      ...item,
      resolvedMetricId: undefined,
      decision: 'pending',
      proposed: { ...item.proposed, metric: { unresolvedName: name } },
    };
  });
}

/**
 * Per-pack count of review rows whose resolved metric is hidden by that SAME
 * disabled pack — restricted to packs covering ≥2 rows, the threshold at which a
 * single bulk "activate the pack for all N" beats N per-row activations.
 *
 * Only resolved rows count (an unresolved row has no metric yet); a row whose
 * metric is currently visible, or hidden with no pack that would reveal it, is
 * ignored. The returned map's values are therefore all ≥2. Pure — no DOM, no
 * mutation; the caller (review view) applies the offer-hidden-metrics gate.
 */
export function hiddenPackCounts(
  items: readonly ReviewItem[],
  data: ProfileData,
  catalog: Catalog,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.resolvedMetricId === undefined) continue;
    const metric = catalog.byId(item.resolvedMetricId);
    if (!metric) continue;
    const state = hiddenMetricState(data, catalog, metric);
    if (!state.hidden || state.suggestedPackId === undefined) continue;
    counts.set(state.suggestedPackId, (counts.get(state.suggestedPackId) ?? 0) + 1);
  }
  for (const [packId, n] of [...counts]) if (n < 2) counts.delete(packId);
  return counts;
}

// ---------------------------------------------------------------------------
// Grouping many conflicts by metric + bulk resolution
// ---------------------------------------------------------------------------

/** Conflicts that share one metric, kept in their original stable order. */
export interface MetricConflictGroup {
  metricId: MetricId;
  groups: ConflictGroup[];
}

/**
 * Group conflict groups by their metric so a large reimport can be resolved a
 * metric at a time. The most-painful metric (most conflicts) comes first; ties
 * keep the metric's first-seen order, and each metric keeps its conflicts in the
 * order `detectConflicts` produced (stable, file order). Pure — no DOM.
 */
export function groupConflictsByMetric(
  groups: readonly ConflictGroup[],
): MetricConflictGroup[] {
  const byMetric = new Map<MetricId, MetricConflictGroup>();
  const ordered: MetricConflictGroup[] = [];
  for (const group of groups) {
    let bucket = byMetric.get(group.metricId);
    if (!bucket) {
      bucket = { metricId: group.metricId, groups: [] };
      byMetric.set(group.metricId, bucket);
      ordered.push(bucket);
    }
    bucket.groups.push(group);
  }
  // Stable sort by conflict count descending; ties preserve first-seen order.
  return ordered
    .map((bucket, index) => ({ bucket, index }))
    .sort((a, b) => b.bucket.groups.length - a.bucket.groups.length || a.index - b.index)
    .map(({ bucket }) => bucket);
}

/**
 * Apply one bulk choice to the still-UNDECIDED conflicts among `groupKeys`,
 * leaving any conflict the user already decided individually untouched. Mutates
 * the shared `choices` map in place (the view's persisted decision map) and
 * returns how many conflicts the bulk action changed.
 */
export function bulkDecideUndecided(
  groupKeys: readonly string[],
  choices: Map<string, ConflictChoice>,
  choice: ConflictChoice,
): number {
  let applied = 0;
  for (const key of groupKeys) {
    if (!choices.has(key)) {
      choices.set(key, choice);
      applied += 1;
    }
  }
  return applied;
}

// ---------------------------------------------------------------------------
// Metric suggestions for an unresolved row
// ---------------------------------------------------------------------------

/**
 * Case- and diacritics-insensitive fold (mirrors the catalog's normalizeName):
 * strip combining marks, lowercase, collapse whitespace.
 */
function fold(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/** Alphanumeric tokens of a folded string (drops punctuation and lone symbols). */
function tokenize(folded: string): string[] {
  return folded.split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
}

/**
 * Whether two tokens share a stem: the shorter (≥3 chars) is a prefix of the
 * longer. Prefix — not any substring — so "trombo" matches "trombocytu" but the
 * noise pair "str" ⊂ "distr" (different word start) does not.
 */
function stemMatch(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.startsWith(short);
}

/** Weights, tuned so the acceptance cases in review-model.test hold. */
const SCORE_EXACT = 100; // a candidate name equals the raw name
const SCORE_CONTAINS = 60; // one is a substring of the other
const SCORE_WHOLE_TOKEN = 35; // first shared whole token
const SCORE_WHOLE_TOKEN_EXTRA = 10; // each further shared whole token
const SCORE_PARTIAL_TOKEN = 12; // a raw token nested inside a candidate token (or vice versa)
const SCORE_PARTIAL_CAP = 2; // at most this many partial-token hits count
const SCORE_UNIT = 50; // the row's unit is dimensionally compatible with the metric
/**
 * Minimum combined score to surface a suggestion. Sits above a single
 * partial-token hit (12) — a lone weak name overlap on a unit-incompatible
 * metric is dropped — and at/below the unit bonus (50) so a unit-only match
 * still surfaces (spec §16: the unit carries the signal, never a wrong guess).
 */
const MIN_SCORE = 30;
/** Never overwhelm the card: at most this many chips, best first. */
const MAX_CHIPS = 3;

/** Best name-overlap score of the raw name against a metric's names/aliases. */
function nameScore(rawFold: string, rawTokens: readonly string[], candidates: readonly string[]): number {
  let best = 0;
  for (const raw of candidates) {
    const cf = fold(raw);
    if (cf === '') continue;
    if (cf === rawFold) {
      best = Math.max(best, SCORE_EXACT);
      continue;
    }
    if ((cf.length >= 3 && rawFold.includes(cf)) || (rawFold.length >= 3 && cf.includes(rawFold))) {
      best = Math.max(best, SCORE_CONTAINS);
      continue;
    }
    const candTokens = tokenize(cf);
    let whole = 0;
    let partial = 0;
    for (const rt of rawTokens) {
      if (candTokens.includes(rt)) {
        whole += 1;
      } else if (rt.length >= 3 && candTokens.some((ct) => stemMatch(rt, ct))) {
        partial += 1;
      }
    }
    let s = 0;
    if (whole > 0) s += SCORE_WHOLE_TOKEN + (whole - 1) * SCORE_WHOLE_TOKEN_EXTRA;
    s += Math.min(partial, SCORE_PARTIAL_CAP) * SCORE_PARTIAL_TOKEN;
    best = Math.max(best, s);
  }
  return best;
}

/**
 * Intelligent candidate metrics for an unresolved import row, ranked best-first.
 *
 * Pure and DOM-free so it can be unit-tested against the real built-in catalog.
 * The two signals are combined into a single rank:
 *  - **name/alias overlap** — the raw name (and its tokens) folded against each
 *    metric's localized display name plus every alias and its key: an exact
 *    match, a substring containment, shared whole tokens, or (weaker) a token
 *    nested inside another;
 *  - **unit compatibility** — a large bonus when the row's unit is the metric's
 *    canonical/listed unit or convertible to it (via {@link isUnitCompatibleWithMetric}).
 *
 * Never a silent guess (spec §16): a metric with no usable name overlap AND an
 * incompatible/absent unit scores below {@link MIN_SCORE} and is dropped, so a
 * weak batch yields `[]` (no chips) rather than a wrong assignment. Returns at
 * most {@link MAX_CHIPS}.
 *
 * @param rawName   the unknown analyte name from the file
 * @param unit      the parsed unit code (raw or UCUM); normalized internally
 * @param metrics   catalog metrics to rank (typically `catalog.all()`)
 * @param units     units engine, for the dimensional compatibility check
 * @param translate resolves a built-in `nameKey` to its localized display name
 */
export function suggestMetrics(
  rawName: string,
  unit: string | undefined,
  metrics: readonly Metric[],
  units: UnitsEngine,
  translate: (nameKey: string) => string,
): Metric[] {
  const rawFold = fold(rawName);
  const rawTokens = tokenize(rawFold);
  const unitCode = unit ? normalizeUnit(unit) : undefined;

  const displayName = (m: Metric): string =>
    m.customName ?? (m.nameKey ? translate(m.nameKey) : (m.key ?? ''));

  const scored: { metric: Metric; score: number; order: number }[] = [];
  metrics.forEach((metric, order) => {
    if (metric.hidden) return;
    const candidates = [displayName(metric), ...metric.aliases];
    if (metric.key) candidates.push(metric.key);
    const name = nameScore(rawFold, rawTokens, candidates);
    const unitBonus =
      unitCode !== undefined && isUnitCompatibleWithMetric(units, metric, unitCode) ? SCORE_UNIT : 0;
    const score = name + unitBonus;
    if (score >= MIN_SCORE) scored.push({ metric, score, order });
  });

  scored.sort((a, b) => (b.score - a.score) || (a.order - b.order));
  return scored.slice(0, MAX_CHIPS).map((s) => s.metric);
}
