# Contributing

Thanks for your interest in Vitametr.

## Ground rules

- **No runtime dependencies.** The shipped app must stay dependency-free; only
  dev tooling (TypeScript, esbuild, Vitest, Playwright) is allowed.
- **Privacy is a feature.** The app makes no network requests at runtime — no
  telemetry, no external assets. A change that adds one will not be accepted.
- **No real health data** in the repository. Tests use synthetic fixtures only.
- **No medical claims.** The UI may state only descriptive, data-backed facts,
  never diagnoses or treatment advice.
- **Internationalized.** All user-facing text goes through `src/i18n/`
  (English and Czech kept in sync).
- **Tests first.** `core/` and `storage/` carry full unit coverage; UI logic is
  separated from the DOM and unit-tested, with Playwright covering user flows.

## Before opening a pull request

```bash
npm run typecheck && npm test && npm run build && npm run test:e2e
```

All four must pass. Keep changes modular: the domain core stays independent of
the UI, storage, and plugins.

## Adding a metric or unit

Metrics and units are data, not code:

- Units live in `src/core/units-data.ts` (UCUM code, dimension, conversion).
- Built-in metrics live in `src/core/catalog-data.ts` (do not embed NCLP
  codes; LOINC codes and names must stay unmodified per the LOINC license).

## Licensing of contributions

Contributions to the core are accepted under the project's license,
**MPL-2.0**. Sign off each commit with the Developer Certificate of Origin
(<https://developercertificate.org>):

```bash
git commit -s
```

By signing off you certify that you wrote the change, or otherwise have the
right to submit it under that license.
