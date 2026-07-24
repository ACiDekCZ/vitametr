/**
 * Plain-text lab import plugin.
 *
 * A lab result sheet is not always a PDF — it can be a copied/exported `.txt`
 * whose lines look just like the ones the PDF path reconstructs. This importer
 * reads such a file, splits it into lines and runs the SAME `parseLabDocument`
 * chain, so a user's declarative import mappings (from `ctx.importMappings`)
 * apply to text files exactly as they do to PDFs. Everything runs locally; no
 * data leaves the device.
 *
 * Routing: the format sniffer (`plugins/detect.ts`) only selects this plugin
 * when the text matches a declarative mapping's `detect.anyOf` — without a
 * matching mapping there is nothing text-specific to do, so plain text stays
 * "unrecognised" as before.
 */

import type { ImportContext, ImportInput, ImportPlugin } from '../../core/contracts';
import type { ProposedMeasurement } from '../../core/types';
import { parseLabDocument } from './lab-parsers';
import { declarativeLabParser } from './declarative-lab';

export const labTextImportPlugin: ImportPlugin = {
  id: 'lab-text',
  nameKey: 'import.labText',
  kind: 'file',
  accepts: ['.txt', 'text/plain'],
  async parse(input: ImportInput, ctx: ImportContext): Promise<ProposedMeasurement[]> {
    if (input.kind !== 'file') return [];
    const text = await input.file.text();
    const lines = text.split(/\r?\n/);
    const extra = (ctx.importMappings ?? []).map(declarativeLabParser);
    const result = parseLabDocument(lines, ctx.catalog, extra);
    if (result.sourceName) {
      return result.proposals.map((p) => ({ ...p, sourceName: p.sourceName ?? result.sourceName }));
    }
    return result.proposals;
  },
};
