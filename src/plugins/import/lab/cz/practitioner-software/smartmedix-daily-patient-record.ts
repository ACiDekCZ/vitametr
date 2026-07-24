/**
 * Lab parser for the SmartMedix / Praktik "daily patient record" export — a
 * Czech general-practitioner practice-management application. Its printout packs
 * results into inline blocks that wrap across lines:
 *   "Odebráno: <date time> <category> Analyte: value unit (range); …"
 *
 * Beyond basic extraction it:
 *  - tracks the block category and, for a urine block ("moč …"), resolves against
 *    the urine-qualified name (so urine analytes never collide with blood ones),
 *  - splits "ABBR - Czech name" only on a spaced dash (so "non-HDL" is intact),
 *  - strips trailing method words ("enzymaticky", "screening") on a failed match,
 *  - drops comment/heading rows (parenthetical, long prose, names with digits).
 * Unknown names go to review as usual (correctness over guessing).
 *
 * The Czech literals below are DATA: they match the source document's wording
 * and must stay in Czech.
 */

import type { Catalog } from '../../../../../core/contracts';
import type { Operator, ProposedMeasurement } from '../../../../../core/types';
import type { LabParser } from '../../../lab-parsers';
import { normalizeUnit, resolveMetric } from '../../../../../core/normalize';
import { createUnitsEngine, isUnitCompatibleWithMetric } from '../../../../../core/units';

/** Built-in units engine for the dimension guard (this parser sees only the seed). */
const unitsEngine = createUnitsEngine();

const QUALITATIVE =
  /^(negativní|pozitivní|neg\.?|poz\.?|hraniční|stopy|stopově|nález|bez nálezu|v mezích|velmi četně|četně|ojediněle|slabá|silná|zvýšená?|snížená?)$/i;

/** Trailing method qualifiers to strip when a name does not resolve as-is. */
const METHOD_WORDS = /\s+(enzymaticky|screening|kvantitativně|kvalitativně|Jaffé|IFCC|celk\.?)$/iu;

function parseCzDateTime(raw: string): { iso: string; precision: 'date' | 'datetime' } | undefined {
  const m = /(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(raw);
  if (!m) return undefined;
  const [, d, mo, y, hh, mm, ss] = m;
  if (hh !== undefined) return { iso: `${y}-${mo}-${d}T${hh}:${mm}:${ss ?? '00'}`, precision: 'datetime' };
  return { iso: `${y}-${mo}-${d}`, precision: 'date' };
}

const num = (s: string): number => Number(s.replace(/\s/g, '').replace(',', '.'));

interface ParsedValue {
  value?: number;
  textValue?: string;
  operator?: Operator;
  unit?: string;
  refLow?: number;
  refHigh?: number;
}

/** Parse "Název:" value — numeric (op/unit/range) or a SHORT qualitative token. */
function parseValue(raw: string): ParsedValue | undefined {
  const s = raw.trim().replace(/;+$/, '').trim();
  if (s === '' || s.startsWith(':')) return undefined; // empty / stray comment colon
  if (QUALITATIVE.test(s)) return { textValue: s };

  const m = /^([<>]=?)?\s*(\d+(?:[.,]\d+)?)\s*([^\s(]+(?:\/[^\s(]+)?)?\s*(?:\(\s*(\d+(?:[.,]\d+)?)\s*-\s*(\d+(?:[.,]\d+)?)\s*\))?/.exec(
    s,
  );
  if (m && m[2] !== undefined) {
    const [, op, value, unit, low, high] = m;
    const out: ParsedValue = { value: num(value) };
    if (op) out.operator = op as Operator;
    if (unit) out.unit = unit;
    if (low !== undefined) out.refLow = num(low);
    if (high !== undefined) out.refHigh = num(high);
    return out;
  }
  // Non-numeric, unlisted: accept only a short token (else it's prose → skip).
  if (s.length <= 20 && s.split(/\s+/).length <= 2 && !/[:()]/.test(s)) return { textValue: s };
  return undefined;
}

/** True for names that are clearly comment/heading fragments, not analytes. */
function looksLikeComment(name: string): boolean {
  return name === '' || name.length > 32 || name.startsWith('(') || /\d/.test(name) || name.includes(':');
}

/** Resolve a blood-panel name: whole, then spaced "ABBR - název" halves, then
 *  with a trailing method word stripped. */
function resolveBlood(name: string, catalog: Catalog): ProposedMeasurement['metric'] {
  const hit = catalog.resolveAlias(name);
  if (hit) return hit.id;
  for (const part of name.split(/\s+-\s+/)) {
    const h = catalog.resolveAlias(part.trim());
    if (h) return h.id;
  }
  const stripped = name.replace(METHOD_WORDS, '').trim();
  if (stripped !== name) {
    const h = catalog.resolveAlias(stripped);
    if (h) return h.id;
  }
  // Shared resolver last: it handles "Full name (ABBR)" and specimen parens that a
  // plain alias lookup misses — e.g. "Odhad filtr. CKD-EPI (Krea)" resolves to eGFR
  // (the "(Krea)" is a variant qualifier, not the creatinine analyte).
  const r = resolveMetric(name, catalog);
  return 'metricId' in r ? r.metricId : { unresolvedName: name.trim() };
}

/** Resolve a urine-block name against the urine-qualified metric; never fall
 *  back to a blood metric (keeps urine sediment distinct from blood counts). */
function resolveUrine(name: string, catalog: Catalog): ProposedMeasurement['metric'] {
  const hit = catalog.resolveAlias(`${name} v moči`) ?? catalog.resolveAlias(`${name} moč`);
  if (hit) return hit.id;
  return { unresolvedName: `${name.trim()} (moč)` };
}

/** Leading lowercase words after the datetime are the block category. */
function categoryOf(body: string): string {
  const m = /^([\p{Ll}\s]+?)\s+\p{Lu}/u.exec(body);
  return (m?.[1] ?? '').trim();
}

function blocks(lines: string[]): string[] {
  const out: string[] = [];
  let cur: string | undefined;
  for (const line of lines) {
    if (/^Odebráno:/i.test(line.trim())) {
      if (cur !== undefined) out.push(cur);
      cur = line;
    } else if (cur !== undefined) {
      if (/:\s*$/.test(line) && !line.includes(';')) {
        out.push(cur);
        cur = undefined;
      } else cur += ' ' + line;
    }
  }
  if (cur !== undefined) out.push(cur);
  return out;
}

export const smartmedixDailyPatientRecordParser: LabParser = {
  id: 'smartmedix_daily_patient_record',
  sourceName: 'SmartMedix / Praktik (denní záznam)',
  detect: (lines) => lines.some((l) => /^Odebráno:/i.test(l.trim())),
  parse: (lines, catalog) => {
    const proposals: ProposedMeasurement[] = [];
    for (const block of blocks(lines)) {
      const when = parseCzDateTime(block);
      const body = block.replace(
        /^Odebráno:\s*\d{2}\.\d{2}\.\d{4}(?:\s+\d{2}:\d{2}(?::\d{2})?)?\s*/i,
        '',
      );
      // The urine block is not always labelled "moč" — detect it by its
      // tell-tale markers (dipstick / sediment analytes and units).
      const isUrine =
        /moč/i.test(categoryOf(body)) ||
        /počet\/[μu]L|Nitrity|Urobilinogen|Specif\. hmotnost|Epitelie|Ketolátky/i.test(body);
      const entries = body.split(';');
      let first = true;
      for (const entry of entries) {
        const colon = entry.indexOf(':');
        if (colon < 0) {
          first = false;
          continue;
        }
        let name = entry.slice(0, colon).trim();
        if (first) name = name.replace(/^\s*(\p{Ll}[\p{Ll}\s]*?)\s+(?=\p{Lu})/u, ''); // drop category
        first = false;
        if (looksLikeComment(name)) continue;
        const parsed = parseValue(entry.slice(colon + 1));
        if (!parsed) continue;
        const p: ProposedMeasurement = {
          metric: isUrine ? resolveUrine(name, catalog) : resolveBlood(name, catalog),
          confidence: 'medium',
          rawText: entry.trim(),
        };
        if (parsed.value !== undefined) p.value = parsed.value;
        if (parsed.textValue !== undefined) p.textValue = parsed.textValue;
        if (parsed.operator !== undefined) p.operator = parsed.operator;
        // Normalize the unit to a UCUM code where we recognize it (urine sediment
        // "počet/μL" isn't a catalog unit, so units are dropped for urine).
        let unitCode: string | undefined;
        if (parsed.unit !== undefined && !isUrine) {
          unitCode = normalizeUnit(parsed.unit);
          p.unit = unitCode ?? parsed.unit;
        }
        if (parsed.refLow !== undefined) p.refLow = parsed.refLow;
        if (parsed.refHigh !== undefined) p.refHigh = parsed.refHigh;
        // Dimension guard: a resolved metric whose RECOGNIZED unit is dimensionally
        // incompatible is a mis-pair (e.g. a misaligned PDF row crossing a `fL`
        // value into a mmol/L lipid). Drop the resolution to review — never store a
        // value under the wrong metric (spec §16: correctness over auto-storage).
        if (typeof p.metric === 'string' && unitCode !== undefined) {
          const m = catalog.byId(p.metric);
          if (m && !isUnitCompatibleWithMetric(unitsEngine, m, unitCode)) {
            p.metric = { unresolvedName: name.trim() };
          }
        }
        if (when) {
          p.takenAt = when.iso;
          p.timePrecision = when.precision;
        }
        proposals.push(p);
      }
    }
    return proposals;
  },
};
