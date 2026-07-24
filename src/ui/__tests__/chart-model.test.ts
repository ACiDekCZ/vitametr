import { describe, expect, it } from 'vitest';
import {
  buildChartModel,
  niceTicks,
  scaleLinear,
  timeTicks,
  type ChartConfig,
  type ChartPoint,
} from '../chart-model';

const DAY = 86_400_000;

const config: ChartConfig = {
  width: 400,
  height: 200,
  padding: { top: 10, right: 10, bottom: 20, left: 40 },
  unitLabel: 'mmol/l',
};

// A helper: every tick array must bracket its domain and hit the count target.
function assertCovers(ticks: number[], min: number, max: number): void {
  expect(ticks.length).toBeGreaterThan(0);
  expect(ticks[0]).toBeLessThanOrEqual(min);
  expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(max);
}

describe('niceTicks', () => {
  it('covers a sub-unit range (0.1–0.2) with a sensible count', () => {
    const ticks = niceTicks(0.1, 0.2, 5);
    assertCovers(ticks, 0.1, 0.2);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(8);
  });

  it('covers a mid range (3.5–7.8) landing on round steps', () => {
    const ticks = niceTicks(3.5, 7.8, 5);
    assertCovers(ticks, 3.5, 7.8);
    expect(ticks).toContain(4);
    expect(ticks).toContain(7);
    expect(ticks.length).toBeLessThanOrEqual(8);
  });

  it('covers a large range (100–450)', () => {
    const ticks = niceTicks(100, 450, 5);
    assertCovers(ticks, 100, 450);
    expect(ticks).toEqual([100, 200, 300, 400, 500]);
  });

  it('produces evenly spaced ticks', () => {
    const ticks = niceTicks(3.5, 7.8, 5);
    const step = ticks[1] - ticks[0];
    for (let i = 1; i < ticks.length; i += 1) {
      expect(ticks[i] - ticks[i - 1]).toBeCloseTo(step, 9);
    }
  });

  it('never contains floating-point noise', () => {
    const ticks = niceTicks(0.1, 0.2, 5);
    for (const t of ticks) {
      // Rounded to the step's precision — no 0.30000000000004.
      expect(t).toBeCloseTo(Number(t.toFixed(6)), 12);
    }
  });

  it('handles a degenerate equal domain without throwing', () => {
    const ticks = niceTicks(5, 5, 5);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks[0]).toBeLessThanOrEqual(5);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(5);
  });
});

describe('timeTicks', () => {
  it('uses day granularity for a 10-day span', () => {
    const { granularity, ticks } = timeTicks(0, 10 * DAY);
    expect(granularity).toBe('day');
    expect(ticks.length).toBeGreaterThanOrEqual(4);
    expect(ticks.length).toBeLessThanOrEqual(7);
  });

  it('uses month granularity for an 8-month span', () => {
    const { granularity, ticks } = timeTicks(0, Math.round(8 * 30.44 * DAY));
    expect(granularity).toBe('month');
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(8);
  });

  it('uses year granularity for a 5-year span', () => {
    const { granularity, ticks } = timeTicks(0, Math.round(5 * 365.25 * DAY));
    expect(granularity).toBe('year');
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(8);
  });

  it('keeps ticks inside the span, ascending', () => {
    const { ticks } = timeTicks(0, 10 * DAY);
    for (let i = 1; i < ticks.length; i += 1) {
      expect(ticks[i]).toBeGreaterThan(ticks[i - 1]);
    }
    expect(ticks[0]).toBeGreaterThanOrEqual(0);
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(10 * DAY);
  });
});

describe('scaleLinear', () => {
  it('maps domain endpoints to range endpoints', () => {
    const s = scaleLinear([0, 10], [100, 300]);
    expect(s(0)).toBeCloseTo(100, 9);
    expect(s(10)).toBeCloseTo(300, 9);
    expect(s(5)).toBeCloseTo(200, 9);
  });

  it('is monotonic', () => {
    const s = scaleLinear([2, 8], [0, 600]);
    let prev = -Infinity;
    for (let x = 2; x <= 8; x += 0.5) {
      const y = s(x);
      expect(y).toBeGreaterThan(prev);
      prev = y;
    }
  });

  it('supports an inverted range (SVG y grows downward)', () => {
    const s = scaleLinear([0, 10], [200, 0]);
    expect(s(0)).toBeCloseTo(200, 9);
    expect(s(10)).toBeCloseTo(0, 9);
  });

  it('maps a zero-width domain to the range midpoint', () => {
    const s = scaleLinear([5, 5], [0, 100]);
    expect(s(5)).toBeCloseTo(50, 9);
    expect(s(999)).toBeCloseTo(50, 9);
  });
});

describe('buildChartModel', () => {
  it('returns an empty, non-throwing model for an empty series', () => {
    const model = buildChartModel([], config);
    expect(model.isEmpty).toBe(true);
    expect(model.count).toBe(0);
    expect(model.points).toEqual([]);
    expect(model.polyline).toBe('');
    expect(model.bands).toEqual([]);
  });

  it('gives a single point a synthetic ±1 day span, centered', () => {
    const t = 1_000 * DAY;
    const model = buildChartModel([{ t, value: 5 }], config);
    expect(model.isEmpty).toBe(false);
    expect(model.count).toBe(1);
    expect(model.xDomain).toEqual([t - DAY, t + DAY]);
    // Centered horizontally within the plot area.
    const p = model.points[0];
    expect(p.cx).toBeCloseTo(config.padding.left + (config.width - 50) / 2, 6);
  });

  it('uses a shared timeDomain override for aligned small multiples', () => {
    const t0 = 1_000 * DAY;
    const shared: [number, number] = [t0 - 10 * DAY, t0 + 10 * DAY];
    const model = buildChartModel(
      [
        { t: t0, value: 5 },
        { t: t0 + DAY, value: 6 },
      ],
      { ...config, timeDomain: shared },
    );
    expect(model.xDomain).toEqual(shared);
  });

  it('ignores an inverted/zero timeDomain and falls back to the series span', () => {
    const t0 = 1_000 * DAY;
    const model = buildChartModel(
      [
        { t: t0, value: 5 },
        { t: t0 + 4 * DAY, value: 6 },
      ],
      { ...config, timeDomain: [t0 + 4 * DAY, t0] },
    );
    expect(model.xDomain).toEqual([t0, t0 + 4 * DAY]);
  });

  it('flags out-of-range points and carries operator (censored) points', () => {
    const t0 = 0;
    const points: ChartPoint[] = [
      { t: t0, value: 5, refLow: 3, refHigh: 6 }, // in range
      { t: t0 + DAY, value: 9, refLow: 3, refHigh: 6 }, // above
      { t: t0 + 2 * DAY, value: 1, refLow: 3, refHigh: 6, operator: '<' }, // below + censored
    ];
    const model = buildChartModel(points, config);
    expect(model.points[0].outOfRange).toBe(false);
    expect(model.points[0].rangePosition).toBe('in-range');
    expect(model.points[1].outOfRange).toBe(true);
    expect(model.points[1].rangePosition).toBe('above');
    expect(model.points[2].outOfRange).toBe(true);
    expect(model.points[2].rangePosition).toBe('below');
    expect(model.points[2].operator).toBe('<');
  });

  it('steps the band when bounds change and merges contiguous equal-bound segments', () => {
    const points: ChartPoint[] = [
      { t: 0, value: 5, refLow: 3, refHigh: 6 },
      { t: DAY, value: 5, refLow: 4, refHigh: 7 }, // range changed here → new segment
      { t: 2 * DAY, value: 5, refLow: 4, refHigh: 7 }, // same range → merged with prev
    ];
    const model = buildChartModel(points, config);
    // Two visual segments: 3–6, then the merged 4–7 (no seam within it).
    expect(model.bands.length).toBe(2);

    // First segment ends at the point where the range changed.
    expect(model.bands[0].x + model.bands[0].width).toBeCloseTo(model.points[1].cx, 6);
    expect(model.bands[0].refLow).toBe(3);
    expect(model.bands[0].refHigh).toBe(6);

    // Merged second segment carries the changed range and forward-fills to the edge.
    expect(model.bands[1].refLow).toBe(4);
    expect(model.bands[1].refHigh).toBe(7);
    expect(model.bands[1].x).toBeCloseTo(model.points[1].cx, 6);
    expect(model.bands[1].x + model.bands[1].width).toBeCloseTo(
      model.plot.x + model.plot.width,
      6,
    );
  });

  it('renders one seamless band when the range is constant', () => {
    const points: ChartPoint[] = [
      { t: 0, value: 5, refLow: 3.9, refHigh: 5.6 },
      { t: DAY, value: 6, refLow: 3.9, refHigh: 5.6 },
      { t: 2 * DAY, value: 5, refLow: 3.9, refHigh: 5.6 },
    ];
    const model = buildChartModel(points, config);
    expect(model.bands.length).toBe(1);
    expect(model.bands[0].x).toBeCloseTo(model.plot.x, 6);
    expect(model.bands[0].x + model.bands[0].width).toBeCloseTo(
      model.plot.x + model.plot.width,
      6,
    );
  });

  it('omits band segments for measurements without both bounds', () => {
    const points: ChartPoint[] = [
      { t: 0, value: 5, refLow: 3, refHigh: 6 },
      { t: DAY, value: 5 }, // no bounds → no segment
      { t: 2 * DAY, value: 5, refHigh: 6 }, // one-sided → no segment
    ];
    const model = buildChartModel(points, config);
    expect(model.bands.length).toBe(1);
    expect(model.bands[0].refLow).toBe(3);
  });

  it('produces a polyline whose coordinates match the point scales', () => {
    const points: ChartPoint[] = [
      { t: 0, value: 4 },
      { t: DAY, value: 6 },
      { t: 2 * DAY, value: 5 },
    ];
    const model = buildChartModel(points, config);
    const coords = model.polyline.split(' ').map((pair) => pair.split(',').map(Number));
    expect(coords.length).toBe(3);
    for (let i = 0; i < coords.length; i += 1) {
      expect(coords[i][0]).toBeCloseTo(model.points[i].cx, 2);
      expect(coords[i][1]).toBeCloseTo(model.points[i].cy, 2);
    }
    // Endpoints sit on the plot's horizontal extremes.
    expect(coords[0][0]).toBeCloseTo(model.plot.x, 2);
    expect(coords[coords.length - 1][0]).toBeCloseTo(model.plot.x + model.plot.width, 2);
  });

  it('sorts unordered input ascending by time before drawing', () => {
    const points: ChartPoint[] = [
      { t: 2 * DAY, value: 5 },
      { t: 0, value: 4 },
      { t: DAY, value: 6 },
    ];
    const model = buildChartModel(points, config);
    expect(model.points.map((p) => p.t)).toEqual([0, DAY, 2 * DAY]);
  });

  it('includes value and both bounds in the Y domain', () => {
    const points: ChartPoint[] = [{ t: 0, value: 5, refLow: 2, refHigh: 12 }];
    const model = buildChartModel(points, config);
    expect(model.yDomain[0]).toBeLessThanOrEqual(2);
    expect(model.yDomain[1]).toBeGreaterThanOrEqual(12);
  });
});
