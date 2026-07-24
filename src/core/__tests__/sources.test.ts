import { describe, expect, it } from 'vitest';

import {
  inferSourceKind,
  matchSourceByName,
  suggestSource,
} from '../sources.js';
import type { Source, SourceId } from '../types.js';

const sources: Source[] = [
  { id: 'source-synlab' as SourceId, name: 'SYNLAB', kind: 'lab' },
  { id: 'source-home-scale' as SourceId, name: 'Home scale', kind: 'device' },
];

describe('inferSourceKind', () => {
  it('maps lab-shaped plugin ids to "lab"', () => {
    for (const id of ['pdf', 'lab-text', 'fhir', 'hl7v2', 'generic', 'generic-lab']) {
      expect(inferSourceKind(id)).toBe('lab');
    }
  });

  it('maps apple-health to "app"', () => {
    expect(inferSourceKind('apple-health')).toBe('app');
  });

  it('falls back to "other" for unknown or missing ids', () => {
    expect(inferSourceKind('json-backup')).toBe('other');
    expect(inferSourceKind('csv')).toBe('other');
    expect(inferSourceKind(undefined)).toBe('other');
  });
});

describe('matchSourceByName', () => {
  it('matches case-insensitively and trimmed', () => {
    expect(matchSourceByName(sources, '  synlab ')?.id).toBe('source-synlab');
    expect(matchSourceByName(sources, 'SYNLAB')?.id).toBe('source-synlab');
  });

  it('returns undefined for a blank or unknown name', () => {
    expect(matchSourceByName(sources, '   ')).toBeUndefined();
    expect(matchSourceByName(sources, 'Unknown lab')).toBeUndefined();
  });
});

describe('suggestSource', () => {
  it('suggests an existing source when the name matches', () => {
    expect(suggestSource(sources, 'synlab', 'pdf')).toEqual({
      mode: 'existing',
      sourceId: 'source-synlab',
      name: 'SYNLAB',
      kind: 'lab',
    });
  });

  it('suggests creating a new source with an inferred kind on a miss', () => {
    expect(suggestSource(sources, 'New Lab', 'pdf')).toEqual({
      mode: 'new',
      name: 'New Lab',
      kind: 'lab',
    });
    expect(suggestSource(sources, 'My Watch', 'apple-health')).toEqual({
      mode: 'new',
      name: 'My Watch',
      kind: 'app',
    });
    expect(suggestSource(sources, 'Something', 'csv')).toEqual({
      mode: 'new',
      name: 'Something',
      kind: 'other',
    });
  });

  it('suggests none when there is no source name', () => {
    expect(suggestSource(sources, undefined, 'pdf')).toEqual({ mode: 'none' });
    expect(suggestSource(sources, '   ', 'pdf')).toEqual({ mode: 'none' });
  });

  it('trims the suggested new-source name', () => {
    expect(suggestSource(sources, '  Fresh Lab  ', 'fhir')).toEqual({
      mode: 'new',
      name: 'Fresh Lab',
      kind: 'lab',
    });
  });
});
