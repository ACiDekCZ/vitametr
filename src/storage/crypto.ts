/**
 * Cryptography layer (WebCrypto only — no libraries).
 *
 * Design (see NAVRH-ARCHITEKTURA-MVP.md §4.2):
 *   passphrase --PBKDF2(SHA-256, high iteration count, random salt)--> KEK
 *   KEK --unwrap--> DEK (random AES-GCM 256 data key)
 *   DEK --AES-GCM(random IV per write)--> sealed blob
 *
 * The data key is random and independent of the passphrase; the passphrase
 * only unlocks its wrapper. Changing the passphrase re-wraps the DEK and
 * never re-encrypts the data. A deliberate plaintext mode exposes the same
 * CryptoBox shape (identity transform) so the rest of the app is oblivious.
 */

import type {
  CryptoBox,
  CryptoProvider,
  KeyRecord,
} from '../core/contracts';
import { TamperedDataError, WrongPassphraseError } from '../core/contracts';

const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BITS = 256;

interface EncryptedPayload {
  v: 1;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string; // base64
  wrappedKey: string; // base64 — DEK wrapped with AES-GCM under the KEK
  wrapIv: string; // base64 — IV used for the key wrap
}

// ---------------------------------------------------------------------------
// base64 helpers (work in browser and Node test environments)
// ---------------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(bytes).toString('base64');
}

// WebCrypto wants ArrayBuffer-backed views (BufferSource); pin the generic so
// TS does not widen to Uint8Array<ArrayBufferLike>, which it rejects.
function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  if (typeof atob === 'function') {
    const binary = atob(text);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  const decoded = Buffer.from(text, 'base64');
  const bytes = new Uint8Array(new ArrayBuffer(decoded.length));
  bytes.set(decoded);
  return bytes;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(length));
  crypto.getRandomValues(bytes);
  return bytes;
}

/** Copy any view into a fresh ArrayBuffer-backed array for WebCrypto calls. */
function asBuffer(view: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(view.byteLength));
  out.set(view);
  return out;
}

// ---------------------------------------------------------------------------
// Key derivation and wrapping
// ---------------------------------------------------------------------------

async function deriveKek(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

/**
 * Derive a passphrase key used directly for content encryption (not key
 * wrapping). Used by the standalone backup-file envelope below.
 */
async function deriveContentKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function generateDek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: KEY_BITS }, true, [
    'encrypt',
    'decrypt',
  ]);
}

async function wrapDek(
  dek: CryptoKey,
  kek: CryptoKey,
): Promise<{ wrappedKey: Uint8Array; wrapIv: Uint8Array }> {
  const wrapIv = randomBytes(IV_BYTES);
  const wrapped = await crypto.subtle.wrapKey('raw', dek, kek, {
    name: 'AES-GCM',
    iv: wrapIv,
  });
  return { wrappedKey: new Uint8Array(wrapped), wrapIv };
}

async function unwrapDek(
  wrappedKey: Uint8Array<ArrayBuffer>,
  wrapIv: Uint8Array<ArrayBuffer>,
  kek: CryptoKey,
): Promise<CryptoKey> {
  try {
    return await crypto.subtle.unwrapKey(
      'raw',
      wrappedKey,
      kek,
      { name: 'AES-GCM', iv: wrapIv },
      { name: 'AES-GCM', length: KEY_BITS },
      true,
      ['encrypt', 'decrypt'],
    );
  } catch {
    // A wrong passphrase yields a KEK that fails the GCM auth tag on unwrap.
    throw new WrongPassphraseError('Wrong passphrase');
  }
}

// ---------------------------------------------------------------------------
// CryptoBox implementations
// ---------------------------------------------------------------------------

function createAesBox(dek: CryptoKey): CryptoBox {
  return {
    async seal(plain: Uint8Array): Promise<Uint8Array> {
      const iv = randomBytes(IV_BYTES);
      const cipher = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dek, asBuffer(plain)),
      );
      // Prefix the IV so open() is self-describing.
      const out = new Uint8Array(iv.length + cipher.length);
      out.set(iv, 0);
      out.set(cipher, iv.length);
      return out;
    },
    async open(sealed: Uint8Array): Promise<Uint8Array> {
      const iv = asBuffer(sealed.subarray(0, IV_BYTES));
      const cipher = asBuffer(sealed.subarray(IV_BYTES));
      try {
        return new Uint8Array(
          await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, dek, cipher),
        );
      } catch {
        throw new TamperedDataError('Ciphertext failed authentication');
      }
    },
  };
}

/** Plaintext mode: same shape, no transformation. A defensive copy avoids aliasing. */
function createPlaintextBox(): CryptoBox {
  return {
    async seal(plain: Uint8Array): Promise<Uint8Array> {
      return new Uint8Array(plain);
    },
    async open(sealed: Uint8Array): Promise<Uint8Array> {
      return new Uint8Array(sealed);
    },
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

async function buildEncrypted(
  passphrase: string,
): Promise<{ box: CryptoBox; keyRecord: KeyRecord }> {
  const salt = randomBytes(SALT_BYTES);
  const kek = await deriveKek(passphrase, salt, PBKDF2_ITERATIONS);
  const dek = await generateDek();
  const { wrappedKey, wrapIv } = await wrapDek(dek, kek);
  const payload: EncryptedPayload = {
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iterations: PBKDF2_ITERATIONS,
    salt: toBase64(salt),
    wrappedKey: toBase64(wrappedKey),
    wrapIv: toBase64(wrapIv),
  };
  return { box: createAesBox(dek), keyRecord: { mode: 'encrypted', payload } };
}

async function openEncrypted(
  passphrase: string,
  keyRecord: KeyRecord,
): Promise<CryptoKey> {
  if (keyRecord.mode !== 'encrypted' || !keyRecord.payload) {
    throw new Error('Key record is not an encrypted record');
  }
  const payload = keyRecord.payload as EncryptedPayload;
  const kek = await deriveKek(
    passphrase,
    fromBase64(payload.salt),
    payload.iterations,
  );
  return unwrapDek(
    fromBase64(payload.wrappedKey),
    fromBase64(payload.wrapIv),
    kek,
  );
}

// ---------------------------------------------------------------------------
// Standalone passphrase envelope (for encrypted export/backup files)
//
// Unlike the storage layer, a static backup file needs no key rotation, so the
// passphrase key encrypts the content directly. The envelope is self-describing
// (KDF params + salt + IV) so any build can open it with the right password.
// ---------------------------------------------------------------------------

export interface PassphraseEnvelope {
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string; // base64
  iv: string; // base64
  ciphertext: string; // base64 — AES-GCM of the plaintext content
}

/** Encrypt arbitrary bytes under a passphrase into a portable envelope. */
export async function sealWithPassphrase(
  plain: Uint8Array,
  passphrase: string,
): Promise<PassphraseEnvelope> {
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveContentKey(passphrase, salt, PBKDF2_ITERATIONS);
  const iv = randomBytes(IV_BYTES);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, asBuffer(plain)),
  );
  return {
    kdf: 'PBKDF2-SHA256',
    iterations: PBKDF2_ITERATIONS,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(cipher),
  };
}

/** Open a passphrase envelope; throws WrongPassphraseError on a bad password. */
export async function openWithPassphrase(
  env: PassphraseEnvelope,
  passphrase: string,
): Promise<Uint8Array> {
  const key = await deriveContentKey(passphrase, fromBase64(env.salt), env.iterations);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(env.iv) },
        key,
        fromBase64(env.ciphertext),
      ),
    );
  } catch {
    // A wrong passphrase (or tampering) fails the GCM auth tag.
    throw new WrongPassphraseError('Wrong passphrase');
  }
}

export function createCryptoProvider(): CryptoProvider {
  return {
    async createEncrypted(passphrase: string) {
      return buildEncrypted(passphrase);
    },

    async unlockEncrypted(passphrase: string, keyRecord: KeyRecord) {
      const dek = await openEncrypted(passphrase, keyRecord);
      return createAesBox(dek);
    },

    createPlaintext() {
      return { box: createPlaintextBox(), keyRecord: { mode: 'plaintext' } };
    },

    unlockPlaintext(keyRecord: KeyRecord) {
      if (keyRecord.mode !== 'plaintext') {
        throw new Error('Key record is not a plaintext record');
      }
      return createPlaintextBox();
    },

    async changePassphrase(
      oldPassphrase: string,
      newPassphrase: string,
      keyRecord: KeyRecord,
    ) {
      // Unwrap the existing DEK, then re-wrap the SAME DEK under a new KEK.
      const dek = await openEncrypted(oldPassphrase, keyRecord);
      const salt = randomBytes(SALT_BYTES);
      const kek = await deriveKek(newPassphrase, salt, PBKDF2_ITERATIONS);
      const { wrappedKey, wrapIv } = await wrapDek(dek, kek);
      const payload: EncryptedPayload = {
        v: 1,
        kdf: 'PBKDF2-SHA256',
        iterations: PBKDF2_ITERATIONS,
        salt: toBase64(salt),
        wrappedKey: toBase64(wrappedKey),
        wrapIv: toBase64(wrapIv),
      };
      return { mode: 'encrypted', payload };
    },

    async upgradeToEncrypted(passphrase: string) {
      // Fresh DEK; caller re-seals existing plaintext data with the new box.
      return buildEncrypted(passphrase);
    },
  };
}
