/**
 * Declarative import mappings — the data-driven core of "external plugins".
 *
 * A user can add support for a new lab / text format by importing a JSON pack
 * that carries an {@link ImportMappingDef}: a `detect` substring set plus a
 * regex `pattern` with named groups. This module turns one such definition into
 * an ordinary {@link LabParser} — the SAME interface a hand-written lab parser
 * implements — so the existing parser chain, review pipeline and storage do not
 * change.
 *
 * Security boundary: a mapping is DATA, never code. Its strings are only ever
 * compiled with `new RegExp` (wrapped in try/catch) and matched against text;
 * nothing is `eval`-ed. That keeps it inside the app's strict `script-src
 * 'self'` CSP and the offline privacy model. As a ReDoS guard, any single entry
 * or line longer than {@link MAX_ENTRY_LEN} characters is skipped rather than
 * fed to a regex.
 *
 * Design rule (spec §16): never guess. A name that does not resolve becomes an
 * `unresolvedName` for the user to map once; a value that is not numeric and not
 * a short qualitative token is dropped rather than invented.
 */

import type { Catalog } from '../../core/contracts';
import type { ImportMappingDef, ProposedMeasurement } from '../../core/types';
import { normalizeUnit, parseDateTime, parseNumber, resolveMetric } from '../../core/normalize';
import type { LabParser } from './lab-parsers';

/** ReDoS guard: never run a regex on an entry longer than this many chars. */
const MAX_ENTRY_LEN = 2000;

/** A qualitative token is accepted only when it is short (≤20 chars, ≤2 words). */
function shortQualitative(raw: string): string | undefined {
  const s = raw.trim();
  if (s === '' || s.length > 20) return undefined;
  if (s.split(/\s+/).length > 2) return undefined;
  if (/[:()]/.test(s)) return undefined;
  return s;
}

/** Compile a pattern safely; undefined when it is invalid or lacks a name group. */
function compilePattern(pattern: string): RegExp | undefined {
  if (!/\(\?<name>/.test(pattern)) return undefined;
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

function compileOptional(pattern: string | undefined): RegExp | undefined {
  if (pattern === undefined) return undefined;
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

/** Parse a bare numeric bound; undefined when it is not a plain number. */
function parseBound(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = parseNumber(raw);
  return 'value' in parsed ? parsed.value : undefined;
}

/** Scan every line for the document date using `datePattern`; the first hit wins. */
function findDate(
  lines: string[],
  dateRe: RegExp | undefined,
): { iso: string; precision: 'date' | 'datetime' } | undefined {
  if (!dateRe) return undefined;
  for (const line of lines) {
    if (line.length > MAX_ENTRY_LEN) continue;
    const m = dateRe.exec(line);
    if (!m) continue;
    // Prefer a named `date` group, else the first capture group, else the match.
    const raw = m.groups?.date ?? m[1] ?? m[0];
    const parsed = parseDateTime(raw);
    if (parsed) return parsed;
  }
  return undefined;
}

/** Build one proposal from a single regex match's named groups. */
function proposalFromMatch(
  groups: Record<string, string | undefined>,
  rawText: string,
  catalog: Catalog,
  date: { iso: string; precision: 'date' | 'datetime' } | undefined,
): ProposedMeasurement | undefined {
  const name = (groups.name ?? '').trim();
  if (name === '' || !/\p{L}/u.test(name)) return undefined;

  const resolved = resolveMetric(name, catalog);
  const metric =
    'metricId' in resolved ? resolved.metricId : { unresolvedName: resolved.unresolvedName };

  const proposal: ProposedMeasurement = { metric, confidence: 'medium', rawText };

  // Value: numeric first, then a short qualitative token; never invent one.
  const rawValue = (groups.value ?? '').trim();
  if (rawValue !== '') {
    const parsed = parseNumber(rawValue);
    if ('value' in parsed) {
      proposal.value = parsed.value;
      if (parsed.operator !== undefined) proposal.operator = parsed.operator;
      const unit = groups.unit !== undefined ? normalizeUnit(groups.unit) : undefined;
      if (unit !== undefined) proposal.unit = unit;
    } else {
      const token = shortQualitative(rawValue);
      if (token !== undefined) proposal.textValue = token;
    }
  }

  const refLow = parseBound(groups.low);
  const refHigh = parseBound(groups.high);
  if (refLow !== undefined) proposal.refLow = refLow;
  if (refHigh !== undefined) proposal.refHigh = refHigh;

  if (date) {
    proposal.takenAt = date.iso;
    proposal.timePrecision = date.precision;
  }
  return proposal;
}

/**
 * Turn a declarative {@link ImportMappingDef} into a {@link LabParser}. An
 * invalid pattern yields a parser that detects nothing and parses to `[]`
 * (correctness over crashing): validation at pack-import time already rejects
 * such definitions, this is belt-and-braces for a mapping built directly.
 */
export function declarativeLabParser(def: ImportMappingDef): LabParser {
  const needles = def.detect.anyOf.map((s) => s.toLowerCase());
  const patternRe = compilePattern(def.pattern);
  const dateRe = compileOptional(def.datePattern);

  return {
    id: `mapping:${def.id}`,
    sourceName: def.sourceName,
    detect(lines: string[]): boolean {
      if (patternRe === undefined) return false;
      const haystack = lines.join('\n').toLowerCase();
      return needles.some((n) => haystack.includes(n));
    },
    parse(lines: string[], catalog: Catalog): ProposedMeasurement[] {
      if (patternRe === undefined) return [];
      const date = findDate(lines, dateRe);
      const out: ProposedMeasurement[] = [];
      for (const line of lines) {
        if (line.length > MAX_ENTRY_LEN) continue;
        const entries = def.entrySplit ? line.split(def.entrySplit) : [line];
        for (const entry of entries) {
          const trimmed = entry.trim();
          if (trimmed === '' || trimmed.length > MAX_ENTRY_LEN) continue;
          // Fresh lastIndex each time (patternRe is not global, but be explicit).
          const m = patternRe.exec(trimmed);
          if (!m || !m.groups) continue;
          const proposal = proposalFromMatch(m.groups, trimmed, catalog, date);
          if (proposal) out.push({ ...proposal, sourceName: def.sourceName });
        }
      }
      return out;
    },
  };
}
