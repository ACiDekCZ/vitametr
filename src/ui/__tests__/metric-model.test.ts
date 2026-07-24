import { describe, expect, it } from 'vitest';
import { seriesStats } from '../metric-model';

describe('seriesStats', () => {
  it('returns undefined for an empty series', () => {
    expect(seriesStats([])).toBeUndefined();
  });

  it('returns undefined when nothing is finite', () => {
    expect(seriesStats([NaN, Infinity, -Infinity])).toBeUndefined();
  });

  it('computes min / avg / max over the values', () => {
    expect(seriesStats([5.2, 5.6, 6.5, 5.4, 5.2])).toEqual({
      min: 5.2,
      avg: (5.2 + 5.6 + 6.5 + 5.4 + 5.2) / 5,
      max: 6.5,
    });
  });

  it('handles a single value (min = avg = max)', () => {
    expect(seriesStats([42])).toEqual({ min: 42, avg: 42, max: 42 });
  });

  it('supports negatives', () => {
    expect(seriesStats([-3, -1, -2])).toEqual({ min: -3, avg: -2, max: -1 });
  });

  it('ignores non-finite entries but keeps finite ones', () => {
    const stats = seriesStats([NaN, 10, Infinity, 20]);
    expect(stats).toEqual({ min: 10, avg: 15, max: 20 });
  });
});
