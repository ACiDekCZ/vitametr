# Example plugins (MIT-licensed templates)

These three files are **teaching templates** for plugin authors — the smallest
complete implementation of each plugin interface, heavily commented so you can
copy one and adapt it to a real source or destination.

| file | interface | demonstrates |
|------|-----------|--------------|
| `example-import-plugin.ts` | `ImportPlugin` | a file/text importer for a fictional `metric = value unit @ date` format, turning input into `ProposedMeasurement[]` via the shared normalize helpers — **correctness over guessing**: unresolved names pass through, unrecognised units are dropped, values are never `NaN`. |
| `example-export-plugin.ts` | `ExportPlugin` | the smallest exporter — a human-readable text summary produced as a `Blob`, honouring `ExportSelection` (`metricIds` / `range`) via the same shared filter the csv / json plugins use. |
| `example-lab-parser.ts` | `LabParser` | a `detect(lines)` + `parse(lines, catalog)` parser for a trivial keyed lab sheet, mirroring the conventions in `../import/lab-text.ts`. |

## Licensing

The Vitametr core is licensed **MPL-2.0**. These example files are the exception:
they are licensed **MIT** (see the SPDX header at the top of each file) so you can
lift them into your own project under the most permissive terms.

## Not part of the running app

None of these are registered:

- the import/export examples are **not** in `../registry.ts` (`IMPORT_PLUGINS` /
  `EXPORT_PLUGINS`), and
- the lab-parser example is **not** in `../import/lab-parsers.ts` (`LAB_PARSERS`).

So they add nothing to the shipped bundle and change no app behaviour — esbuild
only bundles what the app imports. They are still type-checked by `tsc` (they
live under `src/`, which `tsconfig`'s `include` covers) and exercised by
`../__tests__/examples.test.ts`, which keeps them valid against the current
interfaces.

To make one live, follow the steps in `PLUGINS.md` (register it, and for a file
importer teach the content sniffer in `../detect.ts`).
