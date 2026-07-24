/**
 * Metric catalog (K4): the built-in seed merged with a profile's own metrics.
 *
 * `profileData.metrics` holds two kinds of entries (design doc §3.1):
 *  - **user metrics** — generated `user:<id>`, shown as-is;
 *  - **overrides of built-ins** — same `builtin:<key>` id as a seed metric,
 *    carrying learned aliases / hidden flag / external codes. These are merged
 *    field-by-field on top of the seed so a later app update that adds seed
 *    attributes still reaches the user (§3.2).
 *
 * `addUserMetric` and `learnAlias` persist by mutating `profileData.metrics`
 * directly; the surrounding store layer (K5b) is responsible for scheduling
 * the debounced write.
 */

import type { Catalog } from './contracts';
import type { Metric, MetricId, ProfileData } from './types';
import { BUILTIN_METRICS } from './catalog-data';
import { visibleMetrics } from './packs';
import { normalizeWatchedTags } from './tags';

/** Case- and diacritics-insensitive key for name/alias comparison. */
function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritical marks
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/** Union of alias lists, de-duplicated by normalized form, first spelling wins. */
function dedupeAliases(aliases: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const alias of aliases) {
    const key = normalizeName(alias);
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(alias);
    }
  }
  return out;
}

/** Merge a profile override on top of its built-in base. */
function mergeMetric(base: Metric, override: Metric): Metric {
  const externalCodes =
    base.externalCodes || override.externalCodes
      ? {
          loinc: override.externalCodes?.loinc ?? base.externalCodes?.loinc,
          // Replace semantics: an override's list (written by the codes editor)
          // fully supersedes the seed; otherwise the seed codes survive.
          other: override.externalCodes?.other ?? base.externalCodes?.other,
        }
      : undefined;
  return {
    ...base,
    ...override,
    aliases: dedupeAliases([...base.aliases, ...override.aliases]),
    // Tags use replace semantics: an override's tag list (written by the tag
    // editor) fully supersedes the seed; otherwise the seed tags survive.
    tags: override.tags ?? base.tags,
    externalCodes,
  };
}

/** De-duplicate tag ids, preserving first-seen order (exact match — tags are ids). */
function dedupeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

export function createCatalog(profileData: ProfileData): Catalog {
  const builtinById = new Map<MetricId, Metric>(BUILTIN_METRICS.map((m) => [m.id, m]));

  /**
   * Fresh, unique user-metric id. Deterministic (no Math.random / Date.now):
   * a monotonically increasing counter seeded from the highest `user:<n>`
   * already present in the profile, recomputed on each call so concurrent
   * external additions cannot collide.
   */
  function generateId(): MetricId {
    let max = 0;
    for (const m of profileData.metrics) {
      const match = /^user:(\d+)$/.exec(m.id);
      if (match) max = Math.max(max, Number(match[1]));
    }
    return `user:${max + 1}` as MetricId;
  }

  /**
   * The UNFILTERED catalog: every built-in (merged with its override) followed
   * by the user's own metrics. Resolution runs over this — a hidden/disabled
   * metric STILL resolves (`byKey`/`byLoinc`/`resolveAlias`), so an import can
   * always find it and offer to reveal its pack. Pack-driven VISIBILITY is a
   * separate layer (see {@link visible}); it never removes anything here.
   */
  function computeAll(): Metric[] {
    const overrides = new Map<MetricId, Metric>();
    const userMetrics: Metric[] = [];
    for (const m of profileData.metrics) {
      if (builtinById.has(m.id)) overrides.set(m.id, m);
      else userMetrics.push(m);
    }
    const merged = BUILTIN_METRICS.map((base) => {
      const override = overrides.get(base.id);
      return override ? mergeMetric(base, override) : base;
    });
    return [...merged, ...userMetrics];
  }

  function all(): Metric[] {
    return computeAll();
  }

  /**
   * The metrics to SHOW the user (overview, metrics list, tag filters, pickers
   * of tracked metrics): the pack-driven visibility subset of {@link all}. A
   * metric is visible when it is a user metric, has ≥1 measurement, or is a
   * built-in provided by an active pack — minus explicit hides, plus forced
   * shows. See `core/packs.ts` for the exact predicate.
   */
  function visible(): Metric[] {
    return visibleMetrics(profileData, computeAll());
  }

  function byId(id: MetricId): Metric | undefined {
    return computeAll().find((m) => m.id === id);
  }

  function byKey(key: string): Metric | undefined {
    return computeAll().find((m) => m.key === key);
  }

  function byLoinc(code: string): Metric | undefined {
    const needle = code.trim();
    if (!needle) return undefined;
    return computeAll().find((m) => m.externalCodes?.loinc === needle);
  }

  /**
   * Lookup by an additional external code — symmetric to {@link byLoinc},
   * forward-looking for code-based import mapping. Matches a user-added
   * `externalCodes.other` pair by exact system + code. These codes are
   * user-entered/local only (never seeded).
   */
  function byExternalCode(system: string, code: string): Metric | undefined {
    const sys = system.trim();
    const c = code.trim();
    if (!sys || !c) return undefined;
    return computeAll().find((m) =>
      m.externalCodes?.other?.some((p) => p.system === sys && p.code === c),
    );
  }

  function resolveAlias(name: string): Metric | undefined {
    const needle = normalizeName(name);
    if (!needle) return undefined;
    const nameMatches = (metric: Metric): boolean => {
      const candidates = [...metric.aliases];
      if (metric.key) candidates.push(metric.key);
      if (metric.customName) candidates.push(metric.customName);
      return candidates.some((c) => normalizeName(c) === needle);
    };
    // A user's OWN metric wins over a built-in on a name match: scan the custom
    // (non-`builtin:`) metrics first, so a metric re-created via "create as your
    // own" catches future imports of that name instead of re-matching the
    // built-in (which would re-trigger the hidden-pack flow). Merged built-in
    // overrides keep resolving as built-ins (their id stays `builtin:<key>`).
    const all = computeAll();
    for (const metric of all) if (!metric.id.startsWith('builtin:') && nameMatches(metric)) return metric;
    for (const metric of all) if (metric.id.startsWith('builtin:') && nameMatches(metric)) return metric;
    return undefined;
  }

  function addUserMetric(spec: Omit<Metric, 'id'>): Metric {
    const metric: Metric = { ...spec, id: generateId() };
    profileData.metrics.push(metric);
    return metric;
  }

  function learnAlias(id: MetricId, alias: string): void {
    const trimmed = alias.trim();
    if (!trimmed) return;
    const needle = normalizeName(trimmed);

    // Existing profile entry (user metric or an already-created override).
    const existing = profileData.metrics.find((m) => m.id === id);
    if (existing) {
      if (!existing.aliases.some((a) => normalizeName(a) === needle)) {
        existing.aliases.push(trimmed);
      }
      return;
    }

    // First learned alias for a built-in: create an override entry.
    const base = builtinById.get(id);
    if (!base) return; // unknown metric — nothing to learn
    if (base.aliases.some((a) => normalizeName(a) === needle)) return; // already known
    profileData.metrics.push({ ...base, aliases: [...base.aliases, trimmed] });
  }

  /** Remove a learned/custom alias. Built-in seed aliases stay (they re-merge). */
  function unlearnAlias(id: MetricId, alias: string): void {
    const needle = normalizeName(alias);
    const existing = profileData.metrics.find((m) => m.id === id);
    if (!existing) return;
    existing.aliases = existing.aliases.filter((a) => normalizeName(a) !== needle);
  }

  /**
   * The aliases a user may edit for a metric: everything for a custom metric;
   * for a built-in, the ones learned on top of the compiled seed.
   */
  function customAliases(id: MetricId): string[] {
    const existing = profileData.metrics.find((m) => m.id === id);
    if (!existing) return [];
    const base = builtinById.get(id);
    if (!base) return [...existing.aliases]; // custom metric — all editable
    const seed = new Set(base.aliases.map((a) => normalizeName(a)));
    return existing.aliases.filter((a) => !seed.has(normalizeName(a)));
  }

  /**
   * Replace a metric's tags. For a user metric (or an existing built-in
   * override) the tags are set in place; for a built-in without an override yet
   * a field-by-field override entry is appended (mirroring learnAlias), so the
   * change survives a reload.
   */
  function setMetricTags(id: MetricId, tags: readonly string[]): void {
    // Canonicalize the watched tag first (collapse the builtin id + any raw
    // "Sledované"/"Watched" duplicate into one), then de-dup exact repeats.
    const cleaned = dedupeTags(normalizeWatchedTags(tags));
    const existing = profileData.metrics.find((m) => m.id === id);
    if (existing) {
      existing.tags = cleaned;
      return;
    }
    const base = builtinById.get(id);
    if (!base) return; // unknown metric — nothing to tag
    profileData.metrics.push({ ...base, aliases: [...base.aliases], tags: cleaned });
  }

  /**
   * Set a metric's external codes — the special-cased LOINC plus the generic,
   * code-system-agnostic `other` list — persisting into ProfileData. Mirrors
   * setMetricTags/learnAlias: for a built-in without an override yet a
   * field-by-field override entry is appended, so edits to built-ins survive a
   * reload. The passed object is the full desired state (replace semantics):
   * inputs are trimmed, `other` pairs with an empty system or code are dropped,
   * an empty LOINC clears it, and when nothing remains the whole
   * `externalCodes` is dropped from the override.
   *
   * Note: because {@link mergeMetric} uses replace-with-fallback semantics
   * (`override ?? base`), clearing the LOINC of a BUILT-IN reverts to the seed
   * LOINC rather than emptying it — user metrics and the never-seeded `other`
   * list clear cleanly. This is the intended merge behaviour.
   */
  function setExternalCodes(
    id: MetricId,
    codes: { loinc?: string; other?: { system: string; code: string }[] },
  ): void {
    const loinc = codes.loinc?.trim() || undefined;
    const other = (codes.other ?? [])
      .map((p) => ({ system: p.system.trim(), code: p.code.trim() }))
      .filter((p) => p.system !== '' && p.code !== '');
    const external: Metric['externalCodes'] =
      loinc === undefined && other.length === 0
        ? undefined
        : {
            ...(loinc !== undefined ? { loinc } : {}),
            ...(other.length > 0 ? { other } : {}),
          };

    const existing = profileData.metrics.find((m) => m.id === id);
    if (existing) {
      existing.externalCodes = external;
      return;
    }
    const base = builtinById.get(id);
    if (!base) return; // unknown metric — nothing to set
    profileData.metrics.push({ ...base, aliases: [...base.aliases], externalCodes: external });
  }

  function addTag(id: MetricId, tag: string): void {
    const trimmed = tag.trim();
    if (!trimmed) return;
    const current = byId(id)?.tags ?? [];
    if (current.includes(trimmed)) return;
    setMetricTags(id, [...current, trimmed]);
  }

  function removeTag(id: MetricId, tag: string): void {
    const current = byId(id)?.tags ?? [];
    if (!current.includes(tag)) return;
    setMetricTags(
      id,
      current.filter((t) => t !== tag),
    );
  }

  return {
    all,
    visible,
    byId,
    byKey,
    byLoinc,
    byExternalCode,
    resolveAlias,
    addUserMetric,
    learnAlias,
    unlearnAlias,
    customAliases,
    setMetricTags,
    setExternalCodes,
    addTag,
    removeTag,
  };
}
