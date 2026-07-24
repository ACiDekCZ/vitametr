# Source sample fixtures

Synthetic, committable sample data for the import sources Vitametr can support.
One folder per source. Everything here is **synthetic** (hand-made or generated)
and safe to commit — never real patient data.

Real / copyrighted sample files (education/marketing lab PDFs, real device
exports) are kept LOCAL ONLY in `../samples-local/` (gitignored) and are used
for parser testing without being redistributed.

Layout:

```
sources/
  apple-health/    Apple Health export.xml (synthetic subset)
  hl7v2/           HL7 v2 ORU^R01 messages
  fhir/            (FHIR bundles live in ../fhir-bundle.json for now)
  ...
```

See the working registry `docs/sources/INDEX.md` (local) for the full list of
candidate sources, their interfaces/formats, and integration feasibility.
