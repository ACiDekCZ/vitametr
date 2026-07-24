import { describe, expect, it } from 'vitest';

import {
  ageDays,
  delta,
  duplicateCandidates,
  groupByEvent,
  latest,
  mixedUnits,
  previous,
  rangePosition,
  seriesFor,
  trend,
} from '../series.js';
import { createUnitsEngine } from '../units.js';
import type {
  Measurement,
  MeasurementId,
  Metric,
  MetricId,
  Operator,
  ProfileId,
  SourceId,
} from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const engine = createUnitsEngine();

function metric(
  partial: Partial<Metric> & Pick<Metric, 'canonicalUnit' | 'units'>,
): Metric {
  return {
    id: 'builtin:test' as MetricId,
    aliases: [],
    category: 'lab',
    valueType: 'number',
    ...partial,
  };
}

const glucose = metric({
  id: 'builtin:glucose' as MetricId,
  canonicalUnit: 'mmol/L',
  units: ['mmol/L', 'mg/dL'],
  molarMass: 180.16,
  precision: { 'mmol/L': 2, 'mg/dL': 0 },
});

const GLUCOSE_ID = glucose.id;
const OTHER_ID = 'builtin:other' as MetricId;

let seq = 0;

function m(partial: {
  metricId?: MetricId;
  value: number;
  unit?: string;
  takenAt: string;
  operator?: Operator;
  refLow?: number;
  refHigh?: number;
  sourceId?: SourceId;
}): Measurement {
  seq += 1;
  return {
    id: `meas-${seq}` as MeasurementId,
    profileId: 'p1' as ProfileId,
    metricId: partial.metricId ?? GLUCOSE_ID,
    value: partial.value,
    operator: partial.operator,
    unit: partial.unit ?? 'mmol/L',
    takenAt: partial.takenAt,
    timePrecision: 'datetime',
    refLow: partial.refLow,
    refHigh: partial.refHigh,
    sourceId: partial.sourceId,
    status: 'confirmed',
    origin: { pluginId: 'manual' },
    createdAt: partial.takenAt,
    modifiedAt: partial.takenAt,
  };
}

// ---------------------------------------------------------------------------
// seriesFor
// ---------------------------------------------------------------------------

describe('seriesFor', () => {
  it('filters by metric and sorts ascending by takenAt', () => {
    const data = [
      m({ value: 3, takenAt: '2026-03-01T10:00:00Z' }),
      m({ value: 1, takenAt: '2026-01-01T10:00:00Z' }),
      m({ value: 2, takenAt: '2026-02-01T10:00:00Z' }),
      m({ metricId: OTHER_ID, value: 9, takenAt: '2026-02-15T10:00:00Z' }),
    ];
    const s = seriesFor(data, GLUCOSE_ID);
    expect(s.map((x) => x.value)).toEqual([1, 2, 3]);
  });

  it('applies an inclusive from/to range', () => {
    const data = [
      m({ value: 1, takenAt: '2026-01-01T00:00:00Z' }),
      m({ value: 2, takenAt: '2026-02-01T00:00:00Z' }),
      m({ value: 3, takenAt: '2026-03-01T00:00:00Z' }),
    ];
    const s = seriesFor(data, GLUCOSE_ID, {
      from: '2026-02-01T00:00:00Z',
      to: '2026-02-28T00:00:00Z',
    });
    expect(s.map((x) => x.value)).toEqual([2]);
  });

  it('returns an empty array for an unknown metric', () => {
    const data = [m({ value: 1, takenAt: '2026-01-01T00:00:00Z' })];
    expect(seriesFor(data, OTHER_ID)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// latest / previous
// ---------------------------------------------------------------------------

describe('latest / previous', () => {
  it('returns undefined on empty series', () => {
    expect(latest([])).toBeUndefined();
    expect(previous([])).toBeUndefined();
  });

  it('returns the newest and second-newest', () => {
    const s = seriesFor(
      [
        m({ value: 1, takenAt: '2026-01-01T00:00:00Z' }),
        m({ value: 2, takenAt: '2026-02-01T00:00:00Z' }),
        m({ value: 3, takenAt: '2026-03-01T00:00:00Z' }),
      ],
      GLUCOSE_ID,
    );
    expect(latest(s)?.value).toBe(3);
    expect(previous(s)?.value).toBe(2);
  });

  it('previous is undefined on a single-point series', () => {
    const s = seriesFor([m({ value: 1, takenAt: '2026-01-01T00:00:00Z' })], GLUCOSE_ID);
    expect(latest(s)?.value).toBe(1);
    expect(previous(s)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// delta
// ---------------------------------------------------------------------------

describe('delta', () => {
  it('is insufficient-data on empty series', () => {
    const r = delta([], engine, glucose);
    expect(r).toEqual({ ok: false, unavailable: 'insufficient-data' });
  });

  it('is insufficient-data on a single-point series', () => {
    const s = seriesFor([m({ value: 5, takenAt: '2026-01-01T00:00:00Z' })], GLUCOSE_ID);
    const r = delta(s, engine, glucose);
    expect(r).toEqual({ ok: false, unavailable: 'insufficient-data' });
  });

  it('computes absolute and percent change (same unit)', () => {
    const s = seriesFor(
      [
        m({ value: 5, takenAt: '2026-01-01T00:00:00Z' }),
        m({ value: 6, takenAt: '2026-02-01T00:00:00Z' }),
      ],
      GLUCOSE_ID,
    );
    const r = delta(s, engine, glucose);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.absolute).toBeCloseTo(1, 10);
      expect(r.percent).toBeCloseTo(20, 10); // (6-5)/5 * 100
    }
  });

  it('converts the previous point into the latest unit (mmol/L vs mg/dL)', () => {
    // previous 90 mg/dL ~= 4.996 mmol/L; latest 6 mmol/L.
    const s = seriesFor(
      [
        m({ value: 90, unit: 'mg/dL', takenAt: '2026-01-01T00:00:00Z' }),
        m({ value: 6, unit: 'mmol/L', takenAt: '2026-02-01T00:00:00Z' }),
      ],
      GLUCOSE_ID,
    );
    const r = delta(s, engine, glucose);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const prevInMmol = (90 * 0.01 * 1000) / 180.16; // g/L -> mmol/L
      expect(r.absolute).toBeCloseTo(6 - prevInMmol, 6);
      expect(r.percent).toBeCloseTo(((6 - prevInMmol) / prevInMmol) * 100, 6);
    }
  });

  it('refuses when the latest point carries an operator', () => {
    const s = seriesFor(
      [
        m({ value: 5, takenAt: '2026-01-01T00:00:00Z' }),
        m({ value: 0.1, operator: '<', takenAt: '2026-02-01T00:00:00Z' }),
      ],
      GLUCOSE_ID,
    );
    expect(delta(s, engine, glucose)).toEqual({ ok: false, unavailable: 'operator' });
  });

  it('refuses when the previous point carries an operator', () => {
    const s = seriesFor(
      [
        m({ value: 0.1, operator: '<', takenAt: '2026-01-01T00:00:00Z' }),
        m({ value: 5, takenAt: '2026-02-01T00:00:00Z' }),
      ],
      GLUCOSE_ID,
    );
    expect(delta(s, engine, glucose)).toEqual({ ok: false, unavailable: 'operator' });
  });

  it('is not-convertible when units cannot be bridged', () => {
    // Metric with no molarMass: mmol/L vs mg/dL cannot convert.
    const noBridge = metric({ canonicalUnit: 'mmol/L', units: ['mmol/L', 'mg/dL'] });
    const s = seriesFor(
      [
        m({ value: 90, unit: 'mg/dL', takenAt: '2026-01-01T00:00:00Z' }),
        m({ value: 6, unit: 'mmol/L', takenAt: '2026-02-01T00:00:00Z' }),
      ],
      GLUCOSE_ID,
    );
    expect(delta(s, engine, noBridge)).toEqual({
      ok: false,
      unavailable: 'not-convertible',
    });
  });
});

// ---------------------------------------------------------------------------
// rangePosition
// ---------------------------------------------------------------------------

describe('rangePosition', () => {
  it('detects below / in-range / above', () => {
    expect(
      rangePosition(m({ value: 2, refLow: 3, refHigh: 6, takenAt: '2026-01-01T00:00:00Z' })),
    ).toBe('below');
    expect(
      rangePosition(m({ value: 4, refLow: 3, refHigh: 6, takenAt: '2026-01-01T00:00:00Z' })),
    ).toBe('in-range');
    expect(
      rangePosition(m({ value: 9, refLow: 3, refHigh: 6, takenAt: '2026-01-01T00:00:00Z' })),
    ).toBe('above');
  });

  it('is unknown without any reference bound', () => {
    expect(rangePosition(m({ value: 4, takenAt: '2026-01-01T00:00:00Z' }))).toBe('unknown');
  });

  it('handles a one-sided range', () => {
    expect(
      rangePosition(m({ value: 10, refHigh: 6, takenAt: '2026-01-01T00:00:00Z' })),
    ).toBe('above');
    expect(
      rangePosition(m({ value: 1, refLow: 3, takenAt: '2026-01-01T00:00:00Z' })),
    ).toBe('below');
  });
});

// ---------------------------------------------------------------------------
// ageDays
// ---------------------------------------------------------------------------

describe('ageDays', () => {
  it('computes whole days between takenAt and the supplied now', () => {
    const meas = m({ value: 1, takenAt: '2026-07-11T00:00:00Z' });
    expect(ageDays(meas, '2026-07-21T00:00:00Z')).toBe(10);
  });

  it('is zero on the same instant', () => {
    const meas = m({ value: 1, takenAt: '2026-07-21T08:00:00Z' });
    expect(ageDays(meas, '2026-07-21T08:00:00Z')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// trend
// ---------------------------------------------------------------------------

describe('trend', () => {
  function daily(values: number[]): Measurement[] {
    return values.map((v, i) =>
      m({ value: v, takenAt: `2026-01-0${i + 1}T00:00:00Z` }),
    );
  }

  it('is insufficient with fewer than two usable points', () => {
    expect(trend(seriesFor([], GLUCOSE_ID), engine, glucose)).toBe('insufficient');
    expect(
      trend(seriesFor(daily([5]), GLUCOSE_ID), engine, glucose),
    ).toBe('insufficient');
  });

  it('detects a rising series', () => {
    expect(trend(seriesFor(daily([1, 2, 3, 4]), GLUCOSE_ID), engine, glucose)).toBe('rising');
  });

  it('detects a falling series', () => {
    expect(trend(seriesFor(daily([4, 3, 2, 1]), GLUCOSE_ID), engine, glucose)).toBe('falling');
  });

  it('detects a flat series', () => {
    expect(trend(seriesFor(daily([5, 5, 5, 5]), GLUCOSE_ID), engine, glucose)).toBe('flat');
  });

  it('detects a fluctuating series', () => {
    expect(trend(seriesFor(daily([1, 5, 1, 5]), GLUCOSE_ID), engine, glucose)).toBe('fluctuating');
  });

  it('ignores operator-carrying points', () => {
    const s = seriesFor(
      [
        m({ value: 1, takenAt: '2026-01-01T00:00:00Z' }),
        m({ value: 0.1, operator: '<', takenAt: '2026-01-02T00:00:00Z' }),
        m({ value: 3, takenAt: '2026-01-03T00:00:00Z' }),
        m({ value: 4, takenAt: '2026-01-04T00:00:00Z' }),
      ],
      GLUCOSE_ID,
    );
    expect(trend(s, engine, glucose)).toBe('rising');
  });
});

// ---------------------------------------------------------------------------
// groupByEvent
// ---------------------------------------------------------------------------

describe('groupByEvent', () => {
  it('groups same time + source and splits different ones', () => {
    const src = 'lab-1' as SourceId;
    const data = [
      m({ value: 1, takenAt: '2026-01-01T10:00:00Z', sourceId: src }),
      m({ value: 2, takenAt: '2026-01-01T10:00:00Z', sourceId: src, metricId: OTHER_ID }),
      m({ value: 3, takenAt: '2026-01-01T10:00:00Z', sourceId: 'lab-2' as SourceId }),
      m({ value: 4, takenAt: '2026-02-01T10:00:00Z', sourceId: src }),
    ];
    const groups = groupByEvent(data);
    // 3 distinct events: (Jan/src), (Jan/lab-2), (Feb/src)
    expect(groups).toHaveLength(3);
    // sorted descending by time -> Feb first
    expect(groups[0].takenAt).toBe('2026-02-01T10:00:00Z');
    const janSrc = groups.find(
      (g) => g.takenAt === '2026-01-01T10:00:00Z' && g.sourceId === src,
    );
    expect(janSrc?.items).toHaveLength(2);
  });

  it('treats a missing source as its own key', () => {
    const data = [
      m({ value: 1, takenAt: '2026-01-01T10:00:00Z' }),
      m({ value: 2, takenAt: '2026-01-01T10:00:00Z', sourceId: 'lab-1' as SourceId }),
    ];
    const groups = groupByEvent(data);
    expect(groups).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// mixedUnits
// ---------------------------------------------------------------------------

describe('mixedUnits', () => {
  it('is false for a uniform-unit series', () => {
    const s = seriesFor(
      [
        m({ value: 1, unit: 'mmol/L', takenAt: '2026-01-01T00:00:00Z' }),
        m({ value: 2, unit: 'mmol/L', takenAt: '2026-02-01T00:00:00Z' }),
      ],
      GLUCOSE_ID,
    );
    expect(mixedUnits(s)).toBe(false);
  });

  it('is true when units differ', () => {
    const s = seriesFor(
      [
        m({ value: 1, unit: 'mmol/L', takenAt: '2026-01-01T00:00:00Z' }),
        m({ value: 90, unit: 'mg/dL', takenAt: '2026-02-01T00:00:00Z' }),
      ],
      GLUCOSE_ID,
    );
    expect(mixedUnits(s)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// duplicateCandidates
// ---------------------------------------------------------------------------

describe('duplicateCandidates', () => {
  it('finds exact duplicates (metric + time + value + unit)', () => {
    const data = [
      m({ value: 5, unit: 'mmol/L', takenAt: '2026-01-01T10:00:00Z' }),
      m({ value: 5, unit: 'mmol/L', takenAt: '2026-01-01T10:00:00Z' }),
      m({ value: 6, unit: 'mmol/L', takenAt: '2026-01-01T10:00:00Z' }),
    ];
    const clusters = duplicateCandidates(data, GLUCOSE_ID);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(2);
  });

  it('does not cluster differing units', () => {
    const data = [
      m({ value: 5, unit: 'mmol/L', takenAt: '2026-01-01T10:00:00Z' }),
      m({ value: 5, unit: 'mg/dL', takenAt: '2026-01-01T10:00:00Z' }),
    ];
    expect(duplicateCandidates(data, GLUCOSE_ID)).toEqual([]);
  });

  it('returns empty when there are no duplicates', () => {
    const data = [
      m({ value: 5, takenAt: '2026-01-01T10:00:00Z' }),
      m({ value: 6, takenAt: '2026-02-01T10:00:00Z' }),
    ];
    expect(duplicateCandidates(data, GLUCOSE_ID)).toEqual([]);
  });
});
