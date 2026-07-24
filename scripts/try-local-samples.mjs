/**
 * Dev-only: run the lab PDF parser over the LOCAL sample corpus
 * (test/fixtures/samples-local/, gitignored — real/education PDFs we never
 * commit) and print what it extracts. Skips cleanly when the folder is empty,
 * so a fresh clone works without the corpus.
 *
 * Run: node scripts/try-local-samples.mjs
 */

import { build } from 'esbuild';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const DIR = 'test/fixtures/samples-local';

if (!existsSync(DIR)) {
  console.log(`No local corpus at ${DIR} — nothing to try. (This is expected on a fresh clone.)`);
  process.exit(0);
}
const pdfs = readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.pdf'));
if (pdfs.length === 0) {
  console.log(`Local corpus ${DIR} is empty.`);
  process.exit(0);
}

// Bundle the (TypeScript) parser + catalog into a temp module we can import.
const outfile = '/tmp/vitametr-lab-runner.mjs';
await build({
  stdin: {
    contents:
      "export { parseLabDocument } from './src/plugins/import/lab-parsers.ts';\n" +
      "export { createCatalog } from './src/core/catalog.ts';\n",
    resolveDir: '.',
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  logLevel: 'error',
});
const { parseLabDocument, createCatalog } = await import(outfile);

function emptyProfile() {
  return {
    schemaVersion: 1,
    profile: { id: 'p', name: 'p', createdAt: '2026-01-01T00:00:00Z' },
    metrics: [],
    sources: [],
    measurements: [],
    settings: {},
  };
}

/** Reconstruct text lines by vertical position (mirrors the PDF plugin). */
async function extractLines(path) {
  const data = new Uint8Array(readFileSync(path));
  const doc = await getDocument({ data }).promise;
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const byRow = new Map();
    for (const it of tc.items) {
      if (!('str' in it) || !it.str.trim()) continue;
      const y = Math.round(it.transform[5]);
      if (!byRow.has(y)) byRow.set(y, []);
      byRow.get(y).push({ x: it.transform[4], s: it.str });
    }
    for (const [, arr] of [...byRow.entries()].sort((a, b) => b[0] - a[0])) {
      out.push(
        arr
          .sort((a, b) => a.x - b.x)
          .map((i) => i.s)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim(),
      );
    }
  }
  return out.filter(Boolean);
}

const catalog = createCatalog(emptyProfile());
for (const f of pdfs) {
  const lines = await extractLines(`${DIR}/${f}`);
  const r = parseLabDocument(lines, catalog);
  const resolved = r.proposals.filter((p) => typeof p.metric === 'string').length;
  console.log(`\n=== ${f} — ${r.proposals.length} proposals (${resolved} resolved), parser=${r.parserId} ===`);
  for (const p of r.proposals) {
    const metric = typeof p.metric === 'object' ? `(${p.metric.unresolvedName})` : p.metric;
    const range = p.refLow !== undefined || p.refHigh !== undefined ? `[${p.refLow ?? ''}–${p.refHigh ?? ''}]` : '';
    console.log(`  ${p.operator ?? ''}${p.value} ${p.unit ?? '?'} ${range} ${p.confidence}  <- ${metric}`);
  }
}
