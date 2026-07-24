import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createCatalog } from '../../core/catalog.js';
import { createImportPipeline, type ImportPipelineDeps } from '../../core/review.js';
import type {
  MeasurementId,
  ProfileData,
  ProfileId,
  ProposedMeasurement,
} from '../../core/types.js';
import {
  isPack,
  packExternalCodes,
  packMetricToSpec,
  packTags,
  parsePack,
  type PackMetricDef,
  type VitametrPack,
} from '../import/pack.js';
import { metricToPackDef } from '../../ui/views/catalog-actions.js';
import type { AppContext } from '../../ui/app-context.js';
import type { Metric, MetricId } from '../../core/types.js';

function demoPack(): VitametrPack {
  const raw = readFileSync(new URL('../../../test/fixtures/demo-pack.json', import.meta.url), 'utf8');
  return parsePack(raw);
}

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

function deps(): ImportPipelineDeps {
  let n = 0;
  return { newId: () => `m${++n}` as MeasurementId, now: () => '2026-07-21T10:00', profileId: 'p1' as ProfileId };
}

describe('parsePack', () => {
  it('parses the demo fixture', () => {
    const pack = demoPack();
    expect(pack.id).toBe('demo-all-types');
    expect(pack.metrics).toHaveLength(4);
    expect(pack.measurements).toHaveLength(5);
  });

  it('rejects a non-pack', () => {
    expect(() => parsePack('{"format":"something-else"}')).toThrow();
    expect(isPack({ format: 'vitametr-pack', id: 'x' })).toBe(true);
  });

  it('requires enumValues for enum/multi metrics', () => {
    expect(() =>
      parsePack({ format: 'vitametr-pack', version: 1, id: 'x', metrics: [{ key: 'k', name: 'N', valueType: 'enum' }] }),
    ).toThrow(/enumValues/);
  });
});

describe('parsePack — importMappings', () => {
  const base = (mapping: unknown) => ({
    format: 'vitametr-pack',
    version: 1,
    id: 'x',
    importMappings: [mapping],
  });

  it('accepts a valid declarative import mapping', () => {
    const pack = parsePack(
      base({
        id: 'm1',
        sourceName: 'Lab',
        detect: { anyOf: ['LAB'] },
        pattern: '(?<name>[^:]+):\\s*(?<value>\\d+)',
      }),
    );
    expect(pack.importMappings).toHaveLength(1);
  });

  it('rejects a mapping without an id or sourceName', () => {
    expect(() => parsePack(base({ sourceName: 'L', detect: { anyOf: ['X'] }, pattern: '(?<name>.+)' }))).toThrow();
    expect(() => parsePack(base({ id: 'm', detect: { anyOf: ['X'] }, pattern: '(?<name>.+)' }))).toThrow(/sourceName/);
  });

  it('rejects an empty detect.anyOf', () => {
    expect(() =>
      parsePack(base({ id: 'm', sourceName: 'L', detect: { anyOf: [] }, pattern: '(?<name>.+)' })),
    ).toThrow(/detect/);
  });

  it('rejects a pattern that does not compile', () => {
    expect(() =>
      parsePack(base({ id: 'm', sourceName: 'L', detect: { anyOf: ['X'] }, pattern: '(?<name>[' })),
    ).toThrow(/invalid pattern/);
  });

  it('rejects a pattern with no name group', () => {
    expect(() =>
      parsePack(base({ id: 'm', sourceName: 'L', detect: { anyOf: ['X'] }, pattern: '(?<value>\\d+)' })),
    ).toThrow(/name/);
  });
});

describe('packMetricToSpec', () => {
  it('maps a number metric to a unit-bearing spec', () => {
    const spec = packMetricToSpec(
      { key: 'glc', name: 'Glukóza', valueType: 'number', unit: 'mmol/L' },
      'p',
    );
    expect(spec.valueType).toBe('number');
    expect(spec.canonicalUnit).toBe('mmol/L');
    expect(spec.units).toEqual(['mmol/L']);
    expect(spec.aliases).toContain('Glukóza'); // name seeded as alias
    expect(spec.pack).toBe('p');
  });

  it('maps enum/multi to unitless specs carrying enumValues', () => {
    const enumSpec = packMetricToSpec(
      { key: 'up', name: 'Bílkovina', valueType: 'enum', enumValues: ['neg', 'pos'] },
      'p',
    );
    expect(enumSpec.canonicalUnit).toBe('');
    expect(enumSpec.units).toEqual([]);
    expect(enumSpec.enumValues).toEqual(['neg', 'pos']);
  });
});

describe('pack tags + external codes round-trip', () => {
  // A minimal ctx: metricToPackDef only reads ctx.t (via metricName), and a
  // custom metric resolves its name from customName, not the translator.
  const ctx = { t: (k: string) => k } as unknown as AppContext;

  const metric = (extra: Partial<Metric>): Metric => ({
    id: 'user:1' as MetricId,
    customName: 'My analyte',
    aliases: [],
    category: 'custom',
    valueType: 'number',
    canonicalUnit: 'mmol/L',
    units: ['mmol/L'],
    ...extra,
  });

  /** Serialize one metric def through a full pack JSON and back to a spec. */
  const roundTrip = (def: PackMetricDef): ReturnType<typeof packMetricToSpec> => {
    const pack: VitametrPack = {
      format: 'vitametr-pack',
      version: 1,
      id: 'p',
      metrics: [def],
    };
    const parsed = parsePack(JSON.stringify(pack));
    return packMetricToSpec((parsed.metrics ?? [])[0], parsed.id);
  };

  it('exports tags + codes when the toggles are on, and re-import applies them', () => {
    const m = metric({
      tags: ['lipids', 'blood'],
      externalCodes: { loinc: '2093-3', other: [{ system: 'SNOMED', code: '123' }] },
    });
    const def = metricToPackDef(ctx, m, { includeTags: true, includeCodes: true });
    expect(def.tags).toEqual(['lipids', 'blood']);
    expect(def.externalCodes).toEqual({
      loinc: '2093-3',
      other: [{ system: 'SNOMED', code: '123' }],
    });

    const spec = roundTrip(def);
    expect(spec.tags).toEqual(['lipids', 'blood']);
    expect(spec.externalCodes).toEqual({
      loinc: '2093-3',
      other: [{ system: 'SNOMED', code: '123' }],
    });
  });

  it('omits tags + codes when the toggles are off', () => {
    const m = metric({ tags: ['lipids'], externalCodes: { loinc: '2093-3' } });
    const def = metricToPackDef(ctx, m, { includeTags: false, includeCodes: false });
    expect(def.tags).toBeUndefined();
    expect(def.externalCodes).toBeUndefined();

    const spec = roundTrip(def);
    expect(spec.tags).toBeUndefined();
    expect(spec.externalCodes).toBeUndefined();
  });

  it('reads a legacy loinc shorthand into externalCodes', () => {
    const spec = packMetricToSpec({ key: 'k', name: 'N', loinc: '1234-5' }, 'p');
    expect(spec.externalCodes).toEqual({ loinc: '1234-5' });
  });

  it('ignores malformed tags / codes gracefully', () => {
    expect(packTags({ key: 'k', name: 'N', tags: ['ok', '', 42] as never })).toEqual(['ok']);
    expect(packTags({ key: 'k', name: 'N', tags: 'nope' as never })).toBeUndefined();
    expect(
      packExternalCodes({
        key: 'k',
        name: 'N',
        externalCodes: { other: [{ system: 'S', code: 'C' }, { system: 1 } as never] },
      }),
    ).toEqual({ other: [{ system: 'S', code: 'C' }] });
  });
});

describe('pack registration + commit (all four value types)', () => {
  it('registers metrics and commits number/text/enum/multi measurements', () => {
    const pack = demoPack();
    const data = emptyProfile();
    const catalog = createCatalog(data);

    // Register the pack's metric definitions (mirrors runPackImport).
    const keyToId = new Map<string, string>();
    for (const def of pack.metrics ?? []) {
      const existing = catalog.byKey(def.key) ?? catalog.resolveAlias(def.name);
      const m = existing ?? catalog.addUserMetric(packMetricToSpec(def, pack.id));
      keyToId.set(def.key, m.id);
    }
    expect(catalog.all().filter((m) => m.pack === 'demo-all-types')).toHaveLength(4);

    // Propose + commit the measurements.
    const proposals: ProposedMeasurement[] = (pack.measurements ?? []).map((mm) => ({
      metric: keyToId.get(mm.metric) as never,
      ...(mm.value !== undefined ? { value: mm.value } : {}),
      ...(mm.textValue !== undefined ? { textValue: mm.textValue } : {}),
      ...(mm.textValues !== undefined ? { textValues: mm.textValues } : {}),
      ...(mm.unit !== undefined ? { unit: mm.unit } : {}),
      ...(mm.takenAt !== undefined ? { takenAt: mm.takenAt } : {}),
      confidence: 'high',
    }));
    const pipeline = createImportPipeline(catalog, deps());
    const items = pipeline.prepare(proposals, { catalog });
    for (const item of items) item.decision = 'accept';
    const out = pipeline.commit(items, { pluginId: 'pack' });

    expect(out).toHaveLength(5);
    const byMetric = (key: string) => out.filter((m) => m.metricId === keyToId.get(key));
    expect(byMetric('demo-glucose').map((m) => m.value)).toEqual([5.4, 6.1]);
    expect(byMetric('demo-note')[0].textValue).toBe('cítím se dobře');
    expect(byMetric('demo-urine-protein')[0].textValue).toBe('negativní');
    expect(byMetric('demo-symptoms')[0].textValues).toEqual(['únava', 'bolest hlavy']);
    // Qualitative measurements carry no unit.
    expect(byMetric('demo-note')[0].unit).toBe('');
  });
});
