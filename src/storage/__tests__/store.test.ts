import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  CryptoBox,
  CryptoProvider,
  KeyRecord,
  KvBackend,
  SchemaMigration,
} from '../../core/contracts';
import { WrongPassphraseError } from '../../core/contracts';
import type { ProfileData, Source, SourceId } from '../../core/types';
import { CURRENT_SCHEMA_VERSION } from '../../core/types';
import { createMemoryBackend } from '../db';
import { createStore } from '../store';

// ---------------------------------------------------------------------------
// Fake identity CryptoProvider — seal/open are Uint8Array passthrough.
// Encrypted records carry the passphrase in the clear so the fake can enforce
// wrong-passphrase behaviour without any real crypto (K5b stays crypto-free).
// ---------------------------------------------------------------------------

const identityBox: CryptoBox = {
  async seal(plain) {
    return plain;
  },
  async open(sealed) {
    return sealed;
  },
};

interface FakePayload {
  passphrase: string;
}

function passphraseOf(record: KeyRecord): string {
  return (record.payload as FakePayload).passphrase;
}

function createFakeCrypto(): CryptoProvider {
  return {
    async createEncrypted(passphrase) {
      return { box: identityBox, keyRecord: { mode: 'encrypted', payload: { passphrase } } };
    },
    async unlockEncrypted(passphrase, keyRecord) {
      if (passphraseOf(keyRecord) !== passphrase) throw new WrongPassphraseError();
      return identityBox;
    },
    createPlaintext() {
      return { box: identityBox, keyRecord: { mode: 'plaintext' } };
    },
    unlockPlaintext() {
      return identityBox;
    },
    async changePassphrase(oldPassphrase, newPassphrase, keyRecord) {
      if (passphraseOf(keyRecord) !== oldPassphrase) throw new WrongPassphraseError();
      return { mode: 'encrypted', payload: { passphrase: newPassphrase } };
    },
    async upgradeToEncrypted(passphrase) {
      return { box: identityBox, keyRecord: { mode: 'encrypted', payload: { passphrase } } };
    },
  };
}

function addSource(store: { mutate: (fn: (d: ProfileData) => void) => void }, name: string): void {
  store.mutate((d) => {
    const source: Source = { id: `src-${name}` as SourceId, name, kind: 'lab' };
    d.sources.push(source);
  });
}

/** Read and identity-decode the persisted blob directly from a backend. */
async function readPersisted(backend: KvBackend): Promise<ProfileData> {
  const sealed = (await backend.get('blobs', 'default')) as Uint8Array;
  return JSON.parse(new TextDecoder().decode(sealed)) as ProfileData;
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('createStore', () => {
  it('init (plaintext) yields empty ProfileData and unlocked status', async () => {
    const backend = createMemoryBackend();
    const store = createStore(backend, createFakeCrypto());

    const data = await store.init({ profileName: 'Alice', locale: 'en' });

    expect(data.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(data.profile.name).toBe('Alice');
    expect(data.metrics).toEqual([]);
    expect(data.sources).toEqual([]);
    expect(data.measurements).toEqual([]);
    expect(data.settings.locale).toBe('en');
    expect(await store.status()).toBe('unlocked');
    expect(store.getData()).toBe(data);
  });

  it('status is uninitialized before init', async () => {
    const backend = createMemoryBackend();
    const store = createStore(backend, createFakeCrypto());
    expect(await store.status()).toBe('uninitialized');
  });

  it('round-trips data through a fresh store over the same backend', async () => {
    const backend = createMemoryBackend();
    const crypto = createFakeCrypto();

    const first = createStore(backend, crypto);
    await first.init({ profileName: 'Bob' });
    addSource(first, 'Lab A');
    await first.flush();

    const second = createStore(backend, crypto);
    const data = await second.unlock();

    expect(data.profile.name).toBe('Bob');
    expect(data.sources.map((s) => s.name)).toEqual(['Lab A']);
  });

  it('locks and unlocks: getData throws while locked, restored after unlock', async () => {
    const backend = createMemoryBackend();
    const crypto = createFakeCrypto();
    const store = createStore(backend, crypto);

    await store.init({ profileName: 'Carol' });
    addSource(store, 'Lab X');
    await store.lock();

    expect(() => store.getData()).toThrow(/locked/i);
    expect(await store.status()).toBe('locked');

    const data = await store.unlock();
    expect(data.sources.map((s) => s.name)).toEqual(['Lab X']);
    expect(await store.status()).toBe('unlocked');
  });

  it('debounces mutations into one write and flush forces an immediate write', async () => {
    vi.useFakeTimers();
    const backend = createMemoryBackend();
    const store = createStore(backend, createFakeCrypto());

    await store.init({ profileName: 'Dave' });

    // Two quick mutations, no explicit flush yet.
    addSource(store, 'One');
    addSource(store, 'Two');

    // Debounce not elapsed → blob still reflects the freshly-init'd empty state.
    expect((await readPersisted(backend)).sources).toEqual([]);

    // Let the debounce fire; both mutations land in a single persisted write.
    await vi.advanceTimersByTimeAsync(500);
    expect((await readPersisted(backend)).sources.map((s) => s.name)).toEqual(['One', 'Two']);

    // flush() forces an immediate write without waiting for the timer.
    addSource(store, 'Three');
    await store.flush();
    expect((await readPersisted(backend)).sources.map((s) => s.name)).toEqual([
      'One',
      'Two',
      'Three',
    ]);
  });

  it('runs schema migrations on unlock via an injected v0 -> v1 migration', async () => {
    const backend = createMemoryBackend();
    const crypto = createFakeCrypto();

    // Seed a plaintext key record + a v0 blob directly into the backend.
    await backend.put('keys', 'default', crypto.createPlaintext().keyRecord);
    const v0: ProfileData = {
      schemaVersion: 0,
      profile: { id: 'p0' as ProfileData['profile']['id'], name: 'Legacy', createdAt: 'now' },
      metrics: [],
      sources: [],
      measurements: [],
      settings: {},
    };
    await backend.put('blobs', 'default', new TextEncoder().encode(JSON.stringify(v0)));

    const migration: SchemaMigration = (d) => ({
      ...d,
      schemaVersion: 1,
      settings: { ...d.settings, locale: 'cs' },
    });
    const migrations = new Map<number, SchemaMigration>([[0, migration]]);

    const store = createStore(backend, crypto, { migrations });
    const data = await store.unlock();

    expect(data.schemaVersion).toBe(1);
    expect(data.settings.locale).toBe('cs');
  });

  it('fails to unlock when a migration is missing', async () => {
    const backend = createMemoryBackend();
    const crypto = createFakeCrypto();
    await backend.put('keys', 'default', crypto.createPlaintext().keyRecord);
    const v0 = {
      schemaVersion: 0,
      profile: { id: 'p0', name: 'Legacy', createdAt: 'now' },
      metrics: [],
      sources: [],
      measurements: [],
      settings: {},
    };
    await backend.put('blobs', 'default', new TextEncoder().encode(JSON.stringify(v0)));

    const store = createStore(backend, crypto); // empty registry
    await expect(store.unlock()).rejects.toThrow(/migration from version 0/i);
  });

  it('enables encryption: re-seals plaintext data and requires the passphrase', async () => {
    const backend = createMemoryBackend();
    const crypto = createFakeCrypto();
    const store = createStore(backend, crypto);

    await store.init({ profileName: 'Eve' });
    addSource(store, 'Lab E');
    await store.flush();

    await store.enableEncryption('pw');
    await store.lock();

    // Wrong / missing passphrase is rejected per the fake crypto.
    await expect(store.unlock('nope')).rejects.toBeInstanceOf(WrongPassphraseError);
    await expect(store.unlock()).rejects.toBeInstanceOf(WrongPassphraseError);

    const data = await store.unlock('pw');
    expect(data.sources.map((s) => s.name)).toEqual(['Lab E']);
  });

  it('disableEncryption verifies the passphrase and returns to plaintext', async () => {
    const backend = createMemoryBackend();
    const crypto = createFakeCrypto();
    const store = createStore(backend, crypto);

    await store.init({ profileName: 'Grace', passphrase: 'pw' });
    addSource(store, 'Lab G');
    await store.flush();
    expect(await store.mode()).toBe('encrypted');

    // A wrong current passphrase is rejected; the profile stays encrypted.
    await expect(store.disableEncryption('nope')).rejects.toBeInstanceOf(WrongPassphraseError);
    expect(await store.mode()).toBe('encrypted');

    await store.disableEncryption('pw');
    expect(await store.mode()).toBe('plaintext');

    // After disabling, a fresh store over the same backend unlocks without a passphrase.
    await store.lock();
    const data = await store.unlock();
    expect(data.sources.map((s) => s.name)).toEqual(['Lab G']);
  });

  it('verifyPassphrase accepts the correct passphrase and rejects a wrong one (encrypted)', async () => {
    const backend = createMemoryBackend();
    const store = createStore(backend, createFakeCrypto());

    await store.init({ profileName: 'Grace', passphrase: 'pw' });

    expect(await store.verifyPassphrase('pw')).toBe(true);
    expect(await store.verifyPassphrase('nope')).toBe(false);
    expect(await store.verifyPassphrase('')).toBe(false);
    // Verifying is side-effect free — the profile stays encrypted and unlocked.
    expect(await store.mode()).toBe('encrypted');
    expect(await store.status()).toBe('unlocked');
  });

  it('verifyPassphrase always returns true for a plaintext profile', async () => {
    const backend = createMemoryBackend();
    const store = createStore(backend, createFakeCrypto());

    await store.init({ profileName: 'Grace' });

    expect(await store.verifyPassphrase('')).toBe(true);
    expect(await store.verifyPassphrase('anything')).toBe(true);
  });

  it('changePassphrase updates the key record but leaves the blob usable', async () => {
    const backend = createMemoryBackend();
    const crypto = createFakeCrypto();
    const store = createStore(backend, crypto);

    await store.init({ profileName: 'Frank', passphrase: 'old' });
    addSource(store, 'Lab F');
    await store.flush();

    await store.changePassphrase('old', 'new');
    await store.lock();

    await expect(store.unlock('old')).rejects.toBeInstanceOf(WrongPassphraseError);
    const data = await store.unlock('new');
    expect(data.sources.map((s) => s.name)).toEqual(['Lab F']);
  });

  it('wipe clears everything and returns to uninitialized', async () => {
    const backend = createMemoryBackend();
    const store = createStore(backend, createFakeCrypto());

    await store.init({ profileName: 'Grace' });
    addSource(store, 'Lab G');
    await store.flush();

    await store.wipe();

    expect(await store.status()).toBe('uninitialized');
    expect(await backend.keys('blobs')).toEqual([]);
    expect(await backend.keys('keys')).toEqual([]);
    expect(() => store.getData()).toThrow(/locked/i);
  });
});
