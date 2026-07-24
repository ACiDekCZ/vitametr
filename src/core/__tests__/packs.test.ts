import { describe, expect, it } from 'vitest';

import { createCatalog } from '../catalog';
import { BUILTIN_METRICS } from '../catalog-data';
import { UNITS } from '../units-data';
import { PANEL_TAGS } from '../tags';
import { CURRENT_SCHEMA_VERSION } from '../types';
import type {
  Measurement,
  MeasurementId,
  MetricId,
  ProfileData,
  ProfileId,
} from '../types';
import { parsePack, type VitametrPack } from '../../plugins/import/pack';
import {
  BUNDLED_PACKS,
  CORE_METRIC_KEYS,
  CORE_PACK,
  CORE_PACK_ID,
  bundledPackById,
  bundledPackNameKey,
  bundledPacks,
  packProvidedKeys,
} from '../packs-data';
import {
  SEED_PACK_ID,
  activePacks,
  activatePack,
  deactivatePack,
  hiddenMetricState,
  isPackActive,
  isMetricVisible,
  packContents,
  packOverlap,
  previewDeactivate,
  suggestPackForMetric,
} from '../packs';
import { en } from '../../i18n/en';
import { cs } from '../../i18n/cs';

const UNIT_CODES = new Set(UNITS.map((u) => u.code));

function emptyProfile(): ProfileData {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    profile: { id: 'p1' as ProfileId, name: 'Test', createdAt: '2026-07-21' },
    metrics: [],
    sources: [],
    measurements: [],
    settings: {},
  };
}

function measurement(metricId: string): Measurement {
  return {
    id: `meas-${metricId}` as MeasurementId,
    profileId: 'p1' as ProfileId,
    metricId: metricId as MetricId,
    value: 1,
    unit: '',
    takenAt: '2026-07-21',
    timePrecision: 'date',
    status: 'confirmed',
    origin: { pluginId: 'manual' },
    createdAt: '2026-07-21T10:00',
    modifiedAt: '2026-07-21T10:00',
  };
}

/** Every built-in metric key carrying a given tag. */
function builtinKeysWithTag(tag: string): string[] {
  return BUILTIN_METRICS.filter((m) => (m.tags ?? []).includes(tag)).map((m) => m.key!);
}

/** The pack whose id ends with the given tag. */
function packForTag(tag: string): VitametrPack {
  const pack = bundledPackById(`bundled:${tag}`);
  expect(pack, `no bundled pack for tag ${tag}`).toBeDefined();
  return pack!;
}

function visibleKeys(data: ProfileData): Set<string> {
  const catalog = createCatalog(data);
  return new Set(catalog.visible().map((m) => m.key ?? m.id));
}

describe('bundled packs — data integrity', () => {
  it('exposes a stable, deduped set of bundled packs', () => {
    expect(BUNDLED_PACKS.length).toBe(14);
    const ids = BUNDLED_PACKS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('bundled:lipids');
    expect(ids).toContain('bundled:coagulation');
    expect(bundledPacks()).not.toBe(BUNDLED_PACKS);
    expect(bundledPacks().map((p) => p.id)).toEqual(ids);
  });

  it('every bundled pack parses via parsePack (round-trips through JSON)', () => {
    for (const pack of [...BUNDLED_PACKS, CORE_PACK]) {
      const parsed = parsePack(JSON.stringify(pack));
      expect(parsed.id).toBe(pack.id);
      expect(parsed.format).toBe('vitametr-pack');
      expect((parsed.metrics ?? []).length).toBe((pack.metrics ?? []).length);
    }
  });

  it('references only UCUM codes present in units-data', () => {
    for (const pack of BUNDLED_PACKS) {
      for (const def of pack.metrics ?? []) {
        for (const code of def.units ?? (def.unit ? [def.unit] : [])) {
          expect(UNIT_CODES.has(code), `${pack.id}/${def.key}: unknown unit ${code}`).toBe(true);
        }
      }
    }
  });

  it('has an i18n name (pack.<id>) in both tables for every pack', () => {
    for (const pack of [...BUNDLED_PACKS, CORE_PACK]) {
      const key = bundledPackNameKey(pack.id);
      expect(key in en, `${key} missing in en`).toBe(true);
      expect(key in cs, `${key} missing in cs`).toBe(true);
    }
  });

  it('registers its three new category tags as panel tags', () => {
    for (const tag of ['cardiac', 'coagulation', 'bone']) {
      expect(PANEL_TAGS.includes(tag as never), `${tag} not a panel tag`).toBe(true);
    }
  });
});

describe('bundled packs — category completeness (derived from tags)', () => {
  it('each pack contains every built-in metric carrying its category tag', () => {
    for (const pack of BUNDLED_PACKS) {
      const tag = pack.id.slice('bundled:'.length);
      const packKeys = new Set((pack.metrics ?? []).map((d) => d.key));
      expect([...packKeys].sort()).toEqual(builtinKeysWithTag(tag).sort());
    }
  });

  it('carries the category tag on every metric it defines', () => {
    for (const pack of BUNDLED_PACKS) {
      const tag = pack.id.slice('bundled:'.length);
      for (const def of pack.metrics ?? []) {
        expect(def.tags ?? [], `${pack.id}/${def.key} lacks its category tag`).toContain(tag);
      }
    }
  });

  it('hormones is now a set of compiled built-ins (no longer all-extras)', () => {
    expect(builtinKeysWithTag('hormones').length).toBeGreaterThan(0);
    expect((packForTag('hormones').metrics ?? []).length).toBe(
      builtinKeysWithTag('hormones').length,
    );
  });
});

describe('Core pack + CORE_METRIC_KEYS', () => {
  it('captures exactly the 95 routine keys and excludes the moved extras', () => {
    expect(CORE_METRIC_KEYS.length).toBe(95);
    const set = new Set(CORE_METRIC_KEYS);
    // Routine metrics are core.
    for (const k of ['glucose', 'hemoglobin', 'creatinine', 'tsh', 'nt-probnp']) {
      expect(set.has(k), `${k} should be core`).toBe(true);
    }
    // The compiled category extras are NOT core.
    for (const k of ['fsh', 'insulin', 'troponin', 'cystatin-c', 'inr', 'osteocalcin', 'cea']) {
      expect(set.has(k), `${k} should NOT be core`).toBe(false);
    }
  });

  it('the Core pack provides exactly CORE_METRIC_KEYS', () => {
    const catalog = createCatalog(emptyProfile());
    expect(packProvidedKeys(CORE_PACK_ID, catalog).sort()).toEqual([...CORE_METRIC_KEYS].sort());
    expect((CORE_PACK.metrics ?? []).map((m) => m.key).sort()).toEqual(
      [...CORE_METRIC_KEYS].sort(),
    );
  });

  it('SEED_PACK_ID is the Core pack id (backward-compatible alias)', () => {
    expect(SEED_PACK_ID).toBe(CORE_PACK_ID);
    expect(CORE_PACK_ID).toBe('builtin:core');
  });
});

describe('moved metrics — resolvable + tagged', () => {
  it('resolve by their Czech name and a key alias and carry their category tag', () => {
    const catalog = createCatalog(emptyProfile());
    const cases: Array<[string, string, string, string]> = [
      ['cystatin-c', 'Cystatin C', 'S-Cystatin C', 'kidney'],
      ['insulin', 'Inzulín', 'IRI', 'diabetes'],
      ['fsh', 'Folikulostimulační hormon', 'FSH', 'hormones'],
      ['troponin', 'Troponin T', 'hs-cTnT', 'cardiac'],
      ['inr', 'INR', 'Quick INR', 'coagulation'],
      ['osteocalcin', 'Osteokalcin', 'Osteocalcin', 'bone'],
      ['cea', 'Karcinoembryonální antigen', 'CEA', 'tumor-markers'],
    ];
    for (const [key, czName, alias, tag] of cases) {
      expect(catalog.byKey(key), `${key} missing from catalog`).toBeDefined();
      expect(catalog.resolveAlias(czName)?.key, `${czName} -> ${key}`).toBe(key);
      expect(catalog.resolveAlias(alias)?.key, `${alias} -> ${key}`).toBe(key);
      expect(catalog.byKey(key)!.tags, `${key} lacks ${tag}`).toContain(tag);
    }
  });

  it('parathormon belongs to both the hormones and bone categories', () => {
    const catalog = createCatalog(emptyProfile());
    expect(catalog.byKey('pth')!.tags).toEqual(['blood', 'hormones', 'bone']);
  });
});

describe('visibility — resolution stays, display is pack-driven', () => {
  it('a built-in from an inactive pack resolves but is NOT visible', () => {
    const data = emptyProfile(); // Core on by default, hormones off
    const catalog = createCatalog(data);
    // Resolution is unfiltered.
    expect(catalog.byKey('fsh')).toBeDefined();
    expect(catalog.resolveAlias('FSH')).toBeDefined();
    // But it is not shown (no active pack provides it, no data).
    expect(isMetricVisible(data, catalog.byKey('fsh')!)).toBe(false);
    expect(visibleKeys(data).has('fsh')).toBe(false);
    // A routine core metric IS visible.
    expect(visibleKeys(data).has('glucose')).toBe(true);
  });

  it('Core off hides an unused routine metric but keeps a data-bearing one', () => {
    const data = emptyProfile();
    const catalog = createCatalog(data);
    // Give glucose a measurement; leave creatinine unused.
    data.measurements.push(measurement(catalog.byKey('glucose')!.id));

    deactivatePack(data, catalog, CORE_PACK_ID);

    const keys = visibleKeys(data);
    expect(keys.has('glucose')).toBe(true); // data survives
    expect(keys.has('creatinine')).toBe(false); // unused core → hidden
  });

  it('activating a category pack makes its metrics visible', () => {
    const data = emptyProfile();
    const catalog = createCatalog(data);
    expect(visibleKeys(data).has('fsh')).toBe(false);
    activatePack(data, catalog, 'bundled:hormones');
    const keys = visibleKeys(data);
    for (const k of builtinKeysWithTag('hormones')) expect(keys.has(k), `${k} visible`).toBe(true);
  });

  it('disabledMetrics hides (even a core metric); shownMetrics forces show', () => {
    const data = emptyProfile();
    const catalog = createCatalog(data);

    data.disabledMetrics = ['builtin:glucose' as MetricId];
    expect(visibleKeys(data).has('glucose')).toBe(false);
    // Still resolvable (import must find it).
    expect(catalog.byKey('glucose')).toBeDefined();

    // Force-show an off-pack metric without activating its pack.
    data.settings.shownMetrics = ['builtin:fsh' as MetricId];
    expect(visibleKeys(data).has('fsh')).toBe(true);
  });
});

describe('activatePack — pure visibility flag', () => {
  it('shows a specialist pack’s metrics without creating any user metric', () => {
    const data = emptyProfile();
    const catalog = createCatalog(data);
    const hormonesKeys = builtinKeysWithTag('hormones');

    const result = activatePack(data, catalog, 'bundled:hormones');

    expect(result.shown).toBe(hormonesKeys.length);
    expect(result.alreadyVisible).toBe(0);
    expect(isPackActive(data, 'bundled:hormones')).toBe(true);
    // Nothing was added to the profile's own metrics.
    expect(data.metrics.length).toBe(0);
    // Core stays in the (now explicit) active list.
    expect(activePacks(data)).toContain(CORE_PACK_ID);
    expect(activePacks(data)).toContain('bundled:hormones');
  });

  it('reports alreadyVisible for a pack whose metrics are all core', () => {
    const data = emptyProfile();
    const catalog = createCatalog(data);
    const result = activatePack(data, catalog, 'bundled:cbc'); // all CBC keys are core
    expect(result.shown).toBe(0);
    expect(result.alreadyVisible).toBe(builtinKeysWithTag('cbc').length);
  });

  it('re-activating an already-active pack is a deduped no-op', () => {
    const data = emptyProfile();
    const catalog = createCatalog(data);
    activatePack(data, catalog, 'bundled:hormones');
    const again = activatePack(data, catalog, 'bundled:hormones');
    expect(again.shown).toBe(0);
    expect(activePacks(data).filter((id) => id === 'bundled:hormones')).toHaveLength(1);
  });
});

describe('deactivatePack — hides, never removes', () => {
  it('hides an unused specialist pack and drops the id, deleting nothing', () => {
    const data = emptyProfile();
    const catalog = createCatalog(data);
    activatePack(data, catalog, 'bundled:hormones');

    const result = deactivatePack(data, catalog, 'bundled:hormones');

    expect(result.hidden).toBe(builtinKeysWithTag('hormones').length);
    expect(result.keptVisible).toBe(0);
    expect(isPackActive(data, 'bundled:hormones')).toBe(false);
    // No metric was deleted (nothing was ever added).
    expect(data.metrics.length).toBe(0);
    // Still resolvable, just not visible.
    expect(catalog.byKey('fsh')).toBeDefined();
    expect(visibleKeys(data).has('fsh')).toBe(false);
  });

  it('keeps a metric that has a measurement', () => {
    const data = emptyProfile();
    const catalog = createCatalog(data);
    activatePack(data, catalog, 'bundled:hormones');
    data.measurements.push(measurement(catalog.byKey('fsh')!.id));

    const result = deactivatePack(data, catalog, 'bundled:hormones');
    expect(result.keptVisible).toBe(1);
    expect(result.hidden).toBe(builtinKeysWithTag('hormones').length - 1);
    expect(visibleKeys(data).has('fsh')).toBe(true);
  });

  it('Core deactivates like any other pack (no refusal)', () => {
    const data = emptyProfile();
    const catalog = createCatalog(data);
    const result = deactivatePack(data, catalog, CORE_PACK_ID);
    expect(result.hidden).toBe(CORE_METRIC_KEYS.length); // all unused routine → hidden
    expect(isPackActive(data, CORE_PACK_ID)).toBe(false);
    expect(visibleKeys(data).has('glucose')).toBe(false);
  });
});

describe('non-disjoint packs (pth in hormones + bone)', () => {
  it('a metric in two active packs stays visible when one is turned off', () => {
    const data = emptyProfile();
    const catalog = createCatalog(data);
    activatePack(data, catalog, 'bundled:hormones');
    activatePack(data, catalog, 'bundled:bone');
    expect(visibleKeys(data).has('pth')).toBe(true);

    // Turn hormones off: pth still provided by the active bone pack.
    const off = deactivatePack(data, catalog, 'bundled:hormones');
    expect(visibleKeys(data).has('pth')).toBe(true);
    expect(off.keptVisible).toBeGreaterThanOrEqual(1);
    // A hormones-only metric is now hidden.
    expect(visibleKeys(data).has('fsh')).toBe(false);

    // Turn bone off too: nobody provides pth, unused → hidden.
    deactivatePack(data, catalog, 'bundled:bone');
    expect(visibleKeys(data).has('pth')).toBe(false);
  });
});

describe('previewDeactivate — dry-run matches deactivatePack', () => {
  it('matches on a simple active pack (all hidden) and does not mutate', () => {
    const data = emptyProfile();
    const catalog = createCatalog(data);
    activatePack(data, catalog, 'bundled:hormones');

    const activeBefore = [...activePacks(data)];
    const preview = previewDeactivate(data, catalog, 'bundled:hormones');
    expect(activePacks(data)).toEqual(activeBefore); // untouched

    const real = deactivatePack(data, catalog, 'bundled:hormones');
    expect(preview).toEqual(real);
  });

  it('matches when a metric is shared with another still-active pack', () => {
    const data = emptyProfile();
    const catalog = createCatalog(data);
    activatePack(data, catalog, 'bundled:hormones');
    activatePack(data, catalog, 'bundled:bone');

    const preview = previewDeactivate(data, catalog, 'bundled:hormones');
    const real = deactivatePack(data, catalog, 'bundled:hormones');
    expect(preview).toEqual(real);
    expect(preview.keptVisible).toBeGreaterThanOrEqual(1); // pth stays for bone
  });

  it('reports hidden=0 for a pack whose metrics are all already visible', () => {
    const data = emptyProfile();
    const catalog = createCatalog(data);
    activatePack(data, catalog, 'bundled:cbc'); // all core → already visible
    const preview = previewDeactivate(data, catalog, 'bundled:cbc');
    expect(preview.hidden).toBe(0);
    expect(preview.keptVisible).toBe(builtinKeysWithTag('cbc').length);
  });
});

describe('packOverlap — visibility counts', () => {
  it('reports 0 overlap for an off-pack whose metrics are none-visible', () => {
    const data = emptyProfile();
    const catalog = createCatalog(data);
    const overlap = packOverlap(data, catalog, packForTag('hormones'));
    expect(overlap.total).toBe(builtinKeysWithTag('hormones').length);
    expect(overlap.alreadyHave).toBe(0);
  });

  it('reports full overlap for a pack whose metrics are all core', () => {
    const data = emptyProfile();
    const catalog = createCatalog(data);
    const overlap = packOverlap(data, catalog, packForTag('cbc'));
    expect(overlap.alreadyHave).toBe(overlap.total);
  });

  it('does not mutate the profile', () => {
    const data = emptyProfile();
    const catalog = createCatalog(data);
    const before = data.metrics.length;
    packOverlap(data, catalog, packForTag('hormones'));
    expect(data.metrics.length).toBe(before);
    expect(data.settings.activePacks).toBeUndefined();
  });
});

describe('hiddenMetricState + suggestPackForMetric (import-review Fáze 4)', () => {
  it('a metric in an inactive category pack is hidden and suggests that pack', () => {
    const data = emptyProfile(); // hormones off by default
    const catalog = createCatalog(data);
    const fsh = catalog.byKey('fsh')!;
    expect(suggestPackForMetric(data, catalog, fsh)).toBe('bundled:hormones');
    expect(hiddenMetricState(data, catalog, fsh)).toEqual({
      hidden: true,
      suggestedPackId: 'bundled:hormones',
    });
  });

  it('a core metric with Core off is hidden and suggests the Core pack', () => {
    const data = emptyProfile();
    const catalog = createCatalog(data);
    deactivatePack(data, catalog, CORE_PACK_ID);
    // body-weight is a core key carrying only the vitals specimen tag (no bundled
    // category pack), so the only pack that would reveal it is Core.
    const bw = catalog.byKey('body-weight')!;
    expect(suggestPackForMetric(data, catalog, bw)).toBe(CORE_PACK_ID);
    expect(hiddenMetricState(data, catalog, bw)).toEqual({
      hidden: true,
      suggestedPackId: CORE_PACK_ID,
    });
  });

  it('a visible metric is not hidden', () => {
    const data = emptyProfile();
    const catalog = createCatalog(data);
    const glucose = catalog.byKey('glucose')!; // core, visible by default
    expect(hiddenMetricState(data, catalog, glucose)).toEqual({ hidden: false });
  });

  it('a metric with data is not hidden even when its pack is off', () => {
    const data = emptyProfile();
    const catalog = createCatalog(data);
    activatePack(data, catalog, 'bundled:hormones');
    data.measurements.push(measurement(catalog.byKey('fsh')!.id));
    deactivatePack(data, catalog, 'bundled:hormones');
    expect(hiddenMetricState(data, catalog, catalog.byKey('fsh')!)).toEqual({ hidden: false });
  });

  it('reveal actions clear the hidden state: activate pack, force-show, and own-metric', () => {
    // 1. Activate the suggested pack → visible.
    const a = emptyProfile();
    const catA = createCatalog(a);
    activatePack(a, catA, suggestPackForMetric(a, catA, catA.byKey('fsh')!)!);
    expect(isMetricVisible(a, catA.byKey('fsh')!)).toBe(true);

    // 2. Force-show just this metric via shownMetrics → visible, pack still off.
    const b = emptyProfile();
    const catB = createCatalog(b);
    b.settings.shownMetrics = [catB.byKey('fsh')!.id];
    expect(isMetricVisible(b, catB.byKey('fsh')!)).toBe(true);
    expect(isPackActive(b, 'bundled:hormones')).toBe(false);

    // 3. Create own: a user metric seeded from the incoming name learns it as an
    // alias and is itself always visible.
    const c = emptyProfile();
    const catC = createCatalog(c);
    const created = catC.addUserMetric({
      customName: 'FSH',
      aliases: [],
      category: 'custom',
      valueType: 'number',
      canonicalUnit: '[IU]/L',
      units: ['[IU]/L'],
      origin: { kind: 'import' },
    });
    catC.learnAlias(created.id, 'FSH');
    expect(created.id.startsWith('user:')).toBe(true);
    expect(created.origin).toEqual({ kind: 'import' });
    expect(catC.byId(created.id)!.aliases).toContain('FSH');
    expect(isMetricVisible(c, catC.byId(created.id)!)).toBe(true);
  });
});

describe('packContents — display list with has-data + last measured date', () => {
  it('flags no data on a fresh profile', () => {
    const data = emptyProfile();
    const catalog = createCatalog(data);
    const items = packContents(data, catalog, packForTag('hormones'));
    expect(items.length).toBe(builtinKeysWithTag('hormones').length);
    expect(items.every((i) => i.hasData === false)).toBe(true);
    expect(items.every((i) => i.lastMeasuredAtIso === undefined)).toBe(true);
    const fsh = items.find((i) => i.name === 'FSH');
    expect(fsh?.unit).toBe('[IU]/L');
  });

  it('flags has-data + the last measured date for a metric with a measurement', () => {
    const data = emptyProfile();
    const catalog = createCatalog(data);
    data.measurements.push(measurement(catalog.byKey('hemoglobin')!.id));
    const items = packContents(data, catalog, packForTag('cbc'));
    const hb = items.find((i) => i.name === 'Hemoglobin');
    expect(hb?.hasData).toBe(true);
    expect(hb?.lastMeasuredAtIso).toBe('2026-07-21');
    // only the metric with a measurement is flagged
    expect(items.filter((i) => i.hasData).length).toBe(1);
  });
});
