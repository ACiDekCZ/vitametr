import { describe, expect, it } from 'vitest';

import {
  isZipMagic,
  listZipEntries,
  openZipEntry,
  UnsupportedZipError,
} from '../zip.js';

// ---------------------------------------------------------------------------
// In-memory ZIP builder (test-only). Assembles a standard single-disk archive
// with stored (method 0) and/or deflate (method 8) entries. CRC fields are left
// zero — neither the reader nor DecompressionStream verify them.
// ---------------------------------------------------------------------------

interface BuildEntry {
  name: string;
  data: Uint8Array;
  method: 0 | 8;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(
    new CompressionStream('deflate-raw'),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function u16(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff];
}
function u32(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
}

async function buildZip(entries: BuildEntry[]): Promise<Blob> {
  const enc = new TextEncoder();
  const local: number[] = [];
  const central: number[] = [];
  const offsets: number[] = [];

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const stored = e.method === 8 ? await deflateRaw(e.data) : e.data;
    const offset = local.length;
    offsets.push(offset);

    // Local File Header.
    local.push(...u32(0x04034b50));
    local.push(...u16(20)); // version needed
    local.push(...u16(0)); // flags
    local.push(...u16(e.method));
    local.push(...u16(0), ...u16(0)); // mod time/date
    local.push(...u32(0)); // crc32
    local.push(...u32(stored.length)); // compressed size
    local.push(...u32(e.data.length)); // uncompressed size
    local.push(...u16(nameBytes.length));
    local.push(...u16(0)); // extra len
    local.push(...nameBytes);
    local.push(...stored);

    // Central Directory header (assembled with the final offset).
    central.push(...u32(0x02014b50));
    central.push(...u16(20), ...u16(20)); // version made by / needed
    central.push(...u16(0)); // flags
    central.push(...u16(e.method));
    central.push(...u16(0), ...u16(0)); // mod time/date
    central.push(...u32(0)); // crc32
    central.push(...u32(stored.length));
    central.push(...u32(e.data.length));
    central.push(...u16(nameBytes.length));
    central.push(...u16(0), ...u16(0)); // extra / comment len
    central.push(...u16(0), ...u16(0)); // disk start / internal attrs
    central.push(...u32(0)); // external attrs
    central.push(...u32(offset));
    central.push(...nameBytes);
  }

  const cdOffset = local.length;
  const eocd: number[] = [];
  eocd.push(...u32(0x06054b50));
  eocd.push(...u16(0), ...u16(0)); // disk numbers
  eocd.push(...u16(entries.length), ...u16(entries.length));
  eocd.push(...u32(central.length));
  eocd.push(...u32(cdOffset));
  eocd.push(...u16(0)); // comment len

  return new Blob([new Uint8Array([...local, ...central, ...eocd])]);
}

async function readEntry(zip: Blob, name: string): Promise<string> {
  const entries = await listZipEntries(zip);
  const entry = entries.find((e) => e.name === name)!;
  const stream = await openZipEntry(zip, entry);
  return new Response(stream).text();
}

describe('isZipMagic', () => {
  it('recognises the PK\\x03\\x04 local header magic', () => {
    expect(isZipMagic(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    expect(isZipMagic(new Uint8Array([0x50, 0x4b, 0x05, 0x06]))).toBe(false);
    expect(isZipMagic(new Uint8Array([0x3c, 0x3f]))).toBe(false);
  });
});

describe('listZipEntries + openZipEntry — round-trip', () => {
  it('round-trips a stored (method 0) entry', async () => {
    const payload = 'the quick brown fox '.repeat(50);
    const zip = await buildZip([
      { name: 'note.txt', data: new TextEncoder().encode(payload), method: 0 },
    ]);
    const entries = await listZipEntries(zip);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: 'note.txt', method: 0 });
    expect(await readEntry(zip, 'note.txt')).toBe(payload);
  });

  it('round-trips a deflate (method 8) entry', async () => {
    const payload = 'compress me '.repeat(500);
    const zip = await buildZip([
      { name: 'big.txt', data: new TextEncoder().encode(payload), method: 8 },
    ]);
    const entries = await listZipEntries(zip);
    expect(entries[0].method).toBe(8);
    expect(entries[0].compressedSize).toBeLessThan(payload.length);
    expect(await readEntry(zip, 'big.txt')).toBe(payload);
  });

  it('selects apple_health_export/export.xml among several entries, never the CDA file', async () => {
    const exportXml = '<HealthData><Record type="x"/></HealthData>';
    const cda = '<ClinicalDocument>redundant</ClinicalDocument>';
    const zip = await buildZip([
      { name: 'apple_health_export/export_cda.xml', data: new TextEncoder().encode(cda), method: 8 },
      { name: 'apple_health_export/export.xml', data: new TextEncoder().encode(exportXml), method: 8 },
    ]);
    const entries = await listZipEntries(zip);
    expect(entries.map((e) => e.name)).toContain('apple_health_export/export.xml');
    expect(await readEntry(zip, 'apple_health_export/export.xml')).toBe(exportXml);
  });
});

describe('errors', () => {
  it('throws UnsupportedZipError for a non-archive blob', async () => {
    const notZip = new Blob([new TextEncoder().encode('<HealthData/>')]);
    await expect(listZipEntries(notZip)).rejects.toBeInstanceOf(UnsupportedZipError);
  });

  it('throws UnsupportedZipError for an unsupported compression method', async () => {
    const zip = await buildZip([
      { name: 'x.txt', data: new TextEncoder().encode('hi'), method: 0 },
    ]);
    const entries = await listZipEntries(zip);
    const bogus = { ...entries[0], method: 12 };
    await expect(openZipEntry(zip, bogus)).rejects.toBeInstanceOf(UnsupportedZipError);
  });
});

// Re-exported for other test files that need to assemble a fixture zip.
export { buildZip };
