import { describe, expect, it } from 'vitest';
import { createCatalog } from '../../../../../../core/catalog';
import type { ProfileData, ProfileId } from '../../../../../../core/types';
import { smartmedixDailyPatientRecordParser as parser } from '../smartmedix-daily-patient-record';

function catalog() {
  const data: ProfileData = {
    schemaVersion: 1,
    profile: { id: 'p1' as ProfileId, name: 'T', createdAt: '2026-01-01' },
    metrics: [],
    sources: [],
    measurements: [],
    settings: {},
  };
  return createCatalog(data);
}

const LINES = [
  'Laboratorní výsledky:',
  'Odebráno: 14.02.2026 07:35:00 diabetologie Glukóza: 5,5 mmol/L; Kyselina močová: 501',
  'μmol/L (220-450) ; Kreatinin enzymaticky: 91 μmol/L; Cholesterol non-HDL: 4,85 mmol/L (0-3,8) ;',
  'Odebráno: 14.02.2026 07:35:00 moč chemicky Bílkovina: negativní; Glukóza: negativní; Erytrocyty: <4 počet/μL;',
  'Seznam metod:: Moč chemicky a mikroskopicky, Krevní obraz;',
];

describe('smartmedix_daily_patient_record parser', () => {
  const p = parser.parse(LINES, catalog());
  const find = (frag: string) =>
    p.find((x) =>
      typeof x.metric === 'object' ? x.metric.unresolvedName.includes(frag) : x.rawText?.startsWith(frag),
    );

  it('detects the "Odebráno:" format', () => {
    expect(parser.detect(LINES)).toBe(true);
  });

  it('parses numeric value + unit + range + datetime', () => {
    const glc = p.find((x) => x.metric === 'builtin:glucose' && x.value === 5.5);
    expect(glc?.unit).toBe('mmol/L');
    expect(glc?.takenAt).toBe('2026-02-14T07:35:00');
    const ua = p.find((x) => x.metric === 'builtin:uric-acid');
    expect(ua?.value).toBe(501);
    expect(ua?.refHigh).toBe(450);
  });

  it('strips a trailing method word ("Kreatinin enzymaticky" -> creatinine)', () => {
    expect(p.some((x) => x.metric === 'builtin:creatinine' && x.value === 91)).toBe(true);
  });

  it('maps "Cholesterol non-HDL" to non-HDL cholesterol, never onto HDL', () => {
    const nonhdl = find('Cholesterol non-HDL');
    expect(nonhdl).toBeDefined();
    expect(nonhdl!.metric).not.toBe('builtin:hdl-cholesterol');
    // non-HDL is a seeded metric, so it resolves rather than staying unresolved.
    expect(nonhdl!.metric).toBe('builtin:non-hdl-cholesterol');
  });

  it('keeps urine analytes out of blood metrics (moč context)', () => {
    // Urine glucose must never resolve to blood glucose.
    const urineGlucose = p.filter((x) => x.rawText?.startsWith('Glukóza') && x.textValue === 'negativní');
    expect(urineGlucose.length).toBe(1);
    expect(urineGlucose[0].metric).not.toBe('builtin:glucose');
  });

  it('drops comment/heading rows', () => {
    expect(p.some((x) => x.rawText?.startsWith('Seznam metod'))).toBe(false);
  });
});
