/**
 * Format auto-detection for imports.
 *
 * Sniffs a file's format from its head bytes so the UI can offer a single
 * "import any file" entry instead of one button per format. Detection is by
 * content signature (magic bytes / structural markers), with the filename
 * extension only as a last-resort hint — the same "correctness over guessing"
 * rule as the rest of the pipeline: an unrecognised file returns `undefined`
 * rather than a wrong guess.
 */

import type { ImportMappingDef } from '../core/types';
import { isZipMagic, listZipEntries } from './import/zip';
import { pickExportEntry } from './import/apple-health';

/** Import-plugin ids the detector can route to (plus the CSV mapping screen). */
export type DetectedFormat =
  | 'pdf'
  | 'json-backup'
  | 'pack'
  | 'fhir'
  | 'apple-health'
  | 'hl7v2'
  | 'lab-text'
  | 'csv';

const HEAD_BYTES = 64 * 1024;

/** Read the file's head as text (enough to see any structural marker). */
async function readHead(file: File): Promise<string> {
  const slice = file.slice(0, HEAD_BYTES);
  return slice.text();
}

/**
 * Classify a file's head text. Exported for testing; `detectFormat` wraps it
 * with the file read.
 */
export function detectFromText(
  head: string,
  filename = '',
  mappings: readonly ImportMappingDef[] = [],
): DetectedFormat | undefined {
  // PDF: the "%PDF-" header survives encryption (only streams/strings are
  // encrypted), so password-protected PDFs are detected here too.
  if (head.startsWith('%PDF-')) return 'pdf';

  const text = head.replace(/^﻿/, '').trimStart(); // drop a BOM

  // HL7 v2: the message always opens with an MSH segment + field separator.
  if (/^MSH\|/.test(text)) return 'hl7v2';

  // XML family.
  if (text.startsWith('<')) {
    if (/<HealthData[\s>]/.test(head)) return 'apple-health';
    if (/<(Bundle|Observation|DiagnosticReport)[\s>]/.test(head) || /hl7\.org\/fhir/.test(head)) {
      return 'fhir';
    }
    return byExtension(filename); // unknown XML
  }

  // JSON family — scan the head by regex (a large bundle's head may be truncated
  // mid-object, so full JSON.parse is unreliable here).
  if (text.startsWith('{') || text.startsWith('[')) {
    if (/"format"\s*:\s*"vitametr-backup(-encrypted)?"/.test(head)) return 'json-backup';
    if (/"format"\s*:\s*"vitametr-pack"/.test(head)) return 'pack';
    if (/"resourceType"\s*:/.test(head)) return 'fhir';
    return byExtension(filename); // unknown JSON
  }

  // Declarative import mappings: a user-added text/line lab format. Checked
  // BEFORE the CSV heuristic because such a sheet may use ';'-separated entries
  // that would otherwise look like CSV. Matches when the head contains any of a
  // mapping's `detect.anyOf` substrings (case-insensitive).
  if (mappings.length > 0 && matchesMapping(head, mappings)) return 'lab-text';

  // CSV: delimited text whose first non-empty line has at least two columns.
  if (looksLikeCsv(text)) return 'csv';

  return byExtension(filename);
}

/** True when the head text contains any declarative mapping's detect substring. */
function matchesMapping(head: string, mappings: readonly ImportMappingDef[]): boolean {
  const lower = head.toLowerCase();
  return mappings.some((m) => m.detect.anyOf.some((s) => s !== '' && lower.includes(s.toLowerCase())));
}

/**
 * Detect a file's import format, or `undefined` when unrecognised.
 *
 * A ZIP archive is handled before the text sniff: its head is binary. When the
 * archive contains an Apple Health `export.xml` it classifies as `'apple-health'`
 * (the plugin extracts + streams the entry itself). Any other archive returns
 * `undefined` so the router can decide whether to extract a single inner file and
 * re-detect — correctness-first: an ambiguous archive is refused, not guessed.
 */
export async function detectFormat(
  file: File,
  mappings: readonly ImportMappingDef[] = [],
): Promise<DetectedFormat | undefined> {
  if (await isZip(file)) {
    try {
      const entries = await listZipEntries(file);
      if (pickExportEntry(entries) !== undefined) return 'apple-health';
    } catch {
      // Not a readable/supported archive — fall through to undefined.
    }
    return undefined;
  }
  return detectFromText(await readHead(file), file.name, mappings);
}

/** True when a file begins with the ZIP local-file-header magic. */
export async function isZip(file: Blob): Promise<boolean> {
  if (file.size < 4) return false;
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return isZipMagic(head);
}

function looksLikeCsv(text: string): boolean {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '');
  if (firstLine === undefined) return false;
  return /[,;\t]/.test(firstLine) && firstLine.split(/[,;\t]/).length >= 2;
}

function byExtension(filename: string): DetectedFormat | undefined {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'pdf':
      return 'pdf';
    case 'csv':
      return 'csv';
    case 'hl7':
      return 'hl7v2';
    case 'xml':
      return 'apple-health';
    default:
      return undefined;
  }
}
