/**
 * Profile store (K5b).
 *
 * Implements the load-into-memory storage model (design doc §4.1): after
 * unlock the whole profile blob is decrypted, parsed and held in memory; all
 * reads operate on that in-memory state; writes serialize + seal + persist the
 * single blob (debounced, plus immediately on critical actions).
 *
 * The concrete crypto is injected as a {@link CryptoProvider} (K5a) — this
 * module never touches WebCrypto directly, which keeps it independent of the
 * crypto implementation and trivially testable with an identity provider.
 */

import type {
  CryptoBox,
  CryptoProvider,
  InitOptions,
  KeyRecord,
  KvBackend,
  SchemaMigration,
  StoreApi,
  StoreStatus,
} from '../core/contracts';
import type { ProfileData, ProfileId } from '../core/types';
import { CURRENT_SCHEMA_VERSION } from '../core/types';

/**
 * MVP is single-profile: one fixed key addresses the profile's record in each
 * object store. Multi-profile support would key these by ProfileId.
 */
const PROFILE_KEY = 'default';

/** Debounce window for persisting mutations (design doc §4.1). */
const FLUSH_DEBOUNCE_MS = 500;

// ---------------------------------------------------------------------------
// Schema migrations
// ---------------------------------------------------------------------------

/**
 * Module-level registry of schema migrations, keyed by the version they
 * migrate *from* (a migration under key N turns a vN blob into vN+1).
 *
 * v1 is the current schema, so the production registry is empty — but the
 * runner code path below always exists and is exercised in tests by injecting
 * a synthetic v0 -> v1 migration through {@link createStore}'s options.
 */
const MIGRATIONS: ReadonlyMap<number, SchemaMigration> = new Map();

/**
 * Run every registered migration in order to bring `data` up to
 * {@link CURRENT_SCHEMA_VERSION}. Each step is a pure vN -> vN+1 function; the
 * runner enforces version progress so a migration cannot silently stall.
 */
function runMigrations(
  input: ProfileData,
  migrations: ReadonlyMap<number, SchemaMigration>,
): ProfileData {
  let data = input;
  if (data.schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Profile schema version ${data.schemaVersion} is newer than supported ${CURRENT_SCHEMA_VERSION}`,
    );
  }
  while (data.schemaVersion < CURRENT_SCHEMA_VERSION) {
    const from = data.schemaVersion;
    const migrate = migrations.get(from);
    if (!migrate) {
      throw new Error(`Missing schema migration from version ${from} to ${from + 1}`);
    }
    data = migrate(data);
    // Defensive: guarantee forward progress even if a migration forgot to bump.
    if (data.schemaVersion <= from) data.schemaVersion = from + 1;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function serialize(data: ProfileData): Uint8Array {
  return encoder.encode(JSON.stringify(data));
}

function deserialize(bytes: Uint8Array): ProfileData {
  return JSON.parse(decoder.decode(bytes)) as ProfileData;
}

function emptyProfileData(options: InitOptions): ProfileData {
  const now = new Date().toISOString();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    profile: {
      id: globalThis.crypto.randomUUID() as ProfileId,
      name: options.profileName,
      createdAt: now,
    },
    metrics: [],
    sources: [],
    measurements: [],
    settings: { locale: options.locale ?? 'cs' },
  };
}

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

export interface CreateStoreOptions {
  /**
   * Override the schema-migration registry. Intended for tests that need to
   * exercise the migration runner with a synthetic migration; production code
   * relies on the module-level default.
   */
  migrations?: ReadonlyMap<number, SchemaMigration>;
  /**
   * The Vitametr build writing the data (e.g. '0.1.0'). Stamped into
   * ProfileData.appVersion on every write for diagnostics — it never drives
   * behavior. Defaults to 'unknown'.
   */
  appVersion?: string;
}

/**
 * Create a {@link StoreApi} over a {@link KvBackend} and an injected
 * {@link CryptoProvider}. The returned store owns all in-memory session state
 * (the data key box and the decrypted profile data).
 */
export function createStore(
  backend: KvBackend,
  crypto: CryptoProvider,
  options: CreateStoreOptions = {},
): StoreApi {
  const migrations = options.migrations ?? MIGRATIONS;
  const appVersion = options.appVersion ?? 'unknown';

  // In-memory session state; both present iff the store is unlocked.
  let box: CryptoBox | undefined;
  let data: ProfileData | undefined;

  // Debounced-flush bookkeeping.
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  function clearFlushTimer(): void {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
  }

  async function persistBlob(activeBox: CryptoBox, current: ProfileData): Promise<void> {
    // Stamp the writer build (diagnostics only) on every write.
    current.appVersion = appVersion;
    const sealed = await activeBox.seal(serialize(current));
    await backend.put('blobs', PROFILE_KEY, sealed);
  }

  async function readKeyRecord(): Promise<KeyRecord | undefined> {
    return (await backend.get('keys', PROFILE_KEY)) as KeyRecord | undefined;
  }

  const store: StoreApi = {
    async status(): Promise<StoreStatus> {
      const record = await readKeyRecord();
      if (!record) return 'uninitialized';
      return box && data ? 'unlocked' : 'locked';
    },

    async mode(): Promise<'encrypted' | 'plaintext'> {
      const record = await readKeyRecord();
      if (!record) throw new Error('Store is not initialized');
      return record.mode;
    },

    async init(initOptions: InitOptions): Promise<ProfileData> {
      if (await readKeyRecord()) {
        throw new Error('Store is already initialized');
      }

      const created =
        initOptions.passphrase !== undefined
          ? await crypto.createEncrypted(initOptions.passphrase)
          : crypto.createPlaintext();

      const fresh = emptyProfileData(initOptions);

      await persistBlob(created.box, fresh);
      await backend.put('keys', PROFILE_KEY, created.keyRecord);
      await backend.put('meta', PROFILE_KEY, {
        schemaVersion: fresh.schemaVersion,
        profileId: fresh.profile.id,
        mode: created.keyRecord.mode,
      });

      box = created.box;
      data = fresh;
      return fresh;
    },

    async unlock(passphrase?: string): Promise<ProfileData> {
      const record = await readKeyRecord();
      if (!record) throw new Error('Store is not initialized');

      const activeBox =
        record.mode === 'encrypted'
          ? await crypto.unlockEncrypted(passphrase ?? '', record)
          : crypto.unlockPlaintext(record);

      const sealed = (await backend.get('blobs', PROFILE_KEY)) as Uint8Array | undefined;
      if (!sealed) throw new Error('Profile blob is missing');

      const opened = await activeBox.open(sealed);
      const parsed = deserialize(opened);
      const migrated = runMigrations(parsed, migrations);

      box = activeBox;
      data = migrated;
      return migrated;
    },

    getData(): ProfileData {
      if (!data) throw new Error('Store is locked');
      return data;
    },

    mutate(fn: (data: ProfileData) => void): void {
      if (!data) throw new Error('Store is locked');
      fn(data);
      // Debounce: reset the window on every mutation so a burst persists once.
      clearFlushTimer();
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        // Fire-and-forget; explicit flush()/lock() surface persistence errors.
        void store.flush().catch(() => {});
      }, FLUSH_DEBOUNCE_MS);
    },

    async flush(): Promise<void> {
      clearFlushTimer();
      if (!box || !data) return;
      await persistBlob(box, data);
    },

    async lock(): Promise<void> {
      await store.flush();
      box = undefined;
      data = undefined;
    },

    async changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<void> {
      const record = await readKeyRecord();
      if (!record) throw new Error('Store is not initialized');
      const nextRecord = await crypto.changePassphrase(oldPassphrase, newPassphrase, record);
      await backend.put('keys', PROFILE_KEY, nextRecord);
      // The data key (DEK) is unchanged, so the in-memory box and blob stay valid.
    },

    async enableEncryption(passphrase: string): Promise<void> {
      if (!box || !data) throw new Error('Store must be unlocked to enable encryption');

      const upgraded = await crypto.upgradeToEncrypted(passphrase);
      // Re-seal the existing data under the new (encrypted) box, then persist.
      await persistBlob(upgraded.box, data);
      await backend.put('keys', PROFILE_KEY, upgraded.keyRecord);
      await backend.put('meta', PROFILE_KEY, {
        schemaVersion: data.schemaVersion,
        profileId: data.profile.id,
        mode: upgraded.keyRecord.mode,
      });
      box = upgraded.box;
    },

    async disableEncryption(currentPassphrase: string): Promise<void> {
      if (!data) throw new Error('Store must be unlocked to disable encryption');
      const record = await readKeyRecord();
      if (!record) throw new Error('Store is not initialized');
      if (record.mode !== 'encrypted') return; // already plaintext — no-op
      // Verify the current passphrase before stripping protection.
      await crypto.unlockEncrypted(currentPassphrase, record);

      const plain = crypto.createPlaintext();
      await persistBlob(plain.box, data);
      await backend.put('keys', PROFILE_KEY, plain.keyRecord);
      await backend.put('meta', PROFILE_KEY, {
        schemaVersion: data.schemaVersion,
        profileId: data.profile.id,
        mode: plain.keyRecord.mode,
      });
      box = plain.box;
    },

    async verifyPassphrase(passphrase: string): Promise<boolean> {
      const record = await readKeyRecord();
      if (!record) throw new Error('Store is not initialized');
      if (record.mode !== 'encrypted') return true; // plaintext — no passphrase to verify
      try {
        await crypto.unlockEncrypted(passphrase, record);
        return true;
      } catch {
        return false;
      }
    },

    async wipe(): Promise<void> {
      clearFlushTimer();
      await backend.clear();
      box = undefined;
      data = undefined;
    },
  };

  return store;
}
