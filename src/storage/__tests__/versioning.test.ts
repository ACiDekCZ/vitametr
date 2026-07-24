import { describe, expect, it } from 'vitest';
import type { CryptoBox, CryptoProvider, KvBackend } from '../../core/contracts';
import type { ProfileData } from '../../core/types';
import { CURRENT_SCHEMA_VERSION } from '../../core/types';
import { createMemoryBackend } from '../db';
import { createStore } from '../store';
import { jsonBackupImportPlugin } from '../../plugins/import/json-backup';

// Identity crypto (no real encryption needed for these tests).
const box: CryptoBox = {
  async seal(p) {
    return p;
  },
  async open(s) {
    return s;
  },
};
function fakeCrypto(): CryptoProvider {
  return {
    async createEncrypted() {
      return { box, keyRecord: { mode: 'encrypted', payload: {} } };
    },
    async unlockEncrypted() {
      return box;
    },
    createPlaintext() {
      return { box, keyRecord: { mode: 'plaintext' } };
    },
    unlockPlaintext() {
      return box;
    },
    async changePassphrase() {
      return { mode: 'encrypted', payload: {} };
    },
    async upgradeToEncrypted() {
      return { box, keyRecord: { mode: 'encrypted', payload: {} } };
    },
  };
}

async function readBlob(backend: KvBackend): Promise<ProfileData> {
  const sealed = (await backend.get('blobs', 'default')) as Uint8Array;
  return JSON.parse(new TextDecoder().decode(sealed)) as ProfileData;
}

describe('appVersion stamping (app version vs data schema version)', () => {
  it('stamps the writing build on every persisted blob', async () => {
    const backend = createMemoryBackend();
    const store = createStore(backend, fakeCrypto(), { appVersion: '9.9.9' });
    await store.init({ profileName: 'P' });
    await store.flush();
    const blob = await readBlob(backend);
    expect(blob.appVersion).toBe('9.9.9');
    // schemaVersion is separate and unaffected by app version.
    expect(blob.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });
});

describe('forward compatibility: unknown fields survive a load/save round-trip', () => {
  it('preserves fields written by a hypothetical newer app', async () => {
    const backend = createMemoryBackend();
    const s1 = createStore(backend, fakeCrypto(), { appVersion: '1.0.0' });
    await s1.init({ profileName: 'P' });
    // A newer app wrote extra fields this build does not model.
    s1.mutate((d) => {
      (d as unknown as Record<string, unknown>).futureTopLevel = { some: 'value' };
      (d.settings as unknown as Record<string, unknown>).futureSetting = 42;
    });
    await s1.flush();
    await s1.lock();

    // An "older" build reloads, makes an unrelated change, and saves again.
    const s2 = createStore(backend, fakeCrypto(), { appVersion: '1.0.0' });
    const data = await s2.unlock();
    expect((data as unknown as Record<string, unknown>).futureTopLevel).toEqual({ some: 'value' });
    s2.mutate((d) => {
      d.settings.autoLockMinutes = 5;
    });
    await s2.flush();

    const blob = await readBlob(backend);
    expect((blob as unknown as Record<string, unknown>).futureTopLevel).toEqual({ some: 'value' });
    expect((blob.settings as unknown as Record<string, unknown>).futureSetting).toBe(42);
    expect(blob.settings.autoLockMinutes).toBe(5);
  });
});

describe('backup restore refuses a newer schema', () => {
  it('throws when the backup schemaVersion exceeds the supported version', async () => {
    const backup = {
      format: 'vitametr-backup',
      backupVersion: 1,
      schemaVersion: CURRENT_SCHEMA_VERSION + 1,
      profile: { id: 'p', name: 'P', createdAt: '2026-01-01T00:00:00Z' },
      metrics: [],
      sources: [],
      measurements: [],
      settings: {},
    };
    await expect(
      jsonBackupImportPlugin.parse({ kind: 'data', data: backup }, { catalog: {} as never }),
    ).rejects.toThrow(/newer than supported/);
  });

  it('accepts a backup at the current schema version', async () => {
    const backup = {
      format: 'vitametr-backup',
      backupVersion: 1,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      profile: { id: 'p', name: 'P', createdAt: '2026-01-01T00:00:00Z' },
      metrics: [],
      sources: [],
      measurements: [],
      settings: {},
    };
    const proposals = await jsonBackupImportPlugin.parse(
      { kind: 'data', data: backup },
      { catalog: {} as never },
    );
    expect(Array.isArray(proposals)).toBe(true);
  });
});
