import { describe, expect, it } from 'vitest';
import {
  createCryptoProvider,
  openWithPassphrase,
  sealWithPassphrase,
} from '../crypto';
import { TamperedDataError, WrongPassphraseError } from '../../core/contracts';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('encrypted mode', () => {
  it('round-trips data through seal/open', async () => {
    const p = createCryptoProvider();
    const { box } = await p.createEncrypted('correct horse');
    const sealed = await box.seal(enc('secret health data'));
    expect(dec(await box.open(sealed))).toBe('secret health data');
  });

  it('produces different ciphertext each seal (random IV)', async () => {
    const p = createCryptoProvider();
    const { box } = await p.createEncrypted('pw');
    const a = await box.seal(enc('same'));
    const b = await box.seal(enc('same'));
    expect(toHex(a)).not.toBe(toHex(b));
    expect(dec(await box.open(a))).toBe('same');
    expect(dec(await box.open(b))).toBe('same');
  });

  it('unlocks with the correct passphrase across a fresh provider', async () => {
    const p1 = createCryptoProvider();
    const { box, keyRecord } = await p1.createEncrypted('pw123');
    const sealed = await box.seal(enc('payload'));

    const p2 = createCryptoProvider();
    const reopened = await p2.unlockEncrypted('pw123', keyRecord);
    expect(dec(await reopened.open(sealed))).toBe('payload');
  });

  it('rejects a wrong passphrase with WrongPassphraseError', async () => {
    const p = createCryptoProvider();
    const { keyRecord } = await p.createEncrypted('right');
    await expect(p.unlockEncrypted('wrong', keyRecord)).rejects.toBeInstanceOf(
      WrongPassphraseError,
    );
  });

  it('detects tampering (GCM auth tag)', async () => {
    const p = createCryptoProvider();
    const { box } = await p.createEncrypted('pw');
    const sealed = await box.seal(enc('trustworthy'));
    sealed[sealed.length - 1] ^= 0xff; // flip a ciphertext byte
    await expect(box.open(sealed)).rejects.toBeInstanceOf(TamperedDataError);
  });
});

describe('change passphrase', () => {
  it('re-wraps the key without touching data; old ciphertext opens under new passphrase', async () => {
    const p = createCryptoProvider();
    const { box, keyRecord } = await p.createEncrypted('old-pass');
    const sealed = await box.seal(enc('unchanged blob'));

    const newRecord = await p.changePassphrase('old-pass', 'new-pass', keyRecord);
    const reopened = await p.unlockEncrypted('new-pass', newRecord);
    // Same DEK underneath → data sealed before the change still opens.
    expect(dec(await reopened.open(sealed))).toBe('unchanged blob');

    await expect(
      p.unlockEncrypted('old-pass', newRecord),
    ).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it('fails to change with a wrong old passphrase', async () => {
    const p = createCryptoProvider();
    const { keyRecord } = await p.createEncrypted('old');
    await expect(
      p.changePassphrase('not-old', 'new', keyRecord),
    ).rejects.toBeInstanceOf(WrongPassphraseError);
  });
});

describe('plaintext mode', () => {
  it('round-trips with an identity box and a plaintext key record', async () => {
    const p = createCryptoProvider();
    const { box, keyRecord } = p.createPlaintext();
    expect(keyRecord.mode).toBe('plaintext');
    const sealed = await box.seal(enc('visible'));
    expect(dec(await box.open(sealed))).toBe('visible');
  });

  it('unlockPlaintext yields a working box', async () => {
    const p = createCryptoProvider();
    const { keyRecord } = p.createPlaintext();
    const box = p.unlockPlaintext(keyRecord);
    expect(dec(await box.open(await box.seal(enc('x'))))).toBe('x');
  });
});

describe('upgrade to encrypted', () => {
  it('returns a box that can re-seal previously plaintext data', async () => {
    const p = createCryptoProvider();
    const plainData = enc('was plaintext');

    const { box, keyRecord } = await p.upgradeToEncrypted('new-pw');
    expect(keyRecord.mode).toBe('encrypted');
    const sealed = await box.seal(plainData);

    const reopened = await p.unlockEncrypted('new-pw', keyRecord);
    expect(dec(await reopened.open(sealed))).toBe('was plaintext');
  });
});

describe('passphrase envelope (encrypted backup files)', () => {
  it('round-trips arbitrary bytes through seal/open', async () => {
    const env = await sealWithPassphrase(enc('backup payload'), 'export-pw');
    expect(dec(await openWithPassphrase(env, 'export-pw'))).toBe('backup payload');
  });

  it('is self-describing (carries kdf, salt, iv, ciphertext)', async () => {
    const env = await sealWithPassphrase(enc('x'), 'pw');
    expect(env.kdf).toBe('PBKDF2-SHA256');
    expect(env.salt.length).toBeGreaterThan(0);
    expect(env.iv.length).toBeGreaterThan(0);
    expect(env.ciphertext.length).toBeGreaterThan(0);
  });

  it('uses a random salt+IV so the same input yields different ciphertext', async () => {
    const a = await sealWithPassphrase(enc('same'), 'pw');
    const b = await sealWithPassphrase(enc('same'), 'pw');
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.salt).not.toBe(b.salt);
  });

  it('rejects a wrong password with WrongPassphraseError', async () => {
    const env = await sealWithPassphrase(enc('secret'), 'right-pw');
    await expect(openWithPassphrase(env, 'wrong-pw')).rejects.toBeInstanceOf(
      WrongPassphraseError,
    );
  });
});

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
