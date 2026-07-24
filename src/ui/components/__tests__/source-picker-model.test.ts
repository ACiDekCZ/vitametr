import { describe, expect, it } from 'vitest';

import {
  resolveSourceSelection,
  selectionSourceName,
  type SourceSelection,
} from '../source-picker-model';
import type { Source, SourceId } from '../../../core/types';

const src = (id: string, name: string, kind: Source['kind'] = 'lab'): Source => ({
  id: id as SourceId,
  name,
  kind,
});

const SOURCES: Source[] = [
  src('source-synlab', 'SYNLAB'),
  src('source-manual', 'Manual entry', 'manual'),
];

describe('resolveSourceSelection', () => {
  it('resolves an existing selection to its id, no new source', () => {
    const sel: SourceSelection = { mode: 'existing', sourceId: 'source-synlab' as SourceId };
    const r = resolveSourceSelection(SOURCES, sel);
    expect(r.sourceId).toBe('source-synlab');
    expect(r.newSource).toBeUndefined();
  });

  it('falls back to none for a stale existing id', () => {
    const sel: SourceSelection = { mode: 'existing', sourceId: 'source-gone' as SourceId };
    const r = resolveSourceSelection(SOURCES, sel);
    expect(r.sourceId).toBeUndefined();
    expect(r.newSource).toBeUndefined();
  });

  it('clears the attribution for a none selection', () => {
    const r = resolveSourceSelection(SOURCES, { mode: 'none' });
    expect(r.sourceId).toBeUndefined();
    expect(r.newSource).toBeUndefined();
  });

  it('builds a new source for an unseen name', () => {
    const sel: SourceSelection = { mode: 'new', name: 'Lab X', kind: 'lab' };
    const r = resolveSourceSelection(SOURCES, sel);
    expect(r.newSource).toEqual({ id: 'source-lab-x', name: 'Lab X', kind: 'lab' });
    expect(r.sourceId).toBe('source-lab-x');
  });

  it('reuses an existing source when a typed new name matches (case-insensitive)', () => {
    const sel: SourceSelection = { mode: 'new', name: '  synlab ', kind: 'device' };
    const r = resolveSourceSelection(SOURCES, sel);
    expect(r.sourceId).toBe('source-synlab');
    expect(r.newSource).toBeUndefined();
  });

  it('treats a blank new name as none', () => {
    const r = resolveSourceSelection(SOURCES, { mode: 'new', name: '   ', kind: 'lab' });
    expect(r.sourceId).toBeUndefined();
    expect(r.newSource).toBeUndefined();
  });

  it('maps manual to the existing built-in manual source', () => {
    const r = resolveSourceSelection(SOURCES, { mode: 'manual' }, 'Manual entry');
    expect(r.sourceId).toBe('source-manual');
    expect(r.newSource).toBeUndefined();
  });

  it('creates a manual source when none exists', () => {
    const r = resolveSourceSelection([src('source-synlab', 'SYNLAB')], { mode: 'manual' }, 'Manual entry');
    expect(r.newSource).toEqual({ id: 'source-manual-entry', name: 'Manual entry', kind: 'manual' });
    expect(r.sourceId).toBe('source-manual-entry');
  });
});

describe('selectionSourceName', () => {
  it('returns the existing source name', () => {
    const name = selectionSourceName(SOURCES, {
      mode: 'existing',
      sourceId: 'source-synlab' as SourceId,
    });
    expect(name).toBe('SYNLAB');
  });

  it('returns the new source name', () => {
    expect(selectionSourceName(SOURCES, { mode: 'new', name: 'Lab X', kind: 'lab' })).toBe('Lab X');
  });

  it('returns undefined for none', () => {
    expect(selectionSourceName(SOURCES, { mode: 'none' })).toBeUndefined();
  });
});
