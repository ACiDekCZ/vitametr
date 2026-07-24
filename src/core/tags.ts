/**
 * Metric tags (phase 1) — the seeded vocabulary plus the pure helpers the UI
 * builds on. Tags are cross-cutting, multi-valued grouping labels: a metric may
 * carry a specimen tag (blood / urine / stool / vitals) and one or more clinical
 * panel tags (cbc, lipids, liver, …). Seeded ids are stable kebab keys with an
 * i18n label (`tag.<id>`); a user-added tag is a raw string shown verbatim.
 *
 * No DOM, no storage, no clock — everything here is a pure function of its
 * arguments so it can be unit-tested in a node environment. The only import is a
 * type-only reference to `StringKey` for the translate callback signature.
 */

import type { Metric } from './types';
import type { StringKey } from '../i18n/index';

/** Translate callback the view passes in (matches `AppContext.t`). */
type Translate = (key: StringKey, params?: Record<string, string | number>) => string;

/**
 * Specimen tags — where the sample comes from. `vitals` is the specimen-level
 * bucket for home/body measurements (no biological specimen).
 */
export const SPECIMEN_TAGS = ['blood', 'urine', 'stool', 'vitals'] as const;

/** Clinical panel tags — what the analyte belongs to functionally. */
export const PANEL_TAGS = [
  'cbc',
  'biochemistry',
  'lipids',
  'liver',
  'kidney',
  'thyroid',
  'diabetes',
  'vitamins',
  'iron',
  'tumor-markers',
  'hormones',
  // Category tags introduced with the bundled packs (see core/packs-data.ts).
  // The seed carries no metric with these tags; activating the matching pack
  // creates the metrics that populate the group.
  'cardiac',
  'coagulation',
  'bone',
] as const;

/** Every seeded tag id (specimen + panel), the pickable vocabulary. */
export const SEEDED_TAG_IDS: readonly string[] = [...PANEL_TAGS, ...SPECIMEN_TAGS];

/** The catch-all group for metrics without any tag. */
export const OTHER_TAG = 'other';

/**
 * Reserved "watched" (favorites) tag. It is a LABELLED tag (`tag.watched`) with a
 * star quick-toggle, but it is deliberately NOT a panel/specimen tag: it must
 * never become a metric's PRIMARY category. It groups first everywhere (see
 * {@link GROUP_ORDER}) yet a watched metric still appears in its category too.
 */
export const WATCHED_TAG = 'builtin:watched';

/** Its i18n label lives under a clean key, not `tag.builtin:watched`. */
const WATCHED_LABEL_KEY = 'tag.watched' as StringKey;

/**
 * Raw string tags (any locale / casing) that MEAN the watched tag. A user tag
 * spelled "Sledované"/"Watched" is canonicalized to {@link WATCHED_TAG} on write
 * so it never duplicates the builtin. These are the localized display strings —
 * a fixed, closed vocabulary — used only for dedup, never to translate storage.
 */
const WATCHED_ALIASES = new Set<string>(['sledované', 'sledovane', 'watched']);

/** Whether a raw tag string denotes the watched tag (the builtin id or an alias). */
export function isWatchedAlias(tag: string): boolean {
  return tag === WATCHED_TAG || WATCHED_ALIASES.has(tag.trim().toLowerCase());
}

/**
 * Collapse any watched-denoting tags (the builtin id or a raw "Sledované"/
 * "Watched" duplicate) into a single canonical {@link WATCHED_TAG}, preserving
 * the position of the first watched tag and all other tags. Idempotent.
 */
export function normalizeWatchedTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  let placed = false;
  for (const tag of tags) {
    if (isWatchedAlias(tag)) {
      if (!placed) {
        out.push(WATCHED_TAG);
        placed = true;
      }
      continue;
    }
    out.push(tag);
  }
  return out;
}

/** Whether a metric is watched (carries {@link WATCHED_TAG}). */
export function isWatched(metric: Pick<Metric, 'tags'>): boolean {
  return metricMatchesTag(metric, WATCHED_TAG);
}

/** Tag ids that carry an i18n label (`tag.<id>`): the seed plus the "other" group. */
const LABELLED_TAGS = new Set<string>([...SEEDED_TAG_IDS, OTHER_TAG, WATCHED_TAG]);

const SPECIMEN_SET = new Set<string>(SPECIMEN_TAGS);
const PANEL_SET = new Set<string>(PANEL_TAGS);

/**
 * Fixed display order for tag groups (panels first, then specimens, then the
 * catch-all). Custom tags that are not in this list sort just before "other".
 */
export const GROUP_ORDER: readonly string[] = [
  // "Watched" always ranks first — its group and its filter chip lead the list.
  WATCHED_TAG,
  'cbc',
  'lipids',
  'liver',
  'kidney',
  'thyroid',
  'diabetes',
  'vitamins',
  'iron',
  'hormones',
  'tumor-markers',
  'biochemistry',
  'cardiac',
  'coagulation',
  'bone',
  'blood',
  'urine',
  'stool',
  'vitals',
  OTHER_TAG,
];

/** True for a seeded (label-bearing) tag id; false for a user-added custom tag. */
export function isSeededTag(tag: string): boolean {
  return SEEDED_TAG_IDS.includes(tag);
}

/**
 * Display label for a tag: the localized `tag.<id>` string for a known id,
 * otherwise the raw tag string (custom tags are shown verbatim).
 */
export function tagLabel(tag: string, t: Translate): string {
  if (tag === WATCHED_TAG) return t(WATCHED_LABEL_KEY);
  return LABELLED_TAGS.has(tag) ? t(('tag.' + tag) as StringKey) : tag;
}

/**
 * The primary tag used to place a metric into exactly one overview section:
 * its first PANEL tag if any, else its specimen tag, else its first (custom)
 * tag, else the "other" group.
 */
export function primaryTag(tags: readonly string[] | undefined): string {
  if (!tags || tags.length === 0) return OTHER_TAG;
  const panel = tags.find((t) => PANEL_SET.has(t));
  if (panel !== undefined) return panel;
  const specimen = tags.find((t) => SPECIMEN_SET.has(t));
  if (specimen !== undefined) return specimen;
  // The watched tag is never a metric's primary category (it groups separately).
  const custom = tags.find((t) => t !== WATCHED_TAG);
  return custom ?? OTHER_TAG;
}

/** Filter predicate: whether a metric carries a given tag. */
export function metricMatchesTag(metric: Pick<Metric, 'tags'>, tag: string): boolean {
  return (metric.tags ?? []).includes(tag);
}

/** Sort rank of a tag for group ordering; custom tags sit just before "other". */
function tagRank(tag: string): number {
  const i = GROUP_ORDER.indexOf(tag);
  if (i !== -1) return i;
  return GROUP_ORDER.indexOf(OTHER_TAG) - 0.5; // custom tags before the catch-all
}

/** Order a set of tags by the fixed group order (custom tags alpha, before "other"). */
export function orderTags(tags: Iterable<string>): string[] {
  return [...tags].sort((a, b) => {
    const d = tagRank(a) - tagRank(b);
    return d !== 0 ? d : a.localeCompare(b);
  });
}

/** The union of tags present across the given metrics, in group order. */
export function usedTags(metrics: readonly Pick<Metric, 'tags'>[]): string[] {
  const set = new Set<string>();
  for (const m of metrics) for (const tag of m.tags ?? []) set.add(tag);
  return orderTags(set);
}
