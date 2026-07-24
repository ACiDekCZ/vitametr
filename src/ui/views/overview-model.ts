/**
 * Overview screen (K8d) — DOM-free view model.
 *
 * Pure functions that turn a metric plus its measurements into a plain data
 * shape the view can render without any further domain reasoning. No DOM, no
 * i18n, no clock: the caller supplies "now" as an ISO string and translates
 * the returned keys/params itself. All unit-aware work goes through the
 * injected `UnitsEngine`; range and delta reasoning is delegated to the
 * dependency-free `series` helpers so this module stays a thin adapter.
 */

import type { UnitsEngine } from '../../core/contracts';
import type {
  Measurement,
  Metric,
  MetricId,
  Operator,
  ProfileSettings,
  UnitSystem,
} from '../../core/types';
import type { Locale } from '../../i18n/index';
import { ageDays, delta, latest, measurementText, previous, rangePosition, seriesFor } from '../../core/series';
import { OTHER_TAG, WATCHED_TAG, orderTags, primaryTag } from '../../core/tags';
import { endOfDayMs } from '../../core/snapshot';
import { metricMatchesQuery } from './export-model';

/** Direction of the latest change relative to the previous measurement. */
export type DeltaKind = 'up' | 'down' | 'same' | 'none';

/** Position of the latest value against its own stated reference range. */
export type RangeState = 'below' | 'in-range' | 'above' | 'unknown';

/** A numeric value paired with the unit it is expressed in (display-time). */
export interface OverviewValue {
  /** Rounded to the metric's display precision for `unitCode`. Absent for text. */
  value?: number;
  /** Qualitative value (e.g. "negativní") for a text metric. */
  textValue?: string;
  /** UCUM code the value is expressed in (the effective display unit). */
  unitCode?: string;
  /** Present for censored results such as `< 0.1`. */
  operator?: Operator;
}

/** Everything the view needs to render one metric card — data only. */
export interface OverviewCardModel {
  metricId: MetricId;
  /** i18n key for a built-in metric name (exactly one of nameKey/customName). */
  nameKey?: string;
  /** Free-text name for a user-defined metric. */
  customName?: string;
  /** Entry group of the metric, e.g. 'blood-pressure' (for grouping in the view). */
  entryGroup?: string;
  /** Whether the user hid this metric from the overview. */
  hidden: boolean;
  /** Latest measurement, converted to the display unit where possible. */
  value: OverviewValue;
  deltaKind: DeltaKind;
  /** Absolute magnitude of the change; present only for 'up'/'down'. */
  deltaAmount?: OverviewValue;
  rangeState: RangeState;
  /** Convenience flag: the latest value is above or below its range. */
  outOfRange: boolean;
  /** Whole days between the latest measurement and `nowIso`. */
  ageDays: number;
  /**
   * The measurement series as plain numbers in the effective display unit,
   * ascending by time — ready to feed to `sparklinePath` (the view slices the
   * tail it wants). Non-convertible points keep their raw value.
   */
  series: number[];
  /** Latest reference bounds, converted into the effective display unit. */
  refLow?: number;
  refHigh?: number;
}

/**
 * The metric's preferred display unit for the active unit system, or `undefined`
 * when the metric states none for it (the caller then uses the canonical unit).
 *
 * The catalog seed maps `preferredUnitByLocale.cs` ≈ SI/metric (mmol/L, kg, °C, …)
 * and `.en` ≈ US/conventional (mg/dL, lb, °F, …). So an explicit unit system reads
 * the corresponding preference — 'si' → `cs`, 'us' → `en` — while 'auto' (or an
 * absent system) follows the UI locale, preserving today's behavior. Only a unit
 * the metric actually supports is returned; a metric without any preference (e.g.
 * TSH `mIU/L`) yields `undefined` for every system, falling to canonical.
 *
 * Shared by {@link resolveDisplayUnit} (overview/compare/report/metric detail)
 * and the entry view's default-unit logic so both agree.
 */
export function preferredUnitFor(
  metric: Metric,
  unitSystem: UnitSystem | undefined,
  locale: Locale,
): string | undefined {
  const key = unitSystem === 'si' ? 'cs' : unitSystem === 'us' ? 'en' : locale;
  const preferred = metric.preferredUnitByLocale?.[key];
  return preferred !== undefined && metric.units.includes(preferred) ? preferred : undefined;
}

/**
 * Resolve the unit a metric should be displayed in — governed solely by the
 * global unit system. Precedence:
 *  (a) the metric's preferred unit for the active {@link ProfileSettings.unitSystem}
 *      ('si'/'us'), falling to canonical when the metric states none for it;
 *  (b) otherwise ('auto' or absent) the locale preference, then canonical.
 * See {@link preferredUnitFor} for the SI/US ↔ cs/en mapping. There is no
 * per-metric override — every value-showing view resolves the same way.
 */
export function resolveDisplayUnit(
  metric: Metric,
  settings: ProfileSettings,
  locale: Locale,
): string {
  return preferredUnitFor(metric, settings.unitSystem, locale) ?? metric.canonicalUnit;
}

/**
 * Build the view model for one metric card, or `undefined` when the metric has
 * no measurements (the view skips such metrics). `displayUnit` is the already
 * resolved preferred unit (see `resolveDisplayUnit`); when the latest value
 * cannot be converted into it, the measurement's own unit is used instead so a
 * value is always shown. `locale` is accepted for signature completeness — the
 * display unit it influences is resolved by the caller.
 */
export function buildOverviewCard(
  metric: Metric,
  measurements: Measurement[],
  units: UnitsEngine,
  locale: Locale,
  displayUnit: string,
  nowIso: string,
): OverviewCardModel | undefined {
  void locale; // display unit already resolved by the caller
  const series = seriesFor(measurements, metric.id);
  const last = latest(series);
  if (last === undefined) return undefined;

  // A text (qualitative) metric: the card shows the latest string — no unit,
  // sparkline, delta or range.
  if (last.value === undefined) {
    return {
      metricId: metric.id,
      nameKey: metric.nameKey,
      customName: metric.customName,
      entryGroup: metric.entryGroup,
      hidden: metric.hidden ?? false,
      value: { textValue: measurementText(last) },
      deltaKind: 'none',
      rangeState: 'unknown',
      outOfRange: false,
      ageDays: ageDays(last, nowIso),
      series: [],
    };
  }

  // Effective display unit: the requested one when the latest value converts,
  // otherwise the measurement's own unit (never hide a value behind a gap).
  const converted = units.convert(last.value, last.unit, displayUnit, metric);
  const effectiveUnit = converted.ok ? displayUnit : last.unit;
  const rawValue = converted.ok ? converted.value : last.value;

  const value: OverviewValue = {
    value: units.round(rawValue, effectiveUnit, metric),
    unitCode: effectiveUnit,
    operator: last.operator,
  };

  const { deltaKind, deltaAmount } = buildDelta(series, units, metric, effectiveUnit);

  const rangeState = rangePosition(last);

  // Series in the effective display unit (for the sparkline). A point that
  // cannot be converted keeps its raw value so the series length is preserved.
  const numericSeries = series
    .filter((mm): mm is Measurement & { value: number } => mm.value !== undefined)
    .map((mm) => {
      const c = units.convert(mm.value, mm.unit, effectiveUnit, metric);
      return c.ok ? c.value : mm.value;
    });

  // Reference bounds of the latest point, converted into the effective unit so
  // they line up with the shown value for the range-bar.
  const refLow = convertRef(last.refLow, last.unit, effectiveUnit, units, metric);
  const refHigh = convertRef(last.refHigh, last.unit, effectiveUnit, units, metric);

  return {
    metricId: metric.id,
    nameKey: metric.nameKey,
    customName: metric.customName,
    entryGroup: metric.entryGroup,
    hidden: metric.hidden ?? false,
    value,
    deltaKind,
    deltaAmount,
    rangeState,
    outOfRange: rangeState === 'above' || rangeState === 'below',
    ageDays: ageDays(last, nowIso),
    series: numericSeries,
    refLow,
    refHigh,
  };
}

/** Convert a reference bound into `toUnit`; returns the raw bound when it cannot. */
function convertRef(
  bound: number | undefined,
  fromUnit: string,
  toUnit: string,
  units: UnitsEngine,
  metric: Metric,
): number | undefined {
  if (bound === undefined) return undefined;
  if (fromUnit === toUnit) return bound;
  const c = units.convert(bound, fromUnit, toUnit, metric);
  return c.ok ? c.value : bound;
}

/**
 * Direction and magnitude of the latest change. Direction comes from the
 * unit-aware `series.delta`; the displayed magnitude is recomputed in the
 * effective display unit (so it matches the shown value) and never derived by
 * converting a raw difference — affine offsets would distort that.
 */
function buildDelta(
  series: Measurement[],
  units: UnitsEngine,
  metric: Metric,
  effectiveUnit: string,
): { deltaKind: DeltaKind; deltaAmount?: OverviewValue } {
  const d = delta(series, units, metric);
  if (!d.ok) return { deltaKind: 'none' };

  const deltaKind: DeltaKind = d.absolute > 0 ? 'up' : d.absolute < 0 ? 'down' : 'same';
  if (deltaKind === 'same') return { deltaKind };

  const curr = latest(series);
  const prev = previous(series);
  let magnitude = Math.abs(d.absolute);
  let amountUnit = curr?.unit ?? effectiveUnit;

  if (
    curr !== undefined &&
    prev !== undefined &&
    curr.value !== undefined &&
    prev.value !== undefined
  ) {
    const currConv = units.convert(curr.value, curr.unit, effectiveUnit, metric);
    const prevConv = units.convert(prev.value, prev.unit, effectiveUnit, metric);
    if (currConv.ok && prevConv.ok) {
      magnitude = Math.abs(currConv.value - prevConv.value);
      amountUnit = effectiveUnit;
    }
  }

  return {
    deltaKind,
    deltaAmount: { value: units.round(magnitude, amountUnit, metric), unitCode: amountUnit },
  };
}

/**
 * One overview entry: a metric that has at least one measurement overall, paired
 * with the card model for the reference date. `model` is `undefined` when the
 * metric has NO measurement at or before the reference date — a time-travel
 * "empty at that date" placeholder, kept in the set (not dropped) so the metric
 * still appears, muted.
 */
export interface OverviewEntryModel {
  metric: Metric;
  /** Card model at the reference date, or `undefined` = no value at that date. */
  model: OverviewCardModel | undefined;
  /** Whether the user hid this metric from the overview. */
  hidden: boolean;
}

/**
 * Build the overview entry set: one entry per metric that has ANY measurement
 * (membership is decided against the full history, so a metric never vanishes),
 * with each card model computed against the measurements at or before `asOfIso`.
 *
 * In live mode (`asOfIso` omitted) every member yields a defined model. In
 * time-travel mode the day-inclusive cutoff (shared with the export/report
 * snapshot via {@link endOfDayMs}) is applied: a metric whose only measurements
 * are AFTER the date yields `model: undefined` (an empty placeholder). `nowIso`
 * drives the age / delta reasoning and is the chosen date in time-travel mode.
 * Order follows the input `metrics`. Pure — no DOM, no clock.
 */
export function buildOverviewEntries(
  metrics: readonly Metric[],
  measurements: readonly Measurement[],
  units: UnitsEngine,
  settings: ProfileSettings,
  locale: Locale,
  nowIso: string,
  asOfIso?: string,
): OverviewEntryModel[] {
  const cutoff = asOfIso !== undefined ? endOfDayMs(asOfIso) : undefined;
  const cardMeasurements: Measurement[] =
    cutoff === undefined || Number.isNaN(cutoff)
      ? [...measurements]
      : measurements.filter((m) => {
          const t = Date.parse(m.takenAt);
          return !Number.isNaN(t) && t <= cutoff;
        });

  const entries: OverviewEntryModel[] = [];
  for (const metric of metrics) {
    if (seriesFor([...measurements], metric.id).length === 0) continue;
    const displayUnit = resolveDisplayUnit(metric, settings, locale);
    const model = buildOverviewCard(metric, cardMeasurements, units, locale, displayUnit, nowIso);
    entries.push({ metric, model, hidden: metric.hidden ?? false });
  }
  return entries;
}

/**
 * The reference range as a single display string, given a number formatter
 * (kept injectable so this stays i18n-free and unit-testable). Two-sided →
 * `4.0–5.8`; lower-only → `≥ 4.0`; upper-only → `≤ 5.8`; neither bound → `—`.
 * Bounds are assumed already in the value's display unit (see `buildOverviewCard`,
 * which converts them alongside the value).
 */
export function formatRange(
  refLow: number | undefined,
  refHigh: number | undefined,
  fmt: (n: number) => string,
): string {
  const hasLow = refLow !== undefined;
  const hasHigh = refHigh !== undefined;
  if (hasLow && hasHigh) return `${fmt(refLow)}–${fmt(refHigh)}`;
  if (hasLow) return `≥ ${fmt(refLow)}`;
  if (hasHigh) return `≤ ${fmt(refHigh)}`;
  return '—';
}

// ---------------------------------------------------------------------------
// Overview layout + filtering / grouping (pure, DOM-free)
// ---------------------------------------------------------------------------

/** How the overview lays out its metrics: a card grid or a dense list. */
export type OverviewLayout = 'grid' | 'list';

/**
 * The layout used when the profile has no saved {@link ProfileSettings.overviewLayout}:
 * the card grid at every width (desktop and phone alike). The dense list is an
 * opt-in the user picks explicitly; a saved choice overrides this at both widths.
 */
export function defaultLayout(): OverviewLayout {
  return 'grid';
}

/** The minimum shape the filter/group helpers need from an overview entry. */
export interface FilterableEntry {
  /** Resolved display name, for the search filter. */
  name: string;
  /** The metric's tags, for the tag filter and primary-tag grouping. */
  tags: readonly string[];
}

/** Active filter state of the overview toolbar (ephemeral, never persisted). */
export interface OverviewFilter {
  /** Free-text query matched against the entry name (empty → matches all). */
  query: string;
  /** Selected tag, or `undefined` for "all tags". */
  activeTag: string | undefined;
}

/**
 * Filter the overview entries by the search query (case/diacritics-insensitive
 * substring of the name) and the active tag. Order is preserved. Pure.
 */
export function filterOverviewEntries<T extends FilterableEntry>(
  entries: readonly T[],
  filter: OverviewFilter,
): T[] {
  return entries.filter(
    (e) =>
      (filter.activeTag === undefined || e.tags.includes(filter.activeTag)) &&
      metricMatchesQuery(e.name, filter.query),
  );
}

/**
 * Whether the overview toolbar is currently filtering the set — a non-empty
 * search query and/or a selected tag. Pure; shared by the view to decide whether
 * the "Summary / print" button offers the filtered-subset choice.
 */
export function isOverviewFiltered(filter: OverviewFilter): boolean {
  return filter.query.trim() !== '' || filter.activeTag !== undefined;
}

/**
 * How to label the print subset: a lone tag filter (no text query) is named by
 * that tag; anything else (a text query, or a query combined with a tag) is a
 * generic "selection of {n} metrics". Pure and i18n-free — the caller resolves
 * the tag's localized name or the pluralized count. `count` is the number of
 * currently filtered metrics.
 */
export type SubsetLabelSpec =
  | { kind: 'tag'; tag: string }
  | { kind: 'count'; count: number };

export function subsetLabelSpec(filter: OverviewFilter, count: number): SubsetLabelSpec {
  if (filter.activeTag !== undefined && filter.query.trim() === '') {
    return { kind: 'tag', tag: filter.activeTag };
  }
  return { kind: 'count', count };
}

/** One rendered block of entries: a tag heading (or `null` for a flat block). */
export interface OverviewGroup<T> {
  /** Tag id for the section heading, or `null` when the block is heading-less. */
  tag: string | null;
  entries: T[];
}

/**
 * Split the (already filtered) entries into ordered blocks. When tags are on and
 * no single tag is selected, group by {@link primaryTag} under the fixed group
 * order; otherwise return one flat, heading-less block. With `allTags`, an entry
 * is instead bucketed under EVERY tag it carries (untagged entries fall into
 * {@link OTHER_TAG}), so a multi-tag metric appears in several sections. Within a
 * block the input order is preserved, so switching grid↔list never reorders
 * items.
 *
 * Special case (both modes): every watched entry additionally forms a single
 * {@link WATCHED_TAG} group placed FIRST, while STILL appearing in its normal
 * category group(s) — the star is a cross-cutting favorite, not a re-categorization.
 * Under an active tag filter there is no watched group (the flat block wins). Pure.
 */
export function groupOverviewEntries<T extends FilterableEntry>(
  entries: readonly T[],
  opts: { useTags: boolean; activeTag: string | undefined; allTags?: boolean },
): OverviewGroup<T>[] {
  if (!opts.useTags || opts.activeTag !== undefined) {
    return [{ tag: null, entries: [...entries] }];
  }
  const groups = new Map<string, T[]>();
  const push = (key: string, e: T): void => {
    const bucket = groups.get(key);
    if (bucket) bucket.push(e);
    else groups.set(key, [e]);
  };
  for (const e of entries) {
    if (opts.allTags) {
      const tags = e.tags && e.tags.length > 0 ? e.tags : [OTHER_TAG];
      for (const tag of tags) push(tag, e);
    } else {
      push(primaryTag(e.tags), e);
    }
  }
  // Rebuild the watched group deterministically from ALL watched entries (in
  // allTags mode a WATCHED_TAG bucket may already have formed) and drop it from
  // the category ordering so it is emitted exactly once, first.
  groups.delete(WATCHED_TAG);
  const ordered = orderTags(groups.keys()).map((tag) => ({ tag, entries: groups.get(tag) ?? [] }));
  const watched = entries.filter((e) => e.tags.includes(WATCHED_TAG));
  return watched.length > 0 ? [{ tag: WATCHED_TAG, entries: [...watched] }, ...ordered] : ordered;
}

// ---------------------------------------------------------------------------
// Sparkline geometry (pure, DOM-free) — the view turns this into an <svg>.
// ---------------------------------------------------------------------------

/** A sparkline as an SVG points string plus the coordinates of its end dot. */
export interface Sparkline {
  /** Space-separated `x,y` pairs for an SVG <polyline points="…">. */
  points: string;
  /** The final point, for drawing the end marker. */
  last: { x: number; y: number };
}

/**
 * Map a value series onto a `w`×`h` box as SVG coordinates. Values run left to
 * right; higher values sit higher (smaller y). The vertical extent is scaled to
 * the series' own min/max; a flat series is centred. Returns `undefined` when
 * there are fewer than two points (nothing meaningful to draw). Pure geometry —
 * no colour, no DOM.
 */
export function sparklinePath(
  values: number[],
  w: number,
  h: number,
  pad = 4,
): Sparkline | undefined {
  const n = values.length;
  if (n < 2) return undefined;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const flat = max === min;
  const range = flat ? 1 : max - min;
  const innerW = w - pad * 2;
  const innerH = h - pad * 2;

  const pts: string[] = [];
  let last = { x: pad, y: h / 2 };
  for (let i = 0; i < n; i += 1) {
    const x = round2(pad + (i / (n - 1)) * innerW);
    const y = round2(flat ? pad + innerH / 2 : pad + (1 - (values[i] - min) / range) * innerH);
    pts.push(`${x},${y}`);
    last = { x, y };
  }
  return { points: pts.join(' '), last };
}

// ---------------------------------------------------------------------------
// Range-bar geometry (pure, DOM-free) — zones + marker as percentages.
// ---------------------------------------------------------------------------

/** Zone boundaries and marker position for the range-bar, all as 0–100 %. */
export interface RangeBar {
  /** below-range zone is [0, belowEnd]; in-range [belowEnd, aboveStart]. */
  zonePercents: { belowEnd: number; aboveStart: number };
  /** Clamped position of the value along the track. */
  markerPercent: number;
}

const LOW_ANCHOR = 25; // where refLow sits on the track (%)
const HIGH_ANCHOR = 75; // where refHigh sits on the track (%)

/**
 * Position a value on a range-bar whose track shows below/in/above zones. With
 * both bounds the in-range band is centred (below 0–25 %, above 75–100 %); a
 * one-sided range drops the missing zone and anchors its bound at 25 % (lower)
 * or 75 % (upper). The marker is clamped to the track. Returns `undefined` when
 * there is no reference range at all (the view then omits the range row).
 */
export function rangeBarPosition(
  value: number,
  refLow: number | undefined,
  refHigh: number | undefined,
): RangeBar | undefined {
  const hasLow = refLow !== undefined;
  const hasHigh = refHigh !== undefined;
  if (!hasLow && !hasHigh) return undefined;

  let domainLow: number;
  let domainHigh: number;
  let belowEnd: number;
  let aboveStart: number;

  if (hasLow && hasHigh) {
    let span = refHigh! - refLow!;
    if (!(span > 0)) span = Math.abs(refHigh!) * 0.1 || 1;
    const pad = span * 0.5;
    domainLow = refLow! - pad;
    domainHigh = refHigh! + pad;
    belowEnd = pct(refLow!, domainLow, domainHigh);
    aboveStart = pct(refHigh!, domainLow, domainHigh);
  } else if (hasHigh) {
    domainLow = 0;
    domainHigh = refHigh! / (HIGH_ANCHOR / 100);
    if (!(domainHigh > domainLow)) domainHigh = refHigh! + (Math.abs(refHigh!) || 1);
    belowEnd = 0;
    aboveStart = HIGH_ANCHOR;
  } else {
    domainLow = 0;
    domainHigh = refLow! / (LOW_ANCHOR / 100);
    if (!(domainHigh > domainLow)) domainHigh = refLow! + (Math.abs(refLow!) || 1);
    belowEnd = LOW_ANCHOR;
    aboveStart = 100;
  }

  return {
    zonePercents: { belowEnd: round1(belowEnd), aboveStart: round1(aboveStart) },
    markerPercent: round1(clamp(pct(value, domainLow, domainHigh), 0, 100)),
  };
}

function pct(v: number, lo: number, hi: number): number {
  return hi === lo ? 50 : ((v - lo) / (hi - lo)) * 100;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
