/**
 * Import page — DOM-free descriptors (redesign IA, screen 1).
 *
 * The Import view is driven by two pure pieces of data kept here so they can be
 * unit-tested without a DOM: the list of format cards shown under "Specific
 * format", and the `accept` string offered by the auto dropzone. Each card
 * carries an {@link ImportAction} that the view maps to the matching `run*`
 * function in `import-actions.ts` (or a route navigation) — the descriptors
 * themselves stay free of `ctx`, storage and the clock.
 *
 * The tag shown in a card's icon tile (PDF, CSV, JSON…) is a format acronym,
 * not prose, so it is a literal on the descriptor rather than an i18n key —
 * mirroring the language-endonym exception elsewhere in the app.
 */

import type { StringKey } from '../../i18n/index';

export type FormatId =
  | 'pdf'
  | 'csv'
  | 'json'
  | 'fhir'
  | 'apple'
  | 'hl7'
  | 'pack'
  | 'manual';

/** What a format card does when picked. The view resolves this to a `run*`. */
export type ImportAction =
  | { kind: 'plugin'; pluginId: string }
  | { kind: 'pdf' }
  | { kind: 'pack' }
  | { kind: 'json' }
  | { kind: 'csv' }
  | { kind: 'navigate'; route: 'entry' };

export interface FormatCard {
  id: FormatId;
  /** Short acronym shown in the icon tile (a format label, not prose). */
  tag: string;
  nameKey: StringKey;
  descKey: StringKey;
  /**
   * `accept` for the hidden file picker this card opens. Absent for cards that
   * navigate instead of opening a picker (e.g. manual entry).
   */
  accept?: string;
  action: ImportAction;
}

/** Files the auto dropzone offers to pick (detection routes them afterwards). */
export const ACCEPT_AUTO =
  '.pdf,.json,.csv,.xml,.hl7,.txt,.zip,application/pdf,application/json,text/csv,application/xml,text/xml,application/zip';

/**
 * The format cards, in the order shown under "Specific format". The per-format
 * `accept` strings mirror the ones the settings import section has always used.
 */
export const FORMAT_CARDS: readonly FormatCard[] = [
  {
    id: 'pdf',
    tag: 'PDF',
    nameKey: 'import.card.pdf.name',
    descKey: 'import.card.pdf.desc',
    accept: '.pdf,application/pdf',
    action: { kind: 'pdf' },
  },
  {
    id: 'csv',
    tag: 'CSV',
    nameKey: 'import.card.csv.name',
    descKey: 'import.card.csv.desc',
    accept: '.csv,text/csv',
    action: { kind: 'csv' },
  },
  {
    id: 'json',
    tag: 'JSON',
    nameKey: 'import.card.json.name',
    descKey: 'import.card.json.desc',
    accept: '.json,application/json',
    action: { kind: 'json' },
  },
  {
    id: 'fhir',
    tag: 'FHIR',
    nameKey: 'import.card.fhir.name',
    descKey: 'import.card.fhir.desc',
    accept: '.json,application/fhir+json,application/json',
    action: { kind: 'plugin', pluginId: 'fhir' },
  },
  {
    id: 'apple',
    tag: 'XML',
    nameKey: 'import.card.apple.name',
    descKey: 'import.card.apple.desc',
    accept: '.zip,.xml,application/zip,application/xml,text/xml',
    action: { kind: 'plugin', pluginId: 'apple-health' },
  },
  {
    id: 'hl7',
    tag: 'HL7',
    nameKey: 'import.card.hl7.name',
    descKey: 'import.card.hl7.desc',
    accept: '.hl7,.txt,application/hl7-v2',
    action: { kind: 'plugin', pluginId: 'hl7v2' },
  },
  {
    id: 'pack',
    tag: 'PACK',
    nameKey: 'import.card.pack.name',
    descKey: 'import.card.pack.desc',
    accept: '.json,application/json',
    action: { kind: 'pack' },
  },
  {
    id: 'manual',
    tag: '+',
    nameKey: 'import.card.manual.name',
    descKey: 'import.card.manual.desc',
    action: { kind: 'navigate', route: 'entry' },
  },
] as const;
