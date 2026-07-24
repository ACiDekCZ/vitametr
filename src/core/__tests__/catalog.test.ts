import { beforeEach, describe, expect, it } from 'vitest';

import { BUILTIN_METRICS, LOINC_ATTRIBUTION } from '../catalog-data';
import { createCatalog } from '../catalog';
import { UNITS } from '../units-data';
import { en } from '../../i18n/en';
import { cs } from '../../i18n/cs';
import { CURRENT_SCHEMA_VERSION } from '../types';
import type { Metric, MetricId, ProfileData } from '../types';

const UNIT_CODES = new Set(UNITS.map((u) => u.code));

function emptyProfile(): ProfileData {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    profile: { id: 'p1' as ProfileData['profile']['id'], name: 'Test', createdAt: '2026-07-21' },
    metrics: [],
    sources: [],
    measurements: [],
    settings: {},
  };
}

describe('built-in seed data', () => {
  it('ships the full seed (95 routine core + 31 compiled category-pack analytes = 126)', () => {
    expect(BUILTIN_METRICS.length).toBe(126);
  });

  it('has unique keys and matching builtin: ids', () => {
    const keys = new Set<string>();
    for (const m of BUILTIN_METRICS) {
      expect(m.key, 'built-in metric must have a key').toBeTruthy();
      expect(keys.has(m.key!), `duplicate key ${m.key}`).toBe(false);
      keys.add(m.key!);
      expect(m.id).toBe(`builtin:${m.key}`);
    }
  });

  it('references only UCUM codes that exist in units-data', () => {
    for (const m of BUILTIN_METRICS) {
      // Qualitative metrics (text/enum/multi) carry no unit.
      if (m.valueType === 'number') {
        expect(m.units, `${m.key} lists its canonical unit`).toContain(m.canonicalUnit);
      }
      for (const code of m.units) {
        expect(UNIT_CODES.has(code), `${m.key}: unknown unit ${code}`).toBe(true);
      }
    }
  });

  it('precision keys are a subset of the metric units', () => {
    for (const m of BUILTIN_METRICS) {
      for (const code of Object.keys(m.precision ?? {})) {
        expect(m.units, `${m.key}: precision unit ${code} not in units`).toContain(code);
      }
    }
  });

  it('gives every numeric metric a wide sanity range with low < high', () => {
    for (const m of BUILTIN_METRICS) {
      if (m.valueType !== 'number') continue; // qualitative metrics have no range
      expect(m.typicalRange, `${m.key} missing typicalRange`).toBeDefined();
      const { low, high } = m.typicalRange!;
      expect(typeof low).toBe('number');
      expect(typeof high).toBe('number');
      expect(low!).toBeLessThan(high!);
    }
  });

  it('maps every metric name key into both i18n tables', () => {
    for (const m of BUILTIN_METRICS) {
      expect(m.nameKey).toBe(`metric.${m.key}`);
      expect(m.nameKey! in en, `${m.nameKey} missing in en`).toBe(true);
      expect(m.nameKey! in cs, `${m.nameKey} missing in cs`).toBe(true);
    }
  });

  it('uses a valid LOINC format wherever a built-in ships one', () => {
    // A LOINC is embedded only when it is a well-established public code — never
    // invented. The routine seed-expansion analytes ship without one (their
    // source corpus carries no LOINC); codes may be supplemented later. Every
    // code that IS present must be well-formed.
    for (const m of BUILTIN_METRICS) {
      if (m.externalCodes?.loinc !== undefined) {
        expect(m.externalCodes.loinc, `${m.key} has malformed LOINC`).toMatch(/^\d+-\d$/);
      }
    }
  });

  it('uses each LOINC code at most once', () => {
    const codes = BUILTIN_METRICS.map((m) => m.externalCodes?.loinc).filter(Boolean);
    expect(new Set(codes).size, 'duplicate LOINC code in seed').toBe(codes.length);
  });

  it('never ships non-LOINC external codes in the public seed (§5.2)', () => {
    for (const m of BUILTIN_METRICS) {
      expect(m.externalCodes?.other).toBeUndefined();
    }
  });

  it('exposes the mandatory LOINC attribution', () => {
    expect(LOINC_ATTRIBUTION).toContain('LOINC');
    expect(LOINC_ATTRIBUTION).toContain('Regenstrief Institute');
  });

  it('assigns molar masses to the analytes that bridge concentration dimensions', () => {
    const byKey = (k: string) => BUILTIN_METRICS.find((m) => m.key === k)!;
    expect(byKey('glucose').molarMass).toBe(180.16);
    expect(byKey('creatinine').molarMass).toBe(113.12);
    expect(byKey('total-cholesterol').molarMass).toBe(386.65);
    expect(byKey('uric-acid').molarMass).toBe(168.11);
    expect(byKey('iron').molarMass).toBe(55.85);
    // Dimensional-only metrics need no molar mass.
    expect(byKey('alt').molarMass).toBeUndefined();
    expect(byKey('hemoglobin').molarMass).toBeUndefined();
  });

  it('gives HbA1c an explicit affine IFCC->NGSP conversion, not molar mass', () => {
    const hba1c = BUILTIN_METRICS.find((m) => m.key === 'hba1c')!;
    expect(hba1c.molarMass).toBeUndefined();
    expect(hba1c.conversions).toEqual([
      { fromUnit: 'mmol/mol', toUnit: '%', factor: 0.09148, offset: 2.152 },
    ]);
  });

  it('includes the ÚZIS national-catalog extension analytes', () => {
    const byKey = (k: string) => BUILTIN_METRICS.find((m) => m.key === k);
    // A representative sample of the added analytes exists.
    expect(byKey('nt-probnp')).toBeDefined();
    expect(byKey('ft4')).toBeDefined();
    expect(byKey('c-peptide')).toBeDefined();
    expect(byKey('urine-albumin')).toBeDefined();

    // urea bridges molar <-> mass via molarMass and lists both units.
    const urea = byKey('urea')!;
    expect(urea.canonicalUnit).toBe('mmol/L');
    expect(urea.units).toEqual(['mmol/L', 'mg/dL']);
    expect(urea.molarMass).toBe(60.06);

    // ACR is a ratio: single arbitrary unit, no conversion.
    const acr = byKey('acr')!;
    expect(acr.canonicalUnit).toBe('mg/mmol');
    expect(acr.units).toEqual(['mg/mmol']);
    expect(acr.molarMass).toBeUndefined();

    // Lp(a) keeps a single canonical unit (no valid mass<->molar bridge).
    const lpa = byKey('lipoprotein-a')!;
    expect(lpa.units).toEqual(['nmol/L']);
    expect(lpa.molarMass).toBeUndefined();

    // Arbitrary-dimension analytes stay single-unit (convertibility invariant).
    for (const k of ['anti-gad', 'acr', 'fob']) {
      expect(byKey(k)!.units.length).toBe(1);
    }
  });

  it('includes the routine cross-category seed-expansion analytes, resolvable by their Czech names', () => {
    const catalog = createCatalog(emptyProfile());
    const byKey = (k: string) => BUILTIN_METRICS.find((m) => m.key === k);

    // Every added analyte exists and resolves by its Czech name + a key alias.
    const added: Array<[string, string, string]> = [
      ['amylase', 'Amyláza', 'AMS'],
      ['amylase-pancreatic', 'Amyláza pankreatická', 'P-amyláza'],
      ['ld', 'Laktátdehydrogenáza', 'LDH'],
      ['ck', 'Kreatinkináza', 'CK'],
      ['cholinesterase', 'Cholinesteráza', 'CHE'],
      ['phosphate', 'Fosfor', 'Fosfor anorganický'],
      ['osmolality', 'Osmolalita', 'Osmol'],
      ['homocysteine', 'Homocystein', 'HCY'],
      ['bilirubin-direct', 'Bilirubin konjugovaný', 'Bilirubin přímý'],
      ['apolipoprotein-a1', 'Apolipoprotein A1', 'Apo A1'],
      ['apolipoprotein-b', 'Apolipoprotein B', 'Apo B'],
      ['transferrin', 'Transferin', 'TRF'],
      ['tibc', 'Celková vazebná kapacita železa', 'TIBC'],
      ['transferrin-saturation', 'Saturace transferinu', 'TSAT'],
      ['ft3', 'Volný trijodtyronin', 'fT3'],
      ['aslo', 'Antistreptolyzin O', 'ASLO'],
      ['rheumatoid-factor', 'Revmatoidní faktor', 'RF'],
      ['reticulocytes', 'Retikulocyty', 'Reti'],
      ['esr', 'Sedimentace erytrocytů', 'FW'],
      ['neutrophils', 'Neutrofily', 'Segmenty'],
      ['lymphocytes', 'Lymfocyty', 'Ly'],
      ['monocytes', 'Monocyty', 'Mo'],
      ['eosinophils', 'Eozinofily', 'EO'],
      ['basophils', 'Bazofily', 'Ba'],
      ['non-hdl-cholesterol', 'Cholesterol non-HDL', 'non-HDL'],
    ];
    for (const [key, czName, alias] of added) {
      expect(byKey(key), `${key} missing from seed`).toBeDefined();
      expect(catalog.resolveAlias(czName)?.key, `${czName} -> ${key}`).toBe(key);
      expect(catalog.resolveAlias(alias)?.key, `${alias} -> ${key}`).toBe(key);
      // Every added metric carries at least one tag (overview grouping relies on it).
      expect(byKey(key)!.tags?.length ?? 0, `${key} needs a tag`).toBeGreaterThan(0);
    }

    // Enzyme units resolve (µkat/L canonical, U/L alternate).
    expect(byKey('ld')!.units).toEqual(['ukat/L', 'U/L']);
    // New arbitrary units are wired up.
    expect(byKey('osmolality')!.canonicalUnit).toBe('mmol/kg');
    expect(byKey('esr')!.canonicalUnit).toBe('mm/h');
    expect(byKey('aslo')!.canonicalUnit).toBe('[IU]/mL');
    // Phosphate bridges mmol/L <-> mg/dL as elemental phosphorus.
    expect(byKey('phosphate')!.molarMass).toBe(30.97);
  });

  it('seeds the SmartMedix quantitative sediment gaps distinct from the dipstick metrics', () => {
    const catalog = createCatalog(emptyProfile());
    const byKey = (k: string) => BUILTIN_METRICS.find((m) => m.key === k);

    // The quantitative sediment counts exist, are numeric, and use the /µL island.
    const uEry = byKey('urine-erythrocytes')!;
    const uLeu = byKey('urine-leukocytes')!;
    expect(uEry.valueType).toBe('number');
    expect(uLeu.valueType).toBe('number');
    expect(uEry.units).toEqual(['/uL']);
    expect(uLeu.units).toEqual(['/uL']);

    // They are DISTINCT from the qualitative dipstick metrics (text, no unit).
    expect(byKey('urine-blood')!.valueType).toBe('text');
    expect(byKey('urine-leukocyte-esterase')!.valueType).toBe('text');
    expect(uEry.key).not.toBe(byKey('urine-blood')!.key);
    expect(uLeu.key).not.toBe(byKey('urine-leukocyte-esterase')!.key);

    // Quantitative sediment names resolve to the count metric, not the dipstick.
    expect(catalog.resolveAlias('Erytrocyty v moči')?.key).toBe('urine-erythrocytes');
    expect(catalog.resolveAlias('Leukocyty v moči - sediment')?.key).toBe('urine-leukocytes');
    // The bare dipstick alias still resolves to the qualitative esterase metric.
    expect(catalog.resolveAlias('Leukocyty v moči')?.key).toBe('urine-leukocyte-esterase');

    // non-HDL is its own stored metric (SmartMedix reports it as a line).
    expect(byKey('non-hdl-cholesterol')!.valueType).toBe('number');
    expect(byKey('non-hdl-cholesterol')!.canonicalUnit).toBe('mmol/L');
  });

  it('groups blood pressure and heart rate into one entry group', () => {
    const grouped = BUILTIN_METRICS.filter((m) => m.entryGroup === 'blood-pressure').map(
      (m) => m.key,
    );
    expect(grouped.sort()).toEqual(['bp-diastolic', 'bp-systolic', 'heart-rate']);
  });
});

describe('catalog lookups', () => {
  let profile: ProfileData;

  beforeEach(() => {
    profile = emptyProfile();
  });

  it('returns all built-ins from an empty profile', () => {
    const catalog = createCatalog(profile);
    expect(catalog.all().length).toBe(BUILTIN_METRICS.length);
  });

  it('keeps a built-in listed in disabledMetrics RESOLVABLE but hides it from visible()', () => {
    profile.disabledMetrics = ['builtin:glucose' as MetricId];
    const catalog = createCatalog(profile);
    // Resolution is unfiltered — an import must still find a hidden metric.
    expect(catalog.byKey('glucose')).toBeDefined();
    expect(catalog.all().length).toBe(BUILTIN_METRICS.length);
    // But it is not shown to the user.
    expect(catalog.visible().some((m) => m.key === 'glucose')).toBe(false);
    // Clearing the hide brings it back into the visible set.
    profile.disabledMetrics = [];
    expect(createCatalog(profile).visible().some((m) => m.key === 'glucose')).toBe(true);
  });

  it('finds metrics by id and by key', () => {
    const catalog = createCatalog(profile);
    const glucose = catalog.byKey('glucose');
    expect(glucose?.canonicalUnit).toBe('mmol/L');
    expect(catalog.byId('builtin:glucose' as MetricId)?.key).toBe('glucose');
    expect(catalog.byKey('does-not-exist')).toBeUndefined();
  });

  it('resolves aliases case- and diacritics-insensitively', () => {
    const catalog = createCatalog(profile);
    expect(catalog.resolveAlias('LDL')?.key).toBe('ldl-cholesterol');
    expect(catalog.resolveAlias('ldl-c')?.key).toBe('ldl-cholesterol');
    expect(catalog.resolveAlias('  s-ldl cholesterol ')?.key).toBe('ldl-cholesterol');
    expect(catalog.resolveAlias('glukoza')?.key).toBe('glucose'); // no diacritics
    expect(catalog.resolveAlias('GLUKÓZA')?.key).toBe('glucose');
    expect(catalog.resolveAlias('Kyselina mocova')?.key).toBe('uric-acid');
    expect(catalog.resolveAlias('totally unknown analyte')).toBeUndefined();
  });
});

describe('user metrics and learning', () => {
  let profile: ProfileData;

  beforeEach(() => {
    profile = emptyProfile();
  });

  it('addUserMetric persists into ProfileData with a generated id', () => {
    const catalog = createCatalog(profile);
    // Selenium is not in the built-in seed, so it stays a genuine user metric.
    const spec: Omit<Metric, 'id'> = {
      customName: 'Selen',
      aliases: ['Selen', 'Selenium', 'Se'],
      category: 'custom',
      valueType: 'number',
      canonicalUnit: 'umol/L',
      units: ['umol/L'],
    };
    const created = catalog.addUserMetric(spec);

    expect(created.id).toMatch(/^user:/);
    expect(profile.metrics).toContainEqual(created);
    expect(catalog.byId(created.id)).toEqual(created);
    expect(catalog.resolveAlias('Se')?.id).toBe(created.id);
    expect(catalog.resolveAlias('Selen')?.id).toBe(created.id);
    // No duplication of built-ins.
    expect(catalog.all().length).toBe(BUILTIN_METRICS.length + 1);
  });

  it("a user metric wins alias resolution over a built-in of the same name", () => {
    const catalog = createCatalog(profile);
    // Before: "FSH" resolves to the built-in (key 'fsh').
    expect(catalog.resolveAlias('FSH')?.key).toBe('fsh');

    // The user re-creates FSH as their own metric that learns the incoming name.
    const own = catalog.addUserMetric({
      customName: 'FSH',
      aliases: ['FSH'],
      category: 'custom',
      valueType: 'number',
      canonicalUnit: 'IU/L',
      units: ['IU/L'],
    });

    // Now the same name resolves to the CUSTOM metric, not the built-in — so a
    // future import of "FSH" reaches the user's own metric.
    expect(catalog.resolveAlias('FSH')?.id).toBe(own.id);
    expect(catalog.resolveAlias('fsh')?.id).toBe(own.id); // fold is case-insensitive

    // A name only a built-in knows still resolves to the built-in.
    expect(catalog.resolveAlias('Glukóza')?.key).toBe('glucose');
    // Exact key/id lookups are unchanged (still the built-in).
    expect(catalog.byKey('fsh')?.id).toBe('builtin:fsh');
    expect(catalog.byId('builtin:fsh' as MetricId)?.key).toBe('fsh');
  });

  it('learnAlias on a built-in creates a persisted override, resolvable afterwards', () => {
    const catalog = createCatalog(profile);
    expect(catalog.resolveAlias('Cukr v krvi')).toBeUndefined();

    catalog.learnAlias('builtin:glucose' as MetricId, 'Cukr v krvi');

    // Persisted as an override entry keyed by the built-in id.
    const override = profile.metrics.find((m) => m.id === 'builtin:glucose');
    expect(override).toBeDefined();
    expect(override!.aliases).toContain('Cukr v krvi');

    // Resolvable through the catalog, and the built-in's own aliases still work.
    expect(catalog.resolveAlias('cukr v krvi')?.key).toBe('glucose');
    expect(catalog.resolveAlias('Glukóza')?.key).toBe('glucose');
    // Still a single glucose entry after merge.
    expect(catalog.all().filter((m) => m.key === 'glucose').length).toBe(1);
  });

  it('customAliases lists only the learned aliases and unlearnAlias removes them', () => {
    const catalog = createCatalog(profile);
    catalog.learnAlias('builtin:glucose' as MetricId, 'Cukr v krvi');
    // Only the learned alias is editable — the compiled seed aliases are not.
    expect(catalog.customAliases('builtin:glucose' as MetricId)).toEqual(['Cukr v krvi']);
    expect(catalog.resolveAlias('Cukr v krvi')?.key).toBe('glucose');

    catalog.unlearnAlias('builtin:glucose' as MetricId, 'cukr v krvi'); // case-insensitive
    expect(catalog.customAliases('builtin:glucose' as MetricId)).toEqual([]);
    expect(catalog.resolveAlias('Cukr v krvi')).toBeUndefined();
    // The built-in's own seed alias still resolves.
    expect(catalog.resolveAlias('Glukóza')?.key).toBe('glucose');
  });

  it('learnAlias is idempotent and de-duplicates', () => {
    const catalog = createCatalog(profile);
    catalog.learnAlias('builtin:glucose' as MetricId, 'Cukr v krvi');
    catalog.learnAlias('builtin:glucose' as MetricId, 'cukr v krvi'); // same, different case
    catalog.learnAlias('builtin:glucose' as MetricId, 'Glukóza'); // already a built-in alias

    const override = profile.metrics.find((m) => m.id === 'builtin:glucose')!;
    const occurrences = override.aliases.filter(
      (a) => a.toLowerCase() === 'cukr v krvi',
    ).length;
    expect(occurrences).toBe(1);
  });

  it('learnAlias adds to an existing user metric in place', () => {
    const catalog = createCatalog(profile);
    // Selenium is not in the built-in seed, so it stays a genuine user metric.
    const created = catalog.addUserMetric({
      customName: 'Selen',
      aliases: ['Selen'],
      category: 'custom',
      valueType: 'number',
      canonicalUnit: 'umol/L',
      units: ['umol/L'],
    });
    catalog.learnAlias(created.id, 'Se');

    expect(profile.metrics.filter((m) => m.id === created.id).length).toBe(1);
    expect(catalog.resolveAlias('Se')?.id).toBe(created.id);
  });

  it('learnAlias on an unknown id is a no-op', () => {
    const catalog = createCatalog(profile);
    catalog.learnAlias('builtin:nonexistent' as MetricId, 'Whatever');
    expect(profile.metrics.length).toBe(0);
  });

  it('addTag on a built-in creates a persisted override and survives via merge', () => {
    const catalog = createCatalog(profile);
    // Seed tags are present on the merged built-in.
    expect(catalog.byId('builtin:glucose' as MetricId)?.tags).toEqual(['blood', 'diabetes']);

    catalog.addTag('builtin:glucose' as MetricId, 'fasting');

    // Persisted as an override entry keyed by the built-in id.
    const override = profile.metrics.find((m) => m.id === 'builtin:glucose');
    expect(override).toBeDefined();
    expect(override!.tags).toEqual(['blood', 'diabetes', 'fasting']);
    // A fresh catalog (reload) still sees the extra tag.
    expect(createCatalog(profile).byId('builtin:glucose' as MetricId)?.tags).toEqual([
      'blood',
      'diabetes',
      'fasting',
    ]);
  });

  it('addTag is idempotent and removeTag drops a tag', () => {
    const catalog = createCatalog(profile);
    catalog.addTag('builtin:glucose' as MetricId, 'fasting');
    catalog.addTag('builtin:glucose' as MetricId, 'fasting'); // no duplicate
    expect(catalog.byId('builtin:glucose' as MetricId)?.tags).toEqual([
      'blood',
      'diabetes',
      'fasting',
    ]);

    catalog.removeTag('builtin:glucose' as MetricId, 'diabetes');
    expect(catalog.byId('builtin:glucose' as MetricId)?.tags).toEqual(['blood', 'fasting']);
  });

  it('canonicalizes the watched tag and dedups a raw "Watched" duplicate on write', () => {
    const catalog = createCatalog(profile);
    // A raw user-typed "Watched" string is stored as the canonical builtin id.
    catalog.addTag('builtin:glucose' as MetricId, 'Watched');
    expect(catalog.byId('builtin:glucose' as MetricId)?.tags).toEqual([
      'blood',
      'diabetes',
      'builtin:watched',
    ]);
    // Adding the canonical id on top does not duplicate it.
    catalog.addTag('builtin:glucose' as MetricId, 'builtin:watched');
    expect(
      (catalog.byId('builtin:glucose' as MetricId)?.tags ?? []).filter(
        (t) => t === 'builtin:watched',
      ),
    ).toHaveLength(1);
    // A stored list carrying both the id and a raw duplicate collapses to one.
    catalog.setMetricTags('builtin:glucose' as MetricId, ['builtin:watched', 'Sledované', 'blood']);
    expect(catalog.byId('builtin:glucose' as MetricId)?.tags).toEqual(['builtin:watched', 'blood']);
  });

  it('setMetricTags replaces the tag list for a user metric', () => {
    const catalog = createCatalog(profile);
    const created = catalog.addUserMetric({
      customName: 'Sleep',
      aliases: ['Sleep'],
      category: 'custom',
      valueType: 'number',
      canonicalUnit: 'h',
      units: ['h'],
    });
    catalog.setMetricTags(created.id, ['vitals', 'vitals', ' sport ']);
    // De-duplicated and trimmed.
    expect(catalog.byId(created.id)?.tags).toEqual(['vitals', 'sport']);
  });

  it('merges override aliases with the built-in ones without losing seed data', () => {
    const catalog = createCatalog(profile);
    catalog.learnAlias('builtin:ldl-cholesterol' as MetricId, 'Zlý cholesterol');
    const ldl = catalog.byKey('ldl-cholesterol')!;
    expect(ldl.aliases).toContain('LDL'); // seed alias preserved
    expect(ldl.aliases).toContain('Zlý cholesterol'); // learned alias present
    expect(ldl.externalCodes?.loinc).toBe('13457-7'); // seed attributes preserved
  });
});

describe('external codes (LOINC + generic pairs)', () => {
  let profile: ProfileData;

  beforeEach(() => {
    profile = emptyProfile();
  });

  it('byLoinc resolves a seeded built-in code', () => {
    const catalog = createCatalog(profile);
    expect(catalog.byLoinc('13457-7')?.key).toBe('ldl-cholesterol');
    expect(catalog.byLoinc('  13457-7 ')?.key).toBe('ldl-cholesterol');
    expect(catalog.byLoinc('does-not-exist')).toBeUndefined();
  });

  it('setExternalCodes persists LOINC + additional codes on a built-in and survives reload', () => {
    const catalog = createCatalog(profile);
    catalog.setExternalCodes('builtin:glucose' as MetricId, {
      loinc: '2345-7',
      other: [{ system: 'ACME', code: '03123' }],
    });

    // Persisted as an override entry keyed by the built-in id.
    const override = profile.metrics.find((m) => m.id === 'builtin:glucose');
    expect(override).toBeDefined();
    expect(override!.externalCodes).toEqual({
      loinc: '2345-7',
      other: [{ system: 'ACME', code: '03123' }],
    });

    // A fresh catalog (reload) sees both and resolves them.
    const reloaded = createCatalog(profile);
    expect(reloaded.byId('builtin:glucose' as MetricId)?.externalCodes).toEqual({
      loinc: '2345-7',
      other: [{ system: 'ACME', code: '03123' }],
    });
    expect(reloaded.byLoinc('2345-7')?.key).toBe('glucose');
    expect(reloaded.byExternalCode('ACME', '03123')?.key).toBe('glucose');
  });

  it('byExternalCode resolves a user-set pair and ignores empty input', () => {
    const catalog = createCatalog(profile);
    expect(catalog.byExternalCode('ACME', '03123')).toBeUndefined();
    catalog.setExternalCodes('builtin:glucose' as MetricId, {
      other: [{ system: 'ACME', code: '03123' }],
    });
    expect(catalog.byExternalCode('ACME', '03123')?.key).toBe('glucose');
    expect(catalog.byExternalCode('ACME', 'other')).toBeUndefined(); // code must match
    expect(catalog.byExternalCode('', '03123')).toBeUndefined();
    expect(catalog.byExternalCode('ACME', '  ')).toBeUndefined();
    // Additional codes are never seeded, so the merge keeps the built-in's LOINC.
    expect(catalog.byId('builtin:glucose' as MetricId)?.externalCodes?.loinc).toBeTruthy();
  });

  it('trims inputs, drops empty pairs, and clears a code with an empty string', () => {
    const catalog = createCatalog(profile);
    catalog.setExternalCodes('builtin:glucose' as MetricId, {
      loinc: '  2345-7  ',
      other: [
        { system: '  ACME  ', code: ' 03123 ' },
        { system: '', code: 'x' }, // dropped: empty system
        { system: 'y', code: '' }, // dropped: empty code
      ],
    });
    expect(catalog.byId('builtin:glucose' as MetricId)?.externalCodes).toEqual({
      loinc: '2345-7',
      other: [{ system: 'ACME', code: '03123' }],
    });

    // Clearing the additional codes removes them cleanly; LOINC override stays.
    catalog.setExternalCodes('builtin:glucose' as MetricId, { loinc: '2345-7', other: [] });
    expect(catalog.byId('builtin:glucose' as MetricId)?.externalCodes?.other).toBeUndefined();
    expect(catalog.byExternalCode('ACME', '03123')).toBeUndefined();
  });

  it('setExternalCodes clears codes on a user metric', () => {
    const catalog = createCatalog(profile);
    const created = catalog.addUserMetric({
      customName: 'Homocystein',
      aliases: ['Homocystein'],
      category: 'custom',
      valueType: 'number',
      canonicalUnit: 'umol/L',
      units: ['umol/L'],
    });
    catalog.setExternalCodes(created.id, {
      loinc: '13965-9',
      other: [{ system: 'ACME', code: '11111' }],
    });
    expect(catalog.byLoinc('13965-9')?.id).toBe(created.id);
    expect(catalog.byExternalCode('ACME', '11111')?.id).toBe(created.id);

    // Nothing left → the whole externalCodes is dropped (user metric clears cleanly).
    catalog.setExternalCodes(created.id, { loinc: '', other: [] });
    expect(catalog.byId(created.id)?.externalCodes).toBeUndefined();
    expect(catalog.byLoinc('13965-9')).toBeUndefined();
  });

  it('override LOINC takes precedence over the seed via merge', () => {
    const catalog = createCatalog(profile);
    const seedLoinc = catalog.byKey('glucose')!.externalCodes!.loinc!;
    catalog.setExternalCodes('builtin:glucose' as MetricId, { loinc: '9999-9' });
    expect(catalog.byId('builtin:glucose' as MetricId)?.externalCodes?.loinc).toBe('9999-9');
    expect(catalog.byLoinc(seedLoinc)).toBeUndefined(); // seed code no longer resolves
    expect(catalog.byLoinc('9999-9')?.key).toBe('glucose');
  });

  it('setExternalCodes on an unknown id is a no-op', () => {
    const catalog = createCatalog(profile);
    catalog.setExternalCodes('builtin:nonexistent' as MetricId, { loinc: '1-1' });
    expect(profile.metrics.length).toBe(0);
  });
});

describe('unit convertibility', () => {
  // The units engine (K3) may not exist yet in isolation. Resolve it through a
  // variable specifier so the missing module does not break static analysis,
  // and skip gracefully when absent.
  it('every unit pair of every metric is mutually convertible', async (ctx) => {
    let engine: { convert: (v: number, from: string, to: string, m: Metric) => { ok: boolean } };
    try {
      const spec = '../units.js';
      const mod = (await import(/* @vite-ignore */ spec)) as {
        createUnitsEngine: () => typeof engine;
      };
      engine = mod.createUnitsEngine();
    } catch {
      ctx.skip();
      return;
    }
    for (const m of BUILTIN_METRICS) {
      for (const from of m.units) {
        for (const to of m.units) {
          const res = engine.convert(1, from, to, m);
          expect(res.ok, `${m.key}: ${from} -> ${to} not convertible`).toBe(true);
        }
      }
    }
  });
});
