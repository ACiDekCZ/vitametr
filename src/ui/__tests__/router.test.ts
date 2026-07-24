import { describe, expect, it } from 'vitest';
import { formatHash, isRoute, parseHash } from '../router';

describe('parseHash', () => {
  it('defaults to overview for empty or bare hashes', () => {
    expect(parseHash('')).toEqual({ route: 'overview' });
    expect(parseHash('#')).toEqual({ route: 'overview' });
    expect(parseHash('#/')).toEqual({ route: 'overview' });
  });

  it('parses known routes', () => {
    expect(parseHash('#/timeline')).toEqual({ route: 'timeline' });
    expect(parseHash('#/settings')).toEqual({ route: 'settings' });
  });

  it('parses a route with a param', () => {
    expect(parseHash('#/metric/builtin:glucose')).toEqual({
      route: 'metric',
      param: 'builtin:glucose',
    });
  });

  it('decodes an encoded param', () => {
    expect(parseHash('#/metric/user%3A1')).toEqual({
      route: 'metric',
      param: 'user:1',
    });
  });

  it('falls back to overview for unknown routes', () => {
    expect(parseHash('#/nope')).toEqual({ route: 'overview' });
  });
});

describe('formatHash', () => {
  it('formats route and param round-trip with parseHash', () => {
    expect(formatHash('timeline')).toBe('#/timeline');
    const h = formatHash('metric', 'builtin:ldl-cholesterol');
    expect(parseHash(h)).toEqual({ route: 'metric', param: 'builtin:ldl-cholesterol' });
  });

  it('encodes params with separators', () => {
    const h = formatHash('metric', 'user:1');
    expect(h).toBe('#/metric/user%3A1');
  });
});

describe('isRoute', () => {
  it('recognizes valid routes only', () => {
    expect(isRoute('overview')).toBe(true);
    expect(isRoute('metric')).toBe(true);
    expect(isRoute('bogus')).toBe(false);
  });
});
