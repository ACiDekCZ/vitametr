# Extending Vitametr — imports, parsers and metric packs

Vitametr keeps a **stable domain core** (metrics + measurements) and treats every
source and destination as a plugin around it. This document is the developer
contract for those plugins. Everything here is pure data + small interfaces; the
UI, storage and review pipeline never change when you add a source.

Golden rule — **correctness over guessing** (spec §16): a parser never invents a
value, unit or metric. When it cannot resolve a name it emits it as *unresolved*
and the user maps it once; the app learns the mapping (see *Aliases*). It is
always better to surface an unknown than to store a wrong number.

## The pipeline

```
file / data ──▶ ImportPlugin.parse ──▶ ProposedMeasurement[] ──▶ normalize
             ──▶ review (resolve + accept) ──▶ commit ──▶ Measurement[]
```

An import plugin's only job is to turn some input into `ProposedMeasurement[]`.
Normalization (unit spelling, name resolution), the review screen and the commit
are shared and written once (`src/core/review.ts`). Manual entry uses the same
path — it is just another plugin (`manual`).

## `ProposedMeasurement` — the universal currency

Every importer, however exotic, produces this (`src/core/types.ts`):

```ts
interface ProposedMeasurement {
  metric: MetricId | { unresolvedName: string }; // resolved id, or a name to map
  value?: number;         // numeric metrics
  textValue?: string;     // 'text' / 'enum' metrics (e.g. "negativní")
  textValues?: string[];  // 'multi' metrics
  operator?: '<' | '>' | '<=' | '>=';  // censored results, e.g. "< 0.1"
  unit?: string;          // UCUM code; omit for qualitative values
  takenAt?: string;       // ISO 8601
  timePrecision?: 'date' | 'datetime';
  refLow?: number; refHigh?: number; refText?: string; // source's own range
  sourceName?: string; note?: string; rawText?: string;
  confidence: 'high' | 'medium' | 'low';
}
```

- **Resolved vs unresolved metric.** If you already know the catalog id, pass it.
  Otherwise pass `{ unresolvedName }` and let resolution + the review screen do
  the mapping. Never fabricate an id.
- **Value kind** follows the resolved metric's `valueType`
  (`number | text | enum | multi`). Numeric → `value` (+ `unit`); qualitative →
  `textValue` / `textValues`, no unit.

## Adding a file-format importer (`ImportPlugin`)

```ts
interface ImportPlugin {
  id: string;
  nameKey: string;                 // i18n key of the display name
  kind: 'interactive' | 'file';
  accepts?: string[];              // extensions / MIME types
  parse(input: ImportInput, ctx: ImportContext): Promise<ProposedMeasurement[]>;
}
type ImportInput = { kind: 'file'; file: File } | { kind: 'data'; data: unknown };
interface ImportContext { catalog: Catalog; password?: string }
```

Steps:
1. Implement `parse`. Read `input.file` (or `input.data`) and return proposals.
   Resolve names via `ctx.catalog` when you can (`resolveAlias`, `byLoinc`).
2. Register it in `src/plugins/registry.ts` (`IMPORT_PLUGINS`).
3. Teach the sniffer in `src/plugins/detect.ts` to recognise the format from its
   first bytes so the single **"Import a file"** entry can route to it. Detection
   is by content signature (magic bytes / structural markers), extension only as
   a last resort; an unrecognised file returns `undefined` rather than a guess.

Password-protected inputs (encrypted backup, protected PDF) throw
`PassphraseRequiredError` / `WrongPassphraseError` from `parse`; the UI catches
these and prompts inline, then retries with `ctx.password`.

## Lab PDFs — generic parser + per-lab parsers

PDF text is extracted per line (ordered by position) and handed to a parser
chain (`src/plugins/import/lab-parsers.ts`):

```ts
interface LabParser {
  id: string;
  sourceName?: string;
  detect(lines: string[]): boolean;                       // claims the document
  parse(lines: string[], catalog: Catalog): ProposedMeasurement[];
}
```

`parseLabDocument` tries each specific parser in `LAB_PARSERS` (matched by
`detect`, e.g. header text) and falls back to the **generic** heuristic parser
that reads `analyte / value / unit / range` rows from any layout. Adding a lab is
a new `LabParser` + a registry line — nothing else changes.

**When do you need a specific parser?** Only when the *layout* defeats the
generic reader (multi-column, wrapped rows, unusual separators). Naming
differences do **not** need code — they are data (see *packs* + *aliases*).

## Resolution, aliases and metric packs (the "smart" part)

Extraction is the easy half; **resolution** (mapping a source's analyte name to a
catalog metric) is where coverage is won or lost. A baseline run of the generic
parser over a 13-file foreign-lab corpus extracted 142 candidate rows but
resolved only ~20 against the bare catalog — the rest were unknown names
("WBC", German and functional-medicine labels). The fix is **data, not more
parser code**:

- **Aliases** live on the metric (`Metric.aliases`) and resolve case/diacritics-
  insensitively. Seed common synonyms/abbreviations there.
- **Learned aliases.** When a user maps an unresolved name to a metric in the
  review screen, the app calls `catalog.learnAlias(id, name)` and that name
  resolves automatically next time. Mapping is one-time and per-profile.
- **Metric packs** (`src/plugins/import/pack.ts`) are the shippable unit of
  "specialisation": a declarative JSON that defines metrics (and units) with
  their names/aliases/value-types/options. A concrete application (a given lab,
  device or portal) ships a pack; importing it registers the metrics so the
  parser's raw names resolve. Packs are tagged (`Metric.pack`) so a whole pack
  can be added or removed as a unit.

```jsonc
{
  "format": "vitametr-pack", "version": 1, "id": "my-lab",
  "metrics": [
    { "key": "wbc", "name": "Leukocyty", "aliases": ["WBC", "leukocyty"],
      "valueType": "number", "unit": "10*9/L", "loinc": "6690-2" },
    { "key": "urine-protein", "name": "Bílkovina v moči",
      "valueType": "enum", "enumValues": ["negativní", "stopově", "pozitivní"] }
  ],
  "measurements": [ /* optional sample values */ ]
}
```

The built-in catalog is itself just the app's default pack (compiled in): a user
can switch off built-in metrics (`ProfileData.disabledMetrics`), remove imported
packs, and always **reset to default**.

## Declarative import mappings (a parser as *data*)

A per-lab `LabParser` (above) needs code — a new file + a registry line. That is
fine upstream, but a *user* cannot add code: the app runs under a strict
`script-src 'self'` CSP and never executes anything it downloads or imports. A
**declarative import mapping** closes that gap for the highest-value case —
**text / line formats** (lab result sheets and simple keyed records, whether a
`.txt` or the text extracted from a PDF). It is a data-only parser definition a
user adds by importing a pack; the app turns it into an ordinary `LabParser` at
import time (`src/plugins/import/declarative-lab.ts`).

**Security rationale.** A mapping is *data, never code*. Its strings are only
ever compiled with `new RegExp` (wrapped in `try/catch`) and matched against
text — nothing is `eval`-ed, no function is built from a string. That is the
safety boundary, and it keeps the feature inside the CSP and the offline privacy
model. As a ReDoS guard, any single line/entry longer than ~2000 characters is
skipped rather than fed to a regex.

A mapping carries these fields (`ImportMappingDef` in `src/core/types.ts`):

| field         | meaning |
|---------------|---------|
| `id`          | stable id (dedupe key when merged into a profile) |
| `sourceName`  | label stamped on every produced measurement |
| `detect.anyOf`| the format auto-detects when the extracted text contains **any** of these substrings (case-insensitive); must be non-empty |
| `entrySplit`  | *optional* — split each line into entries on this literal (e.g. `";"`) |
| `pattern`     | a regex with **named** groups; `(?<name>…)` is **required**, plus optional `(?<value>…)` `(?<unit>…)` `(?<low>…)` `(?<high>…)` |
| `datePattern` | *optional* regex; a `(?<date>…)` group (or the first capture) yields the document date, shared by every proposal |

From each entry's named groups the engine builds a `ProposedMeasurement`,
following the same *correctness over guessing* rules as the hand-written
parsers: the `name` is resolved against the catalog (an unknown name becomes an
`unresolvedName` for one-time mapping, never a guess); `value` is parsed as a
number (with a leading `<`/`>` operator) or, failing that, kept only as a short
qualitative token; `unit` is normalised (an unrecognised unit is dropped, not
invented); `low`/`high` become the source's reference range.

```jsonc
{
  "format": "vitametr-pack", "version": 1, "id": "my-lab-text",
  "importMappings": [
    {
      "id": "my-lab-keyed",
      "sourceName": "My Lab (text export)",
      "detect": { "anyOf": ["MY-LAB"] },
      "entrySplit": ";",
      "pattern": "(?<name>[^:]+):\\s*(?<value>(?:[<>]=?\\s*)?\\d+(?:[.,]\\d+)?)\\s*(?<unit>[^\\s()]+)?\\s*(?:\\(\\s*(?<low>\\d+(?:[.,]\\d+)?)\\s*-\\s*(?<high>\\d+(?:[.,]\\d+)?)\\s*\\))?",
      "datePattern": "(?<date>\\d{4}-\\d{2}-\\d{2})"
    }
  ]
}
```

Given that mapping, a line like

```
MY-LAB 2026-03-15; Glukóza: 5,4 mmol/l (3,9-5,6); Kreatinin: 78 umol/l (64-104)
```

produces two proposals (Glucose 5.4 mmol/L ref 3.9–5.6, Creatinine 78 µmol/L ref
64–104), both dated 2026-03-15 and stamped `My Lab (text export)`.

**How a user adds one.** Import the JSON on the **Import** page (drag-and-drop or
the file picker), exactly like any other pack. A pack that carries only
`importMappings` (no measurements) simply registers the parser and confirms with
a toast. From then on the mappings are tried **before** the generic heuristic on
every PDF and — because a matching `.txt` now auto-detects as a lab sheet rather
than CSV — on text imports too. A committed, clearly-synthetic example lives at
`packs/example-import-mapping.json`.

The mapping definition is validated on import (`parsePack`): `id`, `sourceName`
and a non-empty `detect.anyOf` are required, and the `pattern` must both compile
and expose a `(?<name>…)` group — a malformed mapping is rejected rather than
half-applied.

## Units

Units are data too (`src/core/units-data.ts`: `UnitDef { code, display,
dimension, toBase }`). Conversion is dimensional (via each dimension's base
unit) plus per-metric bridges (`molarMass`, explicit `MetricConversion`). A pack
may carry custom `units`; the engine merges them over the built-ins
(`UnitsEngine.reloadUnits`) so imported units convert like any other. Reference
ranges belong to individual measurements, never to the metric.

## Exports (`ExportPlugin`)

```ts
interface ExportPlugin {
  id: string; nameKey: string; fileExtension: string;
  export(selection: ExportSelection, ctx: ExportContext): Promise<Blob>;
}
```

`ExportSelection` carries the chosen `metricIds` / date `range` and an optional
`password` (an encrypted backup is a password-derived AES-GCM envelope, like a
`.p12`). The catalog itself exports as a pack (metrics ± units), so a user's
customisations round-trip.

## Example plugins (copy-and-adapt templates)

Three heavily-commented, minimal implementations — one per interface — live in
`src/plugins/examples/`. Copy the closest one and adapt it:

- `example-import-plugin.ts` — a complete `ImportPlugin` for a fictional
  `metric = value unit @ date` text format, showing how the shared normalize
  helpers give you *correctness over guessing* for free.
- `example-export-plugin.ts` — the smallest `ExportPlugin`: a text summary as a
  `Blob`, honouring `ExportSelection` (`metricIds` / `range`) via the same
  shared filter the csv / json plugins use.
- `example-lab-parser.ts` — a `LabParser` (`detect` + `parse`) for a trivial
  keyed lab sheet, mirroring `import/lab-text.ts`.

These are the one place in the repo licensed **MIT** (per-file SPDX header); the
core is **MPL-2.0**. They are deliberately NOT registered (`registry.ts` /
`LAB_PARSERS`), so they add nothing to the running app or the bundle — they are
type-checked and tested (`__tests__/examples.test.ts`) purely to stay valid
against the current interfaces. Making one live is the registration step above.

## Privacy invariants (do not break)

- **No network at runtime.** Everything runs on-device; a plugin must never
  fetch. The one sanctioned dependency (pdf.js) is lazy-loaded and offline.
- **No real health data in the repo.** Test fixtures are synthetic; the local
  real/educational corpus lives under `test/fixtures/samples-local/`
  (git-ignored).
