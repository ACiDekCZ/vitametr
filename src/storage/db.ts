/**
 * Storage backends for the profile store (K5b).
 *
 * The store persists exactly three kinds of records (design doc §4.1):
 *   - 'meta'  — unencrypted bookkeeping (schema version, profile info)
 *   - 'keys'  — the wrapped data key / key record per profile
 *   - 'blobs' — the sealed (or plaintext) profile JSON per profile
 *
 * Two backends are provided:
 *   - createIndexedDbBackend — production, a thin promise wrapper over IndexedDB.
 *   - createMemoryBackend    — tests and unit tests (no IndexedDB, no deps).
 */

import type { KvBackend } from '../core/contracts';

type StoreName = 'meta' | 'keys' | 'blobs';

const STORE_NAMES: readonly StoreName[] = ['meta', 'keys', 'blobs'];

// ---------------------------------------------------------------------------
// In-memory backend (tests, and the store's own unit tests)
// ---------------------------------------------------------------------------

/**
 * An in-memory {@link KvBackend}. Values are held by reference; callers must
 * not mutate stored values after handing them over (the store never does — it
 * always writes freshly serialized bytes).
 */
export function createMemoryBackend(): KvBackend {
  const stores: Record<StoreName, Map<string, unknown>> = {
    meta: new Map(),
    keys: new Map(),
    blobs: new Map(),
  };

  return {
    async get(store, key) {
      return stores[store].has(key) ? stores[store].get(key) : undefined;
    },
    async put(store, key, value) {
      stores[store].set(key, value);
    },
    async delete(store, key) {
      stores[store].delete(key);
    },
    async keys(store) {
      return [...stores[store].keys()];
    },
    async clear() {
      for (const name of STORE_NAMES) stores[name].clear();
    },
  };
}

// ---------------------------------------------------------------------------
// IndexedDB backend (production)
// ---------------------------------------------------------------------------

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDatabase(dbName: string): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is not available in this environment'));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORE_NAMES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another connection'));
  });
}

/**
 * Create an IndexedDB-backed {@link KvBackend}. Creates the three object
 * stores ('meta', 'keys', 'blobs') on first open. Values are stored via the
 * structured clone algorithm, so Uint8Array blobs round-trip as-is.
 */
export async function createIndexedDbBackend(dbName = 'vitametr'): Promise<KvBackend> {
  const db = await openDatabase(dbName);

  function tx(store: StoreName, mode: IDBTransactionMode): IDBObjectStore {
    return db.transaction(store, mode).objectStore(store);
  }

  return {
    async get(store, key) {
      const result = await promisifyRequest(tx(store, 'readonly').get(key));
      return result;
    },
    async put(store, key, value) {
      await promisifyRequest(tx(store, 'readwrite').put(value, key));
    },
    async delete(store, key) {
      await promisifyRequest(tx(store, 'readwrite').delete(key));
    },
    async keys(store) {
      const result = await promisifyRequest(tx(store, 'readonly').getAllKeys());
      return result.map(String);
    },
    async clear() {
      const transaction = db.transaction(STORE_NAMES as unknown as string[], 'readwrite');
      await Promise.all(
        STORE_NAMES.map((name) => promisifyRequest(transaction.objectStore(name).clear())),
      );
    },
  };
}
