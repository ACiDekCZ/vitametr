/**
 * Lab PDF import plugin (phase 3).
 *
 * The ONLY part of the app with a runtime dependency (pdf.js) — and it is
 * lazy-loaded: the dynamic import keeps pdf.js out of the core bundle (a
 * separate chunk fetched only when a PDF is first imported). Everything runs
 * locally; no data leaves the device. Text is extracted per page, lines are
 * reconstructed by vertical position, and the pure `parseLabLines` heuristic
 * turns them into proposals for the review pipeline.
 */

import type { ImportContext, ImportInput, ImportPlugin } from '../../core/contracts';
import { PassphraseRequiredError, WrongPassphraseError } from '../../core/contracts';
import type { ProposedMeasurement } from '../../core/types';
import { parseLabDocument } from './lab-parsers';
import { declarativeLabParser } from './declarative-lab';

interface PdfTextItem {
  str: string;
  transform: number[];
}

/** Reconstruct text lines from a PDF, ordering by vertical then horizontal position. */
async function extractLines(file: File, password?: string): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/build/pdf.mjs');
  // Classic worker served from the app root; avoids bundling pdf.js into core.
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.js', document.baseURI).href;

  const data = new Uint8Array(await file.arrayBuffer());
  // isEvalSupported: false keeps pdf.js within our strict script-src CSP.
  // A password-protected PDF is opened with `password`; pdf.js rejects with a
  // PasswordException when the file needs a password (code 1) or the given one
  // is wrong (code 2), which we map onto the shared import password signals.
  const params: { data: Uint8Array; isEvalSupported: boolean; password?: string } = {
    data,
    isEvalSupported: false,
  };
  if (password !== undefined) params.password = password;
  let doc;
  try {
    doc = await pdfjs.getDocument(params).promise;
  } catch (err) {
    if (err !== null && typeof err === 'object' && (err as { name?: string }).name === 'PasswordException') {
      // pdfjs PasswordResponses: 1 = NEED_PASSWORD, 2 = INCORRECT_PASSWORD.
      if ((err as { code?: number }).code === 2) {
        throw new WrongPassphraseError('Wrong PDF password');
      }
      throw new PassphraseRequiredError('This PDF is password-protected');
    }
    throw err;
  }

  const lines: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const byRow = new Map<number, PdfTextItem[]>();
    for (const item of content.items) {
      if (!('str' in item)) continue; // skip marked-content items
      const textItem = item as PdfTextItem;
      if (textItem.str.trim() === '') continue;
      const y = Math.round(textItem.transform[5]);
      const row = byRow.get(y);
      if (row) row.push(textItem);
      else byRow.set(y, [textItem]);
    }
    const pageLines = [...byRow.entries()]
      .sort((a, b) => b[0] - a[0]) // top of page first
      .map(([, items]) =>
        items
          .sort((a, b) => a.transform[4] - b.transform[4])
          .map((i) => i.str)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim(),
      )
      .filter((l) => l !== '');
    lines.push(...pageLines);
  }
  return lines;
}

export const pdfImportPlugin: ImportPlugin = {
  id: 'pdf',
  nameKey: 'import.pdf',
  kind: 'file',
  accepts: ['.pdf', 'application/pdf'],
  async parse(input: ImportInput, ctx: ImportContext): Promise<ProposedMeasurement[]> {
    if (input.kind !== 'file') return [];
    const lines = await extractLines(input.file, ctx.password);
    // User-defined declarative mappings become extra parsers, tried before the
    // generic heuristic.
    const extra = (ctx.importMappings ?? []).map(declarativeLabParser);
    const result = parseLabDocument(lines, ctx.catalog, extra);
    // A detected lab becomes the source hint on each proposal.
    if (result.sourceName) {
      return result.proposals.map((p) => ({ ...p, sourceName: p.sourceName ?? result.sourceName }));
    }
    return result.proposals;
  },
};
