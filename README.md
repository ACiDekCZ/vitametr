# Vitametr

Personal health time-series tracker. Vitametr collects measured health values
— lab results, home measurements, wearable readings — normalizes them into one
consistent model, stores them **locally on your device** (optionally
encrypted), and shows how they develop over time.

> Your measured health values, long-term, in one place and under your own
> control.

Vitametr is an offline-first Progressive Web App with **no runtime
dependencies**, **no account**, and **no server**. It makes zero network
requests while you use it — your data never leaves the device unless you
explicitly export it.

## Principles

- **Local by default.** Data lives in your browser's storage. No cloud, no
  account, no telemetry.
- **Optional encryption.** Choose a passphrase at setup and everything is
  sealed with AES-GCM (a random data key wrapped by a key derived from your
  passphrase via PBKDF2). The app locks on inactivity.
- **You own the data.** Full JSON backup and CSV export at any time; delete
  everything with one action.
- **Correctness over guessing.** Ambiguous imported values are shown for review
  rather than stored silently. Original source text is never overwritten.
- **Descriptive, not diagnostic.** Vitametr states only data-backed facts
  (above/below the source's reference range, increased/decreased). It never
  offers a diagnosis or treatment advice.
- **International from day one.** English and Czech; every unit is identified by
  a UCUM code with dimensional and analyte-specific conversions.

## Features (MVP)

- Manual entry, including a "result sheet" batch (one date, several values) and
  grouped entry (blood pressure + pulse).
- A built-in catalog of common metrics (lipids, glucose and HbA1c, liver
  enzymes, blood count basics, TSH, vitamin D, ferritin, creatinine/eGFR, CRP,
  uric acid, PSA, blood pressure, heart rate, weight, waist, temperature, SpO₂),
  plus your own custom metrics.
- Overview with the latest value, change vs the previous measurement, position
  against the reference range, and how long ago each value was measured.
- Metric detail with a hand-drawn SVG chart (reference-range band, trend,
  switchable display unit), and a table of measurements.
- Timeline of all events grouped by date and source.
- Encrypted local storage with app lock; JSON backup and CSV export; restore
  through a review screen.
- Installable, works fully offline.

## Development

Requires Node.js. No runtime dependencies are installed — the toolchain
(TypeScript, esbuild, Vitest, Playwright) is dev-only.

```bash
npm install       # dev tooling only
npm run dev       # build + serve locally
npm run build     # production build into dist/
npm run typecheck # tsc --noEmit
npm test          # unit tests (Vitest)
npm run test:e2e  # end-to-end tests (Playwright)
```

## Architecture

The domain core (metrics + measurements + units) is stable; inputs and exports
are plugins around it.

- `src/core/` — pure domain logic (metric catalog, measurements, unit
  conversions, time-series queries, import review). No DOM, no storage.
- `src/storage/` — IndexedDB (one blob per profile, loaded into memory) and
  WebCrypto encryption.
- `src/plugins/` — import and export plugins (manual entry, JSON backup, CSV).
- `src/ui/` — app shell, views, and the SVG chart.
- `src/i18n/` — English and Czech string resources.

## License

Vitametr's core is licensed under the **Mozilla Public License 2.0** — see
[LICENSE](LICENSE). Third-party attributions (LOINC, pdf.js, Hanken Grotesk) are
in [NOTICE](NOTICE).

Proprietary cloud and AI services operated by the project author are not part of
this open-source release; the app is fully functional offline without them.
