import { describe, expect, it } from 'vitest';

import {
  applySourceToGroup,
  buildTimeline,
  presentCategories,
  presentSourceIds,
} from '../timeline-model';
import type { Catalog } from '../../../core/contracts';
import type {
  Measurement,
  MeasurementId,
  Metric,
  MetricCategory,
  MetricId,
  ProfileId,
  SourceId,
} from '../../../core/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function metric(
  id: string,
  category: MetricCategory,
  extra: Partial<Metric> = {},
): Metric {
  return {
    id: id as MetricId,
    aliases: [],
    category,
    valueType: 'number',
    canonicalUnit: 'mmol/L',
    units: ['mmol/L'],
    ...extra,
  };
}

const GLUCOSE = metric('builtin:glucose', 'lab', { nameKey: 'metric.glucose' });
const WEIGHT = metric('builtin:body-weight', 'home', { nameKey: 'metric.body-weight' });
const STEPS = metric('user:1', 'wearable', { customName: 'Steps' });

/** Minimal Catalog: buildTimeline only ever calls byId. */
function catalogOf(...metrics: Metric[]): Catalog {
  const byId = new Map<string, Metric>(metrics.map((m) => [m.id, m]));
  const notImplemented = () => {
    throw new Error('not used');
  };
  return {
    all: () => metrics,
    visible: () => metrics,
    unlearnAlias: () => {},
    customAliases: () => [],
    byId: (id: MetricId) => byId.get(id),
    byKey: notImplemented,
    byLoinc: notImplemented,
    byExternalCode: notImplemented,
    resolveAlias: notImplemented,
    addUserMetric: notImplemented,
    learnAlias: notImplemented,
    setMetricTags: notImplemented,
    setExternalCodes: notImplemented,
    addTag: notImplemented,
    removeTag: notImplemented,
  };
}

let seq = 0;
function m(partial: {
  metricId: MetricId;
  value: number;
  takenAt: string;
  sourceId?: SourceId;
  unit?: string;
  refLow?: number;
  refHigh?: number;
}): Measurement {
  seq += 1;
  return {
    id: `meas-${seq}` as MeasurementId,
    profileId: 'p1' as ProfileId,
    metricId: partial.metricId,
    value: partial.value,
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

const LAB = 'src:lab' as SourceId;
const HOME = 'src:home' as SourceId;

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

describe('buildTimeline grouping', () => {
  it('groups measurements with the same date + source into one event', () => {
    const cat = catalogOf(GLUCOSE);
    const groups = buildTimeline(
      [
        m({ metricId: GLUCOSE.id, value: 5, takenAt: '2026-05-01T08:00:00Z', sourceId: LAB }),
        m({ metricId: GLUCOSE.id, value: 6, takenAt: '2026-05-01T08:00:00Z', sourceId: LAB }),
      ],
      cat,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].values).toHaveLength(2);
    expect(groups[0].sourceId).toBe(LAB);
  });

  it('splits the same instant from different sources into separate events', () => {
    const cat = catalogOf(GLUCOSE);
    const groups = buildTimeline(
      [
        m({ metricId: GLUCOSE.id, value: 5, takenAt: '2026-05-01T08:00:00Z', sourceId: LAB }),
        m({ metricId: GLUCOSE.id, value: 6, takenAt: '2026-05-01T08:00:00Z', sourceId: HOME }),
      ],
      cat,
    );
    expect(groups).toHaveLength(2);
  });

  it('splits different dates into separate events', () => {
    const cat = catalogOf(GLUCOSE);
    const groups = buildTimeline(
      [
        m({ metricId: GLUCOSE.id, value: 5, takenAt: '2026-05-01T08:00:00Z', sourceId: LAB }),
        m({ metricId: GLUCOSE.id, value: 6, takenAt: '2026-05-02T08:00:00Z', sourceId: LAB }),
      ],
      cat,
    );
    expect(groups).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe('buildTimeline ordering', () => {
  it('returns events newest-first regardless of input order', () => {
    const cat = catalogOf(GLUCOSE);
    const groups = buildTimeline(
      [
        m({ metricId: GLUCOSE.id, value: 1, takenAt: '2026-01-01T08:00:00Z', sourceId: LAB }),
        m({ metricId: GLUCOSE.id, value: 3, takenAt: '2026-03-01T08:00:00Z', sourceId: LAB }),
        m({ metricId: GLUCOSE.id, value: 2, takenAt: '2026-02-01T08:00:00Z', sourceId: LAB }),
      ],
      cat,
    );
    expect(groups.map((g) => g.takenAt)).toEqual([
      '2026-03-01T08:00:00Z',
      '2026-02-01T08:00:00Z',
      '2026-01-01T08:00:00Z',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

describe('buildTimeline filters', () => {
  const data = [
    m({ metricId: GLUCOSE.id, value: 5, takenAt: '2026-05-01T08:00:00Z', sourceId: LAB }),
    m({ metricId: WEIGHT.id, value: 80, takenAt: '2026-05-02T08:00:00Z', sourceId: HOME }),
    m({ metricId: STEPS.id, value: 9000, takenAt: '2026-05-03T08:00:00Z', sourceId: HOME }),
  ];
  const cat = catalogOf(GLUCOSE, WEIGHT, STEPS);

  it('filters by category', () => {
    const groups = buildTimeline(data, cat, { category: 'home' });
    expect(groups).toHaveLength(1);
    expect(groups[0].values[0].metricId).toBe(WEIGHT.id);
  });

  it('filters by source', () => {
    const groups = buildTimeline(data, cat, { sourceId: HOME });
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.sourceId === HOME)).toBe(true);
  });

  it('combines category and source filters', () => {
    const groups = buildTimeline(data, cat, { category: 'wearable', sourceId: HOME });
    expect(groups).toHaveLength(1);
    expect(groups[0].values[0].metricId).toBe(STEPS.id);
  });

  it('drops measurements whose metric is unknown when a category filter is active', () => {
    const orphan = m({
      metricId: 'user:404' as MetricId,
      value: 1,
      takenAt: '2026-05-04T08:00:00Z',
    });
    const groups = buildTimeline([...data, orphan], cat, { category: 'lab' });
    expect(groups).toHaveLength(1);
    expect(groups[0].values[0].metricId).toBe(GLUCOSE.id);
  });
});

// ---------------------------------------------------------------------------
// Value resolution
// ---------------------------------------------------------------------------

describe('buildTimeline value resolution', () => {
  it('resolves metric name key, custom name, category and range position', () => {
    const cat = catalogOf(GLUCOSE, STEPS);
    const groups = buildTimeline(
      [
        m({
          metricId: GLUCOSE.id,
          value: 12,
          takenAt: '2026-05-01T08:00:00Z',
          sourceId: LAB,
          refLow: 3.9,
          refHigh: 5.6,
        }),
        m({ metricId: STEPS.id, value: 9000, takenAt: '2026-05-01T08:00:00Z', sourceId: LAB }),
      ],
      cat,
    );
    const [glucoseVal, stepsVal] = groups[0].values;
    expect(glucoseVal.nameKey).toBe('metric.glucose');
    expect(glucoseVal.customName).toBeUndefined();
    expect(glucoseVal.category).toBe('lab');
    expect(glucoseVal.range).toBe('above');
    expect(stepsVal.customName).toBe('Steps');
    expect(stepsVal.nameKey).toBeUndefined();
    expect(stepsVal.range).toBe('unknown');
  });

  it('falls back to the custom category for an unknown metric', () => {
    const cat = catalogOf(GLUCOSE);
    const groups = buildTimeline(
      [m({ metricId: 'user:404' as MetricId, value: 1, takenAt: '2026-05-01T08:00:00Z' })],
      cat,
    );
    expect(groups[0].values[0].category).toBe('custom');
    expect(groups[0].values[0].metricId).toBe('user:404');
  });

  it('marks a group datetime when any item carries a time', () => {
    const cat = catalogOf(GLUCOSE);
    const dated = m({ metricId: GLUCOSE.id, value: 5, takenAt: '2026-05-01T08:00:00Z', sourceId: LAB });
    dated.timePrecision = 'date';
    const groups = buildTimeline([dated], cat);
    expect(groups[0].timePrecision).toBe('date');
  });
});

// ---------------------------------------------------------------------------
// Empty
// ---------------------------------------------------------------------------

describe('buildTimeline empty', () => {
  it('returns an empty list for no measurements', () => {
    expect(buildTimeline([], catalogOf(GLUCOSE))).toEqual([]);
  });

  it('returns an empty list when a filter matches nothing', () => {
    const cat = catalogOf(GLUCOSE);
    const data = [m({ metricId: GLUCOSE.id, value: 5, takenAt: '2026-05-01T08:00:00Z', sourceId: LAB })];
    expect(buildTimeline(data, cat, { sourceId: HOME })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Present filters
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Bulk source reassignment
// ---------------------------------------------------------------------------

describe('applySourceToGroup', () => {
  const NEW = 'src:new' as SourceId;

  it('reassigns every group member and leaves others untouched', () => {
    const a = m({ metricId: GLUCOSE.id, value: 5, takenAt: '2026-05-01T08:00:00Z', sourceId: LAB });
    const b = m({ metricId: GLUCOSE.id, value: 6, takenAt: '2026-05-01T08:00:00Z', sourceId: LAB });
    const other = m({ metricId: GLUCOSE.id, value: 7, takenAt: '2026-06-01T08:00:00Z', sourceId: HOME });

    const out = applySourceToGroup([a, b, other], [a.id, b.id], NEW);

    expect(out.find((x) => x.id === a.id)?.sourceId).toBe(NEW);
    expect(out.find((x) => x.id === b.id)?.sourceId).toBe(NEW);
    // The measurement outside the group keeps its original source untouched.
    expect(out.find((x) => x.id === other.id)?.sourceId).toBe(HOME);
  });

  it('clears the source to none (undefined)', () => {
    const a = m({ metricId: GLUCOSE.id, value: 5, takenAt: '2026-05-01T08:00:00Z', sourceId: LAB });
    const out = applySourceToGroup([a], [a.id], undefined);
    expect(out[0].sourceId).toBeUndefined();
  });

  it('assigns a source to a previously source-less batch', () => {
    const a = m({ metricId: GLUCOSE.id, value: 5, takenAt: '2026-05-01T08:00:00Z' });
    expect(a.sourceId).toBeUndefined();
    const out = applySourceToGroup([a], [a.id], NEW);
    expect(out[0].sourceId).toBe(NEW);
  });

  it('does not mutate the input measurements', () => {
    const a = m({ metricId: GLUCOSE.id, value: 5, takenAt: '2026-05-01T08:00:00Z', sourceId: LAB });
    applySourceToGroup([a], [a.id], NEW);
    expect(a.sourceId).toBe(LAB);
  });
});

describe('presentCategories / presentSourceIds', () => {
  const cat = catalogOf(GLUCOSE, WEIGHT, STEPS);
  const data = [
    m({ metricId: GLUCOSE.id, value: 5, takenAt: '2026-05-01T08:00:00Z', sourceId: LAB }),
    m({ metricId: WEIGHT.id, value: 80, takenAt: '2026-05-02T08:00:00Z', sourceId: HOME }),
    m({ metricId: WEIGHT.id, value: 81, takenAt: '2026-05-03T08:00:00Z', sourceId: HOME }),
  ];

  it('lists distinct present categories in catalog order', () => {
    expect(presentCategories(data, cat)).toEqual(['lab', 'home']);
  });

  it('lists distinct source ids in first-seen order', () => {
    expect(presentSourceIds(data)).toEqual([LAB, HOME]);
  });
});
