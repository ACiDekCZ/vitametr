import { describe, expect, it } from 'vitest';

import { BUILTIN_METRICS } from '../catalog-data';
import { en } from '../../i18n/en';
import { cs } from '../../i18n/cs';
import {
  GROUP_ORDER,
  OTHER_TAG,
  SEEDED_TAG_IDS,
  WATCHED_TAG,
  isSeededTag,
  isWatched,
  isWatchedAlias,
  metricMatchesTag,
  normalizeWatchedTags,
  orderTags,
  primaryTag,
  tagLabel,
  usedTags,
} from '../tags';
import type { Metric } from '../types';

const t = (key: string): string => (en as Record<string, string>)[key] ?? key;
const byKey = (k: string): Metric => BUILTIN_METRICS.find((m) => m.key === k)!;

describe('tag vocabulary', () => {
  it('has an i18n label for every seeded tag id plus "other", in both tables', () => {
    for (const id of [...SEEDED_TAG_IDS, OTHER_TAG]) {
      const key = `tag.${id}`;
      expect(key in en, `${key} missing in en`).toBe(true);
      expect(key in cs, `${key} missing in cs`).toBe(true);
    }
  });

  it('lists every seeded tag in the fixed group order', () => {
    for (const id of SEEDED_TAG_IDS) {
      expect(GROUP_ORDER.includes(id), `${id} missing from GROUP_ORDER`).toBe(true);
    }
    expect(GROUP_ORDER[GROUP_ORDER.length - 1]).toBe(OTHER_TAG);
  });

  it('isSeededTag distinguishes seeded ids from custom tags', () => {
    expect(isSeededTag('blood')).toBe(true);
    expect(isSeededTag('kidney')).toBe(true);
    expect(isSeededTag('my-custom-tag')).toBe(false);
  });
});

describe('tagLabel', () => {
  it('returns the localized label for a seeded id', () => {
    expect(tagLabel('blood', t)).toBe('Blood');
    expect(tagLabel('lipids', t)).toBe('Lipids');
    expect(tagLabel('cbc', t)).toBe('Blood count');
    expect(tagLabel(OTHER_TAG, t)).toBe('Other');
  });

  it('returns a custom tag verbatim', () => {
    expect(tagLabel('sport', t)).toBe('sport');
    expect(tagLabel('My tag', t)).toBe('My tag');
  });
});

describe('primaryTag', () => {
  it('prefers a panel tag over a specimen tag', () => {
    expect(primaryTag(['blood', 'kidney'])).toBe('kidney');
    expect(primaryTag(['blood', 'cbc'])).toBe('cbc');
    expect(primaryTag(['urine', 'kidney'])).toBe('kidney');
  });

  it('falls back to the specimen tag when there is no panel', () => {
    expect(primaryTag(['blood'])).toBe('blood');
    expect(primaryTag(['urine'])).toBe('urine');
    expect(primaryTag(['vitals'])).toBe('vitals');
  });

  it('uses a custom tag when neither panel nor specimen is present', () => {
    expect(primaryTag(['sport'])).toBe('sport');
  });

  it('returns "other" for an untagged metric', () => {
    expect(primaryTag(undefined)).toBe(OTHER_TAG);
    expect(primaryTag([])).toBe(OTHER_TAG);
  });
});

describe('metricMatchesTag', () => {
  it('is true only when the metric carries the tag', () => {
    expect(metricMatchesTag({ tags: ['blood', 'kidney'] }, 'kidney')).toBe(true);
    expect(metricMatchesTag({ tags: ['blood', 'kidney'] }, 'liver')).toBe(false);
    expect(metricMatchesTag({ tags: undefined }, 'blood')).toBe(false);
  });
});

describe('orderTags / usedTags', () => {
  it('orders tags by the fixed group order, "other" last', () => {
    expect(orderTags(['other', 'blood', 'cbc', 'urine'])).toEqual([
      'cbc',
      'blood',
      'urine',
      'other',
    ]);
  });

  it('sorts custom tags just before "other"', () => {
    expect(orderTags(['other', 'zeta', 'alpha', 'blood'])).toEqual([
      'blood',
      'alpha',
      'zeta',
      'other',
    ]);
  });

  it('collects the union of tags across metrics', () => {
    const metrics = [
      { tags: ['blood', 'cbc'] },
      { tags: ['blood', 'kidney'] },
      { tags: undefined },
    ];
    expect(usedTags(metrics)).toEqual(['cbc', 'kidney', 'blood']);
  });
});

describe('watched (favorites) tag', () => {
  it('has an i18n label under tag.watched in both tables', () => {
    expect('tag.watched' in en).toBe(true);
    expect('tag.watched' in cs).toBe(true);
    expect(tagLabel(WATCHED_TAG, t)).toBe('Watched');
  });

  it('ranks first in the fixed group order', () => {
    expect(GROUP_ORDER[0]).toBe(WATCHED_TAG);
    expect(orderTags(['blood', WATCHED_TAG, 'cbc'])).toEqual([WATCHED_TAG, 'cbc', 'blood']);
  });

  it('is not part of the seeded clinical vocabulary', () => {
    expect(isSeededTag(WATCHED_TAG)).toBe(false);
    expect(SEEDED_TAG_IDS.includes(WATCHED_TAG)).toBe(false);
  });

  it('is never a metric primary tag', () => {
    // Only watched → falls through to the catch-all "other" group.
    expect(primaryTag([WATCHED_TAG])).toBe(OTHER_TAG);
    // Watched alongside a category tag → the category wins.
    expect(primaryTag([WATCHED_TAG, 'lipids'])).toBe('lipids');
    expect(primaryTag(['blood', WATCHED_TAG])).toBe('blood');
    // Watched alongside only a custom tag → the custom tag wins.
    expect(primaryTag([WATCHED_TAG, 'sport'])).toBe('sport');
  });

  it('isWatched reflects the watched tag', () => {
    expect(isWatched({ tags: [WATCHED_TAG, 'lipids'] })).toBe(true);
    expect(isWatched({ tags: ['lipids'] })).toBe(false);
    expect(isWatched({ tags: undefined })).toBe(false);
  });

  it('isWatchedAlias recognises the id and raw duplicates (any casing/locale)', () => {
    expect(isWatchedAlias(WATCHED_TAG)).toBe(true);
    expect(isWatchedAlias('Watched')).toBe(true);
    expect(isWatchedAlias('Sledované')).toBe(true);
    expect(isWatchedAlias('sledovane')).toBe(true);
    expect(isWatchedAlias('lipids')).toBe(false);
  });

  it('normalizeWatchedTags dedups a raw duplicate into the canonical id', () => {
    expect(normalizeWatchedTags(['Sledované', 'lipids'])).toEqual([WATCHED_TAG, 'lipids']);
    expect(normalizeWatchedTags(['lipids', 'Watched'])).toEqual(['lipids', WATCHED_TAG]);
    // Both the id and a raw duplicate collapse to a single canonical entry.
    expect(normalizeWatchedTags([WATCHED_TAG, 'Watched', 'blood'])).toEqual([WATCHED_TAG, 'blood']);
    // No watched tag → unchanged.
    expect(normalizeWatchedTags(['blood', 'lipids'])).toEqual(['blood', 'lipids']);
  });
});

describe('auto-seeded tags on the built-in catalog', () => {
  it('assigns specimen + panel tags to a representative sample', () => {
    expect(byKey('creatinine').tags).toEqual(['blood', 'kidney']);
    expect(byKey('glucose').tags).toEqual(['blood', 'diabetes']);
    expect(byKey('hemoglobin').tags).toEqual(['blood', 'cbc']);
    expect(byKey('ldl-cholesterol').tags).toEqual(['blood', 'lipids']);
    expect(byKey('alt').tags).toEqual(['blood', 'liver']);
    expect(byKey('tsh').tags).toEqual(['blood', 'thyroid']);
    expect(byKey('ferritin').tags).toEqual(['blood', 'iron']);
    expect(byKey('psa').tags).toEqual(['blood', 'tumor-markers']);
  });

  it('tags urine analytes with urine (and kidney where applicable)', () => {
    expect(byKey('urine-protein').tags).toEqual(['urine']);
    expect(byKey('urine-albumin').tags).toEqual(['urine', 'kidney']);
    expect(byKey('acr').tags).toEqual(['urine', 'kidney']);
  });

  it('tags home/body metrics as vitals and stool/FOB correctly', () => {
    expect(byKey('bp-systolic').tags).toEqual(['vitals']);
    expect(byKey('body-weight').tags).toEqual(['vitals']);
    expect(byKey('fob').tags).toEqual(['stool', 'tumor-markers']);
  });

  it('gives every built-in metric at least a specimen tag from the vocabulary', () => {
    for (const m of BUILTIN_METRICS) {
      expect(m.tags, `${m.key} has no tags`).toBeDefined();
      expect(m.tags!.length).toBeGreaterThan(0);
      for (const tag of m.tags!) {
        expect(isSeededTag(tag), `${m.key}: ${tag} not a seeded tag`).toBe(true);
      }
    }
  });
});
