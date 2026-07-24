/**
 * Chart model (K8e, pure layer) — no DOM, no clock, no i18n.
 *
 * Turns an already unit-converted time series into ready-to-render geometry:
 * linear scales, "nice" axis ticks, a polyline path, stepwise reference-range
 * band segments and per-point flags (out-of-range, censored operator). Every
 * function here is deterministic and unit-testable in isolation (spec §1, §7).
 *
 * The caller (the view) converts measurements — values AND reference bounds —
 * into the display unit before building points; this layer never converts and
 * never reads the wall clock (timestamps arrive as milliseconds).
 */

import type { Operator } from '../core/types';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** One data point, already expressed in the display unit (spec §2). */
export interface ChartPoint {
  /** Instant as milliseconds (Date.parse(takenAt)); the pure layer never reads clocks. */
  t: number;
  value: number;
  /** Present for censored results (`<`, `>`, `<=`, `>=`) — drawn differently. */
  operator?: Operator;
  /** Reference bounds in the SAME unit as `value`. */
  refLow?: number;
  refHigh?: number;
}

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ChartConfig {
  width: number;
  height: number;
  padding: Padding;
  /** Y-axis unit label (display symbol), supplied by the view. */
  unitLabel: string;
  /**
   * Optional fixed time (x) domain [minMs, maxMs]. When set, the chart uses it
   * instead of the series' own min/max — so several small-multiple charts can
   * share one aligned time axis for comparison. Points outside the domain still
   * plot (clamped by the linear scale); a zero/inverted domain is ignored.
   */
  timeDomain?: [number, number];
}

export interface PlotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type RangePosition = 'below' | 'in-range' | 'above' | 'unknown';

export interface ChartModelPoint {
  t: number;
  value: number;
  /** Pixel coordinates within the SVG. */
  cx: number;
  cy: number;
  operator?: Operator;
  /** Value lies outside its own stated reference range. */
  outOfRange: boolean;
  rangePosition: RangePosition;
  refLow?: number;
  refHigh?: number;
}

/** A rectangular reference-band segment (stepwise; both bounds required). */
export interface BandSegment {
  x: number;
  y: number;
  width: number;
  height: number;
  refLow: number;
  refHigh: number;
}

export interface AxisTick {
  /** Raw value: milliseconds for X, the numeric value for Y. */
  value: number;
  /** Pixel position along the axis. */
  pos: number;
}

export type TimeGranularity = 'day' | 'month' | 'year';

export interface ChartModel {
  width: number;
  height: number;
  plot: PlotRect;
  unitLabel: string;
  /** True when there is nothing to draw (no points). */
  isEmpty: boolean;
  count: number;
  points: ChartModelPoint[];
  /** SVG polyline `points` string: "x,y x,y …" in ascending time order. */
  polyline: string;
  bands: BandSegment[];
  xTicks: AxisTick[];
  yTicks: AxisTick[];
  xTickGranularity: TimeGranularity;
  xDomain: [number, number];
  yDomain: [number, number];
  /** Value of the newest point, for accessible summaries. */
  lastValue?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const AVG_MONTH_MS = 30.436_875 * DAY_MS;
const YEAR_MS = 365.2425 * DAY_MS;

// ---------------------------------------------------------------------------
// niceTicks — "nice" 1-2-5 × 10ⁿ ticks covering [min, max] (spec §3)
// ---------------------------------------------------------------------------

/** Nearest "nice" number (1, 2, 5 × 10ⁿ) to `value`. */
function niceNum(value: number, round: boolean): number {
  if (value <= 0) return 0;
  const exp = Math.floor(Math.log10(value));
  const frac = value / 10 ** exp;
  let niceFrac: number;
  if (round) {
    if (frac < 1.5) niceFrac = 1;
    else if (frac < 3) niceFrac = 2;
    else if (frac < 7) niceFrac = 5;
    else niceFrac = 10;
  } else if (frac <= 1) niceFrac = 1;
  else if (frac <= 2) niceFrac = 2;
  else if (frac <= 5) niceFrac = 5;
  else niceFrac = 10;
  return niceFrac * 10 ** exp;
}

/** Round to the decimal precision implied by `step`, killing FP noise. */
function roundToStep(value: number, step: number): number {
  if (step <= 0 || !Number.isFinite(step)) return value;
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return Number(value.toFixed(Math.min(decimals, 12)));
}

/**
 * Evenly spaced "nice" ticks spanning [min, max]. The returned array always
 * covers the domain (first ≤ min, last ≥ max) and aims for ~`count` ticks.
 */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  let lo = Math.min(min, max);
  let hi = Math.max(min, max);
  if (lo === hi) {
    const pad = Math.abs(lo) > 0 ? Math.abs(lo) : 1;
    lo -= pad;
    hi += pad;
  }
  const targetCount = Math.max(2, count);
  const range = niceNum(hi - lo, false);
  const step = niceNum(range / (targetCount - 1), true);
  const niceMin = Math.floor(lo / step) * step;
  const niceMax = Math.ceil(hi / step) * step;

  const ticks: number[] = [];
  // Guard against runaway loops from degenerate steps.
  const guard = targetCount * 8 + 8;
  for (let v = niceMin, i = 0; v <= niceMax + step * 0.5 && i < guard; v += step, i += 1) {
    ticks.push(roundToStep(v, step));
  }
  return ticks;
}

// ---------------------------------------------------------------------------
// timeTicks — calendar-aware ticks (days / months / years) (spec §3)
// ---------------------------------------------------------------------------

export interface TimeTicks {
  granularity: TimeGranularity;
  ticks: number[];
}

/** Smallest candidate step whose resulting count fits under `maxCount`. */
function pickStep(span: number, candidates: readonly number[], maxCount = 7): number {
  for (const step of candidates) {
    if (span / step <= maxCount) return step;
  }
  return candidates[candidates.length - 1];
}

function dayTicks(minMs: number, maxMs: number): number[] {
  const spanDays = (maxMs - minMs) / DAY_MS;
  const step = pickStep(spanDays, [1, 2, 5, 7, 14, 30]);
  const stepMs = step * DAY_MS;
  const start = Math.ceil(minMs / stepMs) * stepMs;
  const ticks: number[] = [];
  for (let v = start; v <= maxMs + 1; v += stepMs) ticks.push(v);
  return ticks;
}

function calendarTicks(
  minMs: number,
  maxMs: number,
  stepMonths: number,
): number[] {
  const first = new Date(minMs);
  let year = first.getFullYear();
  let month = first.getMonth();
  // Advance to the first month boundary at or after minMs.
  if (new Date(year, month, 1).getTime() < minMs) {
    month += 1;
  }
  // Snap the month index onto a clean multiple of the step.
  const total = year * 12 + month;
  const snapped = Math.ceil(total / stepMonths) * stepMonths;
  year = Math.floor(snapped / 12);
  month = snapped % 12;

  const ticks: number[] = [];
  let guard = 0;
  for (
    let ms = new Date(year, month, 1).getTime();
    ms <= maxMs && guard < 512;
    guard += 1
  ) {
    ticks.push(ms);
    month += stepMonths;
    while (month >= 12) {
      month -= 12;
      year += 1;
    }
    ms = new Date(year, month, 1).getTime();
  }
  return ticks;
}

/**
 * Calendar-aware ticks for a time span. Granularity is chosen from the span
 * (days → months → years) targeting 4–7 ticks; timestamps are milliseconds.
 */
export function timeTicks(minMs: number, maxMs: number): TimeTicks {
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs) || maxMs <= minMs) {
    return { granularity: 'day', ticks: minMs === maxMs ? [minMs] : [] };
  }
  const spanDays = (maxMs - minMs) / DAY_MS;

  if (spanDays <= 70) {
    return { granularity: 'day', ticks: dayTicks(minMs, maxMs) };
  }
  if (spanDays <= 3 * 365) {
    const spanMonths = (maxMs - minMs) / AVG_MONTH_MS;
    const step = pickStep(spanMonths, [1, 2, 3, 6]);
    return { granularity: 'month', ticks: calendarTicks(minMs, maxMs, step) };
  }
  const spanYears = (maxMs - minMs) / YEAR_MS;
  const step = pickStep(spanYears, [1, 2, 5, 10, 20, 50]);
  return { granularity: 'year', ticks: calendarTicks(minMs, maxMs, step * 12) };
}

// ---------------------------------------------------------------------------
// scaleLinear (spec §3)
// ---------------------------------------------------------------------------

/**
 * Linear map from `domain` to `range`. Endpoints map to endpoints; the mapping
 * is monotonic. A zero-width domain maps everything to the range midpoint.
 */
export function scaleLinear(
  domain: [number, number],
  range: [number, number],
): (x: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  if (span === 0) {
    const mid = (r0 + r1) / 2;
    return () => mid;
  }
  return (x: number) => r0 + ((x - d0) / span) * (r1 - r0);
}

// ---------------------------------------------------------------------------
// buildChartModel (spec §3, §4)
// ---------------------------------------------------------------------------

function rangePositionOf(value: number, refLow?: number, refHigh?: number): RangePosition {
  if (refLow === undefined && refHigh === undefined) return 'unknown';
  if (refLow !== undefined && value < refLow) return 'below';
  if (refHigh !== undefined && value > refHigh) return 'above';
  return 'in-range';
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

/**
 * Build a renderable model from converted points and a layout config.
 * Handles: empty series (empty model, no throw), a single point (synthetic
 * ±1 day span so it is not glued to the edge), stepwise reference-range bands
 * (each measurement's range holds forward until the next), out-of-range flags
 * and censored (operator) points carried through untouched.
 */
export function buildChartModel(points: ChartPoint[], config: ChartConfig): ChartModel {
  const { width, height, padding, unitLabel } = config;
  const plot: PlotRect = {
    x: padding.left,
    y: padding.top,
    width: Math.max(0, width - padding.left - padding.right),
    height: Math.max(0, height - padding.top - padding.bottom),
  };

  const empty: ChartModel = {
    width,
    height,
    plot,
    unitLabel,
    isEmpty: true,
    count: 0,
    points: [],
    polyline: '',
    bands: [],
    xTicks: [],
    yTicks: [],
    xTickGranularity: 'day',
    xDomain: [0, 0],
    yDomain: [0, 0],
  };

  if (points.length === 0) return empty;

  // Defensive ascending sort by time (the view sorts, but do not rely on it).
  const sorted = [...points].sort((a, b) => a.t - b.t);

  // --- X domain (time) --------------------------------------------------
  let minT = sorted[0].t;
  let maxT = sorted[sorted.length - 1].t;
  // A caller-supplied shared domain (small multiples) overrides the series' own.
  if (config.timeDomain && config.timeDomain[1] > config.timeDomain[0]) {
    [minT, maxT] = config.timeDomain;
  } else if (minT === maxT) {
    // Single point (or all identical instants): synthetic ±1 day span.
    minT -= DAY_MS;
    maxT += DAY_MS;
  }
  const xDomain: [number, number] = [minT, maxT];

  // --- Y domain (value + reference bounds), padded ~8% each side --------
  const yValues: number[] = [];
  for (const p of sorted) {
    yValues.push(p.value);
    if (p.refLow !== undefined) yValues.push(p.refLow);
    if (p.refHigh !== undefined) yValues.push(p.refHigh);
  }
  let dataMin = Math.min(...yValues);
  let dataMax = Math.max(...yValues);
  if (dataMin === dataMax) {
    const d = Math.abs(dataMin) > 0 ? Math.abs(dataMin) : 1;
    dataMin -= d;
    dataMax += d;
  }
  const yPad = (dataMax - dataMin) * 0.08;
  const yDomain: [number, number] = [dataMin - yPad, dataMax + yPad];

  const scaleX = scaleLinear(xDomain, [plot.x, plot.x + plot.width]);
  // Y is inverted: larger values sit higher (smaller pixel y).
  const scaleY = scaleLinear(yDomain, [plot.y + plot.height, plot.y]);

  // --- Points -----------------------------------------------------------
  const modelPoints: ChartModelPoint[] = sorted.map((p) => {
    const position = rangePositionOf(p.value, p.refLow, p.refHigh);
    return {
      t: p.t,
      value: p.value,
      cx: scaleX(p.t),
      cy: scaleY(p.value),
      operator: p.operator,
      outOfRange: position === 'below' || position === 'above',
      rangePosition: position,
      refLow: p.refLow,
      refHigh: p.refHigh,
    };
  });

  // --- Polyline (all points connected, ascending time) ------------------
  const polyline = modelPoints.map((p) => `${p.cx.toFixed(2)},${p.cy.toFixed(2)}`).join(' ');

  // --- Stepwise reference-range bands -----------------------------------
  // Each measurement's range holds forward until the next point. The first
  // point extends its band back to the axis, the last one forward to the edge.
  const plotRight = plot.x + plot.width;
  const plotBottom = plot.y + plot.height;
  const bands: BandSegment[] = [];
  for (let i = 0; i < modelPoints.length; i += 1) {
    const p = modelPoints[i];
    if (p.refLow === undefined || p.refHigh === undefined) continue;
    const xStart = i === 0 ? plot.x : p.cx;
    const xEnd = i < modelPoints.length - 1 ? modelPoints[i + 1].cx : plotRight;
    const yTop = clamp(scaleY(p.refHigh), plot.y, plotBottom);
    const yBottom = clamp(scaleY(p.refLow), plot.y, plotBottom);
    // Merge with the previous segment when the bounds are unchanged and the
    // segments are contiguous — one seamless rect instead of stitched steps.
    const prev = bands[bands.length - 1];
    if (
      prev !== undefined &&
      prev.refLow === p.refLow &&
      prev.refHigh === p.refHigh &&
      Math.abs(prev.x + prev.width - xStart) < 0.5
    ) {
      prev.width = Math.max(0, xEnd - prev.x);
      continue;
    }
    bands.push({
      x: xStart,
      y: yTop,
      width: Math.max(0, xEnd - xStart),
      height: Math.max(0, yBottom - yTop),
      refLow: p.refLow,
      refHigh: p.refHigh,
    });
  }

  // --- Axis ticks -------------------------------------------------------
  const xt = timeTicks(xDomain[0], xDomain[1]);
  const xTicks: AxisTick[] = xt.ticks
    .filter((v) => v >= xDomain[0] - 1 && v <= xDomain[1] + 1)
    .map((v) => ({ value: v, pos: scaleX(v) }));

  const yTicks: AxisTick[] = niceTicks(dataMin, dataMax, 5)
    .filter((v) => v >= yDomain[0] && v <= yDomain[1])
    .map((v) => ({ value: v, pos: scaleY(v) }));

  return {
    width,
    height,
    plot,
    unitLabel,
    isEmpty: false,
    count: modelPoints.length,
    points: modelPoints,
    polyline,
    bands,
    xTicks,
    yTicks,
    xTickGranularity: xt.granularity,
    xDomain,
    yDomain,
    lastValue: modelPoints[modelPoints.length - 1].value,
  };
}
