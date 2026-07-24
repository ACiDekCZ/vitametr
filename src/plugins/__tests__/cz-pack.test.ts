import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createCatalog } from '../../core/catalog.js';
import { parsePack } from '../import/pack.js';
import type { ProfileData, ProfileId } from '../../core/types.js';

function emptyProfile(): ProfileData {
  return {
    schemaVersion: 1,
    profile: { id: 'p1' as ProfileId, name: 'T', createdAt: '2026-01-01' },
    metrics: [],
    sources: [],
    measurements: [],
    settings: {},
  };
}

/** Apply the CZ alias pack onto a catalog (mirrors runPackImport's merge). */
function catalogWithPack() {
  const pack = parsePack(
    readFileSync(new URL('../../../packs/cz-lab-aliases.json', import.meta.url), 'utf8'),
  );
  const catalog = createCatalog(emptyProfile());
  for (const def of pack.metrics ?? []) {
    const existing = catalog.byKey(def.key) ?? catalog.resolveAlias(def.name);
    if (existing) {
      for (const a of [def.name, ...(def.aliases ?? [])]) catalog.learnAlias(existing.id, a);
    }
  }
  return catalog;
}

describe('CZ lab alias pack', () => {
  it('is a valid pack whose metrics all reference built-in keys', () => {
    const pack = parsePack(
      readFileSync(new URL('../../../packs/cz-lab-aliases.json', import.meta.url), 'utf8'),
    );
    const catalog = createCatalog(emptyProfile());
    for (const def of pack.metrics ?? []) {
      expect(catalog.byKey(def.key), `pack key ${def.key} must be a built-in`).toBeDefined();
    }
  });

  it('teaches the non-obvious Czech lab abbreviations', () => {
    const c = catalogWithPack();
    // The high-value, non-obvious ones the pack exists for.
    expect(c.resolveAlias('GMT')?.key).toBe('ggt'); // Czech old name for GGT
    expect(c.resolveAlias('GPT')?.key).toBe('alt'); // old name for ALT
    expect(c.resolveAlias('GOT')?.key).toBe('ast'); // old name for AST
    expect(c.resolveAlias('FE')?.key).toBe('iron'); // iron
    expect(c.resolveAlias('VITD')?.key).toBe('vitamin-d');
    expect(c.resolveAlias('LPS')?.key).toBe('lipase');
    expect(c.resolveAlias('KRE')?.key).toBe('creatinine');
    expect(c.resolveAlias('CB')?.key).toBe('total-protein');
  });
});
