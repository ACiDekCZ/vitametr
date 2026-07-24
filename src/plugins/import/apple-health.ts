/**
 * Apple Health import plugin (phase 2).
 *
 * Turns the `<Record>` elements of an Apple Health `export.xml` into reviewable
 * `ProposedMeasurement`s. A real export comes from the iOS Health app
 * ("Export All Health Data"): a ZIP whose `export.xml` holds thousands of
 * `<Record type="HKQuantityTypeIdentifier..." unit="..." value="..."
 * startDate="..." sourceName="..." .../>` elements. Clinical lab results live in
 * a separate FHIR "Health Records" section and are handled by the FHIR plugin.
 *
 * Parsing strategy: no XML library and no DOM (the plugin must run in Node test
 * environments with zero runtime dependencies). We scan the text for `<Record`
 * elements with a regex and pull the attributes we care about out of each match.
 * Attribute values are XML-entity-decoded (`&lt;` etc.) before use — Apple, for
 * example, encodes the molar-concentration unit as `mmol&lt;L&gt;`.
 *
 * Design rules (spec §16): never guess.
 *  - Only a fixed set of HealthKit `type` identifiers map to our metric keys;
 *    any other type is skipped entirely (no proposal emitted).
 *  - A mapped key is resolved through `catalog.byKey(key)`; if the catalog has
 *    no such metric the record is skipped rather than guessed.
 *  - Apple's own unit spellings are mapped through a dedicated table (Apple does
 *    not use UCUM); an unknown unit falls back to `normalizeUnit`, and if that
 *    also fails the unit is left undefined and confidence is lowered.
 *  - Dates are wall-clock: Apple writes `2023-02-10 08:00:00 +0100`; we swap the
 *    date/time separator to `T`, drop the timezone offset, and never touch the
 *    system clock.
 *
 * Malformed or missing attributes degrade gracefully and never throw.
 */

import type { Catalog, ImportContext, ImportInput, ImportPlugin } from '../../core/contracts.js';
import type { MetricId, ProposedMeasurement, TimePrecision } from '../../core/types.js';
import { normalizeUnit } from '../../core/normalize.js';
import { isZipFile, listZipEntries, openZipEntry, type ZipEntry } from './zip.js';

/**
 * HealthKit quantity type identifier -> our built-in metric key. Any identifier
 * absent from this table is skipped (unmapped types produce no proposal).
 */
const TYPE_TO_KEY: Readonly<Record<string, string>> = {
  HKQuantityTypeIdentifierBodyMass: 'body-weight',
  HKQuantityTypeIdentifierBloodPressureSystolic: 'bp-systolic',
  HKQuantityTypeIdentifierBloodPressureDiastolic: 'bp-diastolic',
  HKQuantityTypeIdentifierHeartRate: 'heart-rate',
  HKQuantityTypeIdentifierBloodGlucose: 'glucose',
  HKQuantityTypeIdentifierOxygenSaturation: 'spo2',
  HKQuantityTypeIdentifierBodyTemperature: 'body-temperature',
  HKQuantityTypeIdentifierWaistCircumference: 'waist',
};

/**
 * Apple unit spelling -> UCUM code used in our catalog. Apple does not use UCUM,
 * so this map is authoritative; unknown spellings fall back to `normalizeUnit`.
 * Note `mmol<L>`: Apple stores it with angle brackets (XML-encoded as
 * `mmol&lt;L&gt;`), decoded here before lookup.
 */
const APPLE_UNIT_TO_UCUM: Readonly<Record<string, string>> = {
  kg: 'kg',
  lb: '[lb_av]',
  mmHg: 'mm[Hg]',
  'count/min': '/min',
  'mmol<L>': 'mmol/L',
  'mg/dL': 'mg/dL',
  '%': '%',
  degC: 'Cel',
  degF: '[degF]',
  cm: 'cm',
  in: '[in_i]',
};

/** Identifiers whose stored value is a 0..1 fraction that we present as a percentage. */
const FRACTION_TYPES: ReadonlySet<string> = new Set([
  'HKQuantityTypeIdentifierOxygenSaturation',
]);

/** Decode the five predefined XML entities plus numeric character references. */
function decodeXmlEntities(raw: string): string {
  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    switch (body) {
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        if (body[0] === '#') {
          const code =
            body[1] === 'x' || body[1] === 'X'
              ? Number.parseInt(body.slice(2), 16)
              : Number.parseInt(body.slice(1), 10);
          if (Number.isFinite(code) && code > 0) return String.fromCodePoint(code);
        }
        return match; // leave anything unrecognized untouched
      }
    }
  });
}

/** Pull one attribute out of a `<Record ...>` opening tag, entity-decoded. */
function attr(tag: string, name: string): string | undefined {
  // name="value" — value is any run of non-quote characters (may be empty).
  const re = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`);
  const m = re.exec(tag);
  return m ? decodeXmlEntities(m[1]) : undefined;
}

/**
 * Convert an Apple `startDate` (`2023-02-10 08:00:00 +0100`) to a wall-clock ISO
 * string: swap the first space to `T`, drop the trailing timezone offset and the
 * seconds are kept. Returns undefined if the shape is not recognized.
 * Never consults the system clock.
 */
function parseAppleDate(raw: string): { iso: string; precision: TimePrecision } | undefined {
  // date, whitespace, time, then optional whitespace + timezone offset ('+0100' / 'Z').
  const m =
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\s*(?:Z|[+-]\d{2}:?\d{2}))?$/.exec(
      raw.trim(),
    );
  if (!m) return undefined;
  return { iso: `${m[1]}T${m[2]}`, precision: 'datetime' };
}

/** Resolve an Apple unit string to a UCUM code, or undefined if unknown. */
function resolveUnit(appleUnit: string | undefined): string | undefined {
  if (appleUnit === undefined || appleUnit.trim() === '') return undefined;
  const mapped = APPLE_UNIT_TO_UCUM[appleUnit];
  if (mapped !== undefined) return mapped;
  // Fall back to the shared normalizer for spellings we did not enumerate.
  return normalizeUnit(appleUnit);
}

/** Build a proposal for one `<Record>` tag, or undefined when it must be skipped. */
function recordToProposal(tag: string, catalog: Catalog): ProposedMeasurement | undefined {
  const type = attr(tag, 'type');
  if (type === undefined) return undefined;

  // Unmapped HealthKit types are skipped entirely.
  const key = TYPE_TO_KEY[type];
  if (key === undefined) return undefined;

  // Resolve the metric via the catalog; never guess an id.
  const metric = catalog.byKey(key);
  if (metric === undefined) return undefined; // catalog missing a mapped key — skip

  // Value: must be a finite number.
  const rawValue = attr(tag, 'value');
  if (rawValue === undefined) return undefined;
  let value = Number(rawValue);
  if (!Number.isFinite(value)) return undefined;

  // OxygenSaturation is stored as a fraction (0.98) with unit '%'; scale to 98.
  if (FRACTION_TYPES.has(type)) value *= 100;

  // Unit: Apple spelling -> UCUM, with a normalizer fallback.
  const rawUnit = attr(tag, 'unit');
  const unitPresent = rawUnit !== undefined && rawUnit.trim() !== '';
  const unit = resolveUnit(rawUnit);

  // Date: wall-clock, timezone dropped.
  let takenAt: string | undefined;
  let timePrecision: TimePrecision | undefined;
  const rawDate = attr(tag, 'startDate');
  if (rawDate !== undefined) {
    const parsed = parseAppleDate(rawDate);
    if (parsed) {
      takenAt = parsed.iso;
      timePrecision = parsed.precision;
    }
  }

  const sourceName = attr(tag, 'sourceName');

  // Confidence: metric always resolves here (unmapped types were skipped).
  // High only when the unit resolved and the date parsed; otherwise medium.
  const dateOk = takenAt !== undefined;
  const unitOk = unitPresent && unit !== undefined;
  const confidence: ProposedMeasurement['confidence'] = dateOk && unitOk ? 'high' : 'medium';

  const proposal: ProposedMeasurement = {
    metric: metric.id as MetricId,
    value,
    confidence,
    rawText: tag,
  };
  if (unit !== undefined) proposal.unit = unit;
  if (takenAt !== undefined) proposal.takenAt = takenAt;
  if (timePrecision !== undefined) proposal.timePrecision = timePrecision;
  if (sourceName !== undefined && sourceName !== '') proposal.sourceName = sourceName;

  return proposal;
}

/**
 * A `<Record ...>` opening tag up to its first '>'. Attribute values never
 * contain a literal '>' (angle brackets are entity-encoded), so matching up to
 * the first '>' captures the whole tag. Shared by the string and streaming
 * scanners so the mapping/decoding logic exists in exactly one place
 * ({@link recordToProposal}).
 */
const RECORD_RE = /<Record\b[^>]*>/g;

/** Feed each `<Record>` tag found in `text` to `emit`; degrades per-record. */
function scanRecords(
  text: string,
  catalog: Catalog,
  emit: (p: ProposedMeasurement) => void,
): void {
  RECORD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RECORD_RE.exec(text)) !== null) {
    try {
      const proposal = recordToProposal(match[0], catalog);
      if (proposal) emit(proposal);
    } catch {
      // Defensive: a single malformed record must not abort the whole import.
    }
  }
}

/**
 * Pure: turn the text of an Apple Health `export.xml` into proposals. Exported
 * for tests and small inputs. Scans for `<Record ...>` opening tags
 * (self-closing or not); unmapped types are skipped and malformed records
 * degrade gracefully. Re-expressed in terms of the shared {@link scanRecords}.
 */
export function parseAppleHealthExport(xml: string, catalog: Catalog): ProposedMeasurement[] {
  const proposals: ProposedMeasurement[] = [];
  if (typeof xml !== 'string' || xml === '') return proposals;
  scanRecords(xml, catalog, (p) => proposals.push(p));
  return proposals;
}

/**
 * Upper bound for the cross-chunk carry buffer. A `<Record>` tag is short (a few
 * hundred bytes at most); if an unterminated "tag" grows past this the input is
 * pathological, so we drop the carry rather than let it grow without bound.
 */
const MAX_CARRY = 64 * 1024;

/**
 * Streaming: scan an Apple Health `export.xml` byte stream for `<Record>` tags
 * and emit a proposal per mapped record, without ever holding the whole text in
 * memory. The stream is decoded incrementally; each chunk is appended to a small
 * carry buffer holding only the last, possibly-incomplete tag. Complete tags are
 * scanned and dropped; the carry never exceeds one tag (capped at
 * {@link MAX_CARRY}). The only unbounded growth is the proposal array itself —
 * i.e. bounded by the number of *mapped* vitals, not by the file size.
 *
 * Chunk-boundary handling: after appending a chunk, the buffer is split at the
 * last unclosed '<' (a tag with no following '>'); everything before it is
 * complete and safe to scan, everything from it onward is carried into the next
 * chunk. This guarantees a `<Record …>` split across a chunk boundary is
 * reassembled before it is matched.
 */
export async function parseAppleHealthStream(
  stream: ReadableStream<Uint8Array>,
  catalog: Catalog,
): Promise<ProposedMeasurement[]> {
  const proposals: ProposedMeasurement[] = [];
  // The DOM lib types TextDecoderStream's writable as `WritableStream<BufferSource>`,
  // which `pipeThrough` rejects against a `Uint8Array` source; cast to the byte→string pair.
  const decode = new TextDecoderStream('utf-8') as unknown as ReadableWritablePair<
    string,
    Uint8Array
  >;
  const reader = stream.pipeThrough(decode).getReader();
  let carry = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      let buf = carry + value;

      // Find the last '<' that has no '>' after it — the start of an incomplete
      // trailing tag. Scan everything before it now; carry the rest.
      let cut = buf.length;
      const lastLt = buf.lastIndexOf('<');
      if (lastLt !== -1 && buf.indexOf('>', lastLt) === -1) cut = lastLt;

      scanRecords(buf.slice(0, cut), catalog, (p) => proposals.push(p));

      carry = buf.slice(cut);
      // Pathological guard: an unterminated tag larger than a real Record is
      // garbage — drop it rather than accumulate unbounded.
      if (carry.length > MAX_CARRY) carry = '';
      buf = '';
    }
    // Flush any complete tag left in the carry (e.g. a final tag with no
    // trailing newline before EOF).
    if (carry !== '') scanRecords(carry, catalog, (p) => proposals.push(p));
  } finally {
    reader.releaseLock();
  }
  return proposals;
}

/**
 * Pick the Apple Health `export.xml` entry from an archive's entry list. Prefers
 * the canonical `apple_health_export/export.xml`, then any `…/export.xml` or
 * bare `export.xml`. NEVER selects `export_cda.xml` — that clinical-document
 * file is redundant HealthKit data here and parsing it is future work; importing
 * both would double-count. Returns undefined when no export.xml is present.
 */
export function pickExportEntry(entries: readonly ZipEntry[]): ZipEntry | undefined {
  const isExport = (name: string): boolean => {
    const base = name.split('/').pop() ?? name;
    return base === 'export.xml';
  };
  return (
    entries.find((e) => e.name.endsWith('apple_health_export/export.xml')) ??
    entries.find((e) => isExport(e.name))
  );
}

export const appleHealthImportPlugin: ImportPlugin = {
  id: 'apple-health',
  nameKey: 'import.apple-health',
  kind: 'file',
  accepts: ['.xml', 'application/xml', 'text/xml', '.zip', 'application/zip'],

  async parse(input: ImportInput, ctx: ImportContext): Promise<ProposedMeasurement[]> {
    if (input.kind === 'file') {
      const file = input.file;
      // A real export arrives as a ZIP; extract only `export.xml` and stream it.
      if (await isZipFile(file)) {
        const entries = await listZipEntries(file);
        const entry = pickExportEntry(entries);
        if (entry === undefined) return [];
        const stream = await openZipEntry(file, entry);
        return parseAppleHealthStream(stream, ctx.catalog);
      }
      // A raw `.xml` File: stream it too, so even a 200 MB export never lands
      // in a single string.
      return parseAppleHealthStream(file.stream() as ReadableStream<Uint8Array>, ctx.catalog);
    }
    const xml = typeof input.data === 'string' ? input.data : '';
    return parseAppleHealthExport(xml, ctx.catalog);
  },
};
