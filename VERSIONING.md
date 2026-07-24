# Data format, versioning & compatibility

Vitametr stores everything a profile owns in a single JSON structure
(`ProfileData`) that is serialized, encrypted, and kept as one blob per profile
in IndexedDB. The same structure is the basis of the JSON backup. Because the
app evolves but the data must remain readable across versions, two independent
version numbers are tracked from the start.

## Two versions — do not conflate them

- **`schemaVersion`** (on `ProfileData` and on every backup) — the **data
  format** version. It changes **only** when the shape of the stored data
  changes in a way a reader must adapt to. It drives migrations.
- **`appVersion`** (stamped on every write; carried in backups) — the Vitametr
  **build** that last wrote the data. It is **diagnostics only** and never
  drives behavior.

`CURRENT_SCHEMA_VERSION` lives in `src/core/types.ts` and is the single source
of truth for the schema the running build speaks.

## Compatibility rules

1. **Older data → newer app: migrate up.** On unlock, the store runs
   registered migrations in order from the blob's `schemaVersion` up to
   `CURRENT_SCHEMA_VERSION` (`runMigrations` in `src/storage/store.ts`). A
   missing step throws (never silently skipped).
2. **Newer data → older app: refuse, don't corrupt.** If a blob (or a backup)
   has a `schemaVersion` greater than the build understands, the store/backup
   importer throws with a clear "update the app" message rather than partially
   read or overwrite it.
3. **Additive changes stay backward-readable and are preserved.** Adding a new
   *optional* field that older builds can safely ignore does **not** bump
   `schemaVersion`. Unknown fields written by a newer build survive a load→save
   round-trip in an older build: the blob is JSON-parsed into the object
   keeping every key, mutated **in place**, and re-serialized — never rebuilt —
   so nothing is stripped. (Guarded by the "unknown fields survive" test in
   `src/storage/__tests__/versioning.test.ts`.)

Rule of thumb: **prefer additive, non-breaking changes** (new optional fields,
same `schemaVersion`). Reserve a `schemaVersion` bump for genuinely breaking
reshapes.

## How to add a migration (breaking schema change)

1. Change the types in `src/core/types.ts`.
2. Increment `CURRENT_SCHEMA_VERSION`.
3. Register a migration in `src/storage/store.ts`'s `MIGRATIONS` map under the
   **from-version** key (a step keyed `N` turns a `vN` blob into `vN+1`). The
   function must be pure `(data) => data` and **spread `...data`** so it keeps
   unknown/forward-compat fields:

   ```ts
   const MIGRATIONS = new Map<number, SchemaMigration>([
     [1, (data) => ({ ...data, schemaVersion: 2, /* transform */ })],
   ]);
   ```

4. Add a test that seeds a `vN` blob and asserts it upgrades on unlock (see the
   migration-runner test in `src/storage/__tests__/store.test.ts`).

Never mutate old blobs in place to "fix" them outside a migration; the
migration path is the only sanctioned upgrade.

## Backup format

The JSON backup is a **self-describing, versioned envelope** (see
`src/plugins/export/json-backup.ts`):

- `format: "vitametr-backup"` — magic string, checked on import.
- `backupVersion` — the envelope shape's own version (independent of the data
  `schemaVersion`).
- `schemaVersion` — the data schema, so a restore migrates or refuses as above.
- `appVersion` — the build that produced the backup (diagnostics).

On restore, a backup with a `schemaVersion` newer than the current build is
refused; the same-or-older is accepted (measurements reference version-stable
metric ids). A restore always flows through the review pipeline before anything
is written.
