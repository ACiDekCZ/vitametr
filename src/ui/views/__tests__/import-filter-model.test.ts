import { describe, expect, it } from 'vitest';

import type { ReviewItem } from '../../../core/contracts';
import type { MetricId, ProposedMeasurement } from '../../../core/types';
import {
  aggregateByMetric,
  applyImportFilter,
  countsInPeriod,
  defaultRange,
  fileSummary,
  groupKey,
  initialSelection,
  itemInRange,
  itemMetricId,
  presetRange,
  shouldShowImportFilter,
  FILTER_MIN_ITEMS,
} from '../import-filter-model';

// --- Builders --------------------------------------------------------------

function resolved(metricId: string, takenAt?: string, over: Partial<ProposedMeasurement> = {}): ReviewItem {
  const proposed: ProposedMeasurement = {
    metric: metricId as MetricId,
    value: 1,
    confidence: 'high',
    ...(takenAt !== undefined ? { takenAt } : {}),
    ...over,
  };
  return { proposed, resolvedMetricId: metricId as MetricId, decision: 'accept' };
}

function unresolved(name: string, takenAt?: string): ReviewItem {
  const proposed: ProposedMeasurement = {
    metric: { unresolvedName: name },
    value: 1,
    confidence: 'low',
    ...(takenAt !== undefined ? { takenAt } : {}),
  };
  return { proposed, decision: 'pending' };
}

/** N items of one metric, all on the same day. */
function many(metricId: string, n: number, takenAt = '2026-01-15'): ReviewItem[] {
  return Array.from({ length: n }, () => resolved(metricId, takenAt));
}

// A name resolver: catalog name for resolved, raw name for unresolved.
const nameOf = (item: ReviewItem): string => {
  const id = itemMetricId(item);
  if (id) return `Name(${id})`;
  const m = item.proposed.metric;
  return typeof m === 'string' ? m : m.unresolvedName;
};

// --- shouldShowImportFilter (thresholds) -----------------------------------

describe('shouldShowImportFilter', () => {
  it('is false for a small, narrow, few-metric batch', () => {
    expect(shouldShowImportFilter(many('m:a', 10, '2026-01-01'))).toBe(false);
  });

  it('trips on > 50 items (a 50-item batch does not, 51 does)', () => {
    expect(shouldShowImportFilter(many('m:a', FILTER_MIN_ITEMS, '2026-01-01'))).toBe(false);
    expect(shouldShowImportFilter(many('m:a', FILTER_MIN_ITEMS + 1, '2026-01-01'))).toBe(true);
  });

  it('trips on a > 1 year span even with few items', () => {
    const within = [resolved('m:a', '2025-02-01'), resolved('m:a', '2026-01-15')];
    expect(shouldShowImportFilter(within)).toBe(false); // < 1 year apart
    const over = [resolved('m:a', '2024-01-01'), resolved('m:a', '2026-01-15')];
    expect(shouldShowImportFilter(over)).toBe(true); // ~2 years apart
  });

  it('trips on > 8 distinct metrics even with few items and a narrow span', () => {
    const eight = Array.from({ length: 8 }, (_, i) => resolved(`m:${i}`, '2026-01-01'));
    expect(shouldShowImportFilter(eight)).toBe(false);
    const nine = Array.from({ length: 9 }, (_, i) => resolved(`m:${i}`, '2026-01-01'));
    expect(shouldShowImportFilter(nine)).toBe(true);
  });

  it('counts an unresolved raw name as its own distinct metric', () => {
    const items = [
      ...Array.from({ length: 7 }, (_, i) => resolved(`m:${i}`, '2026-01-01')),
      unresolved('Mystery A', '2026-01-01'),
      unresolved('Mystery B', '2026-01-01'),
    ]; // 7 resolved + 2 unresolved names = 9 distinct
    expect(shouldShowImportFilter(items)).toBe(true);
  });
});

// --- groupKey / itemMetricId -----------------------------------------------

describe('groupKey', () => {
  it('keys resolved items by metric id and unresolved by prefixed raw name', () => {
    expect(groupKey(resolved('builtin:glucose'))).toBe('builtin:glucose');
    expect(groupKey(unresolved('Mystery'))).toBe('unresolved:Mystery');
  });

  it('prefers an explicit resolvedMetricId over the proposal metric', () => {
    const item: ReviewItem = {
      proposed: { metric: { unresolvedName: 'X' }, value: 1, confidence: 'low' },
      resolvedMetricId: 'builtin:glucose' as MetricId,
      decision: 'accept',
    };
    expect(groupKey(item)).toBe('builtin:glucose');
  });
});

// --- aggregateByMetric ------------------------------------------------------

describe('aggregateByMetric', () => {
  it('produces one row per distinct metric with count and date span', () => {
    const items = [
      resolved('m:a', '2020-05-01'),
      resolved('m:a', '2023-06-01'),
      resolved('m:a', '2021-01-01'),
      resolved('m:b', '2026-01-01'),
      unresolved('Raw', '2019-01-01'),
    ];
    const groups = aggregateByMetric(items, nameOf);
    expect(groups.map((g) => g.key)).toEqual(['m:a', 'm:b', 'unresolved:Raw']);
    const a = groups[0];
    expect(a.count).toBe(3);
    expect(a.minIso).toBe('2020-05-01');
    expect(a.maxIso).toBe('2023-06-01');
    expect(a.unresolved).toBe(false);
    expect(a.metricId).toBe('m:a');
    expect(a.name).toBe('Name(m:a)');
    const raw = groups[2];
    expect(raw.unresolved).toBe(true);
    expect(raw.metricId).toBeUndefined();
    expect(raw.name).toBe('Raw');
  });

  it('handles items without takenAt (count only, no span)', () => {
    const groups = aggregateByMetric([resolved('m:a'), resolved('m:a')], nameOf);
    expect(groups[0].count).toBe(2);
    expect(groups[0].minIso).toBeUndefined();
    expect(groups[0].maxIso).toBeUndefined();
  });
});

// --- fileSummary ------------------------------------------------------------

describe('fileSummary', () => {
  it('reports total count and overall min/max span', () => {
    const items = [
      resolved('m:a', '2019-02-03'),
      resolved('m:b', '2026-07-22'),
      resolved('m:a'), // no date — counted, ignored for span
    ];
    const s = fileSummary(items);
    expect(s.count).toBe(3);
    expect(s.minIso).toBe('2019-02-03');
    expect(s.maxIso).toBe('2026-07-22');
  });

  it('omits span for an all-undated batch', () => {
    const s = fileSummary([resolved('m:a'), resolved('m:b')]);
    expect(s.count).toBe(2);
    expect(s.minIso).toBeUndefined();
    expect(s.maxIso).toBeUndefined();
  });
});

// --- presetRange & itemInRange ---------------------------------------------

describe('presetRange', () => {
  it('all/custom clear the range; year/month set a lower bound', () => {
    const now = '2026-07-22T00:00:00.000Z';
    expect(presetRange('all', now)).toBeUndefined();
    expect(presetRange('custom', now)).toBeUndefined();
    expect(presetRange('year', now)?.fromIso?.slice(0, 10)).toBe('2025-07-22');
    expect(presetRange('month', now)?.fromIso?.slice(0, 10)).toBe('2026-06-22');
  });
});

describe('itemInRange', () => {
  it('keeps everything when the range is open', () => {
    expect(itemInRange(resolved('m:a', '1999-01-01'), undefined)).toBe(true);
    expect(itemInRange(resolved('m:a'), {})).toBe(true); // no date, open range
  });

  it('applies from/to bounds day-inclusive', () => {
    const range = { fromIso: '2026-01-01', toIso: '2026-01-31' };
    expect(itemInRange(resolved('m:a', '2025-12-31'), range)).toBe(false);
    expect(itemInRange(resolved('m:a', '2026-01-01'), range)).toBe(true);
    expect(itemInRange(resolved('m:a', '2026-01-31T18:00:00Z'), range)).toBe(true);
    expect(itemInRange(resolved('m:a', '2026-02-01'), range)).toBe(false);
  });

  it('drops an undated item once a range is set', () => {
    expect(itemInRange(resolved('m:a'), { fromIso: '2020-01-01' })).toBe(false);
  });
});

// --- applyImportFilter ------------------------------------------------------

describe('applyImportFilter', () => {
  const items = [
    resolved('m:a', '2026-01-10'),
    resolved('m:a', '2025-01-10'),
    resolved('m:b', '2026-01-10'),
    unresolved('Raw', '2026-01-10'),
  ];

  it('keeps only selected metric groups', () => {
    const kept = applyImportFilter(items, { selectedKeys: new Set(['m:a']) });
    expect(kept).toHaveLength(2);
    expect(kept.every((i) => groupKey(i) === 'm:a')).toBe(true);
  });

  it('keeps only items inside the period AND selected', () => {
    const kept = applyImportFilter(items, {
      selectedKeys: new Set(['m:a', 'm:b', 'unresolved:Raw']),
      range: { fromIso: '2026-01-01' },
    });
    // The 2025 m:a item drops out on the period bound.
    expect(kept).toHaveLength(3);
    expect(kept.some((i) => i.proposed.takenAt === '2025-01-10')).toBe(false);
  });

  it('nothing is dropped by default (all keys, open range)', () => {
    const kept = applyImportFilter(items, {
      selectedKeys: new Set(items.map(groupKey)),
    });
    expect(kept).toHaveLength(items.length);
  });
});

// --- countsInPeriod (live counts, metric dropping to 0) --------------------

describe('countsInPeriod', () => {
  const items = [
    resolved('m:a', '2026-01-10'),
    resolved('m:a', '2025-01-10'),
    resolved('m:b', '2020-01-10'),
  ];

  it('counts every group over an open range', () => {
    const counts = countsInPeriod(items);
    expect(counts.get('m:a')).toBe(2);
    expect(counts.get('m:b')).toBe(1);
  });

  it('drops a group to 0 when the period excludes all its items', () => {
    const counts = countsInPeriod(items, { fromIso: '2026-01-01' });
    expect(counts.get('m:a')).toBe(1);
    expect(counts.get('m:b')).toBe(0); // still present, disabled in the view
  });
});

// --- defaultRange (>5yr preselect) -----------------------------------------

describe('defaultRange', () => {
  it('defaults to "all" for a modest span', () => {
    const items = [resolved('m:a', '2024-01-01'), resolved('m:a', '2026-01-01')];
    expect(defaultRange(items, '2026-07-22T00:00:00Z')).toEqual({ presetId: 'all' });
  });

  it('pre-selects "year" (with a range) for a > 5 year span', () => {
    const items = [resolved('m:a', '2015-01-01'), resolved('m:a', '2026-01-01')];
    const d = defaultRange(items, '2026-07-22T00:00:00.000Z');
    expect(d.presetId).toBe('year');
    expect(d.range?.fromIso?.slice(0, 10)).toBe('2025-07-22');
  });
});

// --- initialSelection (unresolved + knownOnly) -----------------------------

describe('initialSelection', () => {
  const groups = aggregateByMetric(
    [resolved('m:a', '2026-01-01'), unresolved('Raw', '2026-01-01')],
    nameOf,
  );

  it('selects every group by default', () => {
    const sel = initialSelection(groups);
    expect(sel.has('m:a')).toBe(true);
    expect(sel.has('unresolved:Raw')).toBe(true);
  });

  it('leaves unresolved groups unchecked when knownOnly is on (visible, not hidden)', () => {
    const sel = initialSelection(groups, { knownOnly: true });
    expect(sel.has('m:a')).toBe(true);
    expect(sel.has('unresolved:Raw')).toBe(false);
  });
});
