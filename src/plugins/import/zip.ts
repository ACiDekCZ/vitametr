/**
 * Minimal, zero-dependency streaming ZIP reader.
 *
 * A real Apple Health export is an ~8 MB ZIP whose inner
 * `apple_health_export/export.xml` is ~200 MB (~500k `<Record>` elements).
 * Reading the whole archive — or the whole inflated XML — into a JS string
 * blows past a mobile PWA's memory budget. This reader never does that: it
 * seeks the archive with `Blob.slice` (only tiny header ranges are read into
 * memory) and inflates the chosen entry with the built-in
 * `DecompressionStream('deflate-raw')`, handing the caller a byte *stream*.
 *
 * Scope: single-disk archives, stored (method 0) and deflate (method 8), no
 * ZIP64. This covers Apple's export and the common `.zip` a user would drop in.
 * Anything outside that throws {@link UnsupportedZipError} so the caller can
 * surface a clear "unsupported archive" message instead of guessing.
 *
 * All multi-byte fields are little-endian (the ZIP spec's byte order).
 */

/** One central-directory entry (enough to locate + extract the file). */
export interface ZipEntry {
  /** Entry path as stored, e.g. `apple_health_export/export.xml`. */
  name: string;
  /** Compression method: 0 = stored, 8 = deflate. */
  method: number;
  /** Compressed size in bytes (the on-disk length of the entry's data). */
  compressedSize: number;
  /** Uncompressed size in bytes (informational; not required to extract). */
  uncompressedSize: number;
  /** Byte offset of the entry's Local File Header within the archive. */
  localHeaderOffset: number;
}

/** Thrown for archives this minimal reader cannot handle (ZIP64, odd method…). */
export class UnsupportedZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedZipError';
  }
}

// ZIP record signatures.
const SIG_EOCD = 0x06054b50; // End Of Central Directory
const SIG_CENTRAL = 0x02014b50; // Central Directory file header
const SIG_LOCAL = 0x04034b50; // Local File Header

// A 32-bit field set to all-ones means "see the ZIP64 extra field".
const ZIP64_SENTINEL = 0xffffffff;

/** How far back from EOF to scan for the EOCD signature (spec: comment ≤ 64 KB). */
const EOCD_SCAN = 64 * 1024 + 22;

async function sliceView(file: Blob, start: number, end: number): Promise<DataView> {
  const buf = await file.slice(start, end).arrayBuffer();
  return new DataView(buf);
}

/** Locate the End Of Central Directory record by scanning the archive tail. */
async function readEocd(
  file: Blob,
): Promise<{ cdOffset: number; cdSize: number; cdCount: number }> {
  const size = file.size;
  const scanLen = Math.min(EOCD_SCAN, size);
  const start = size - scanLen;
  const view = await sliceView(file, start, size);

  // Search backwards for the signature; the record is >= 22 bytes, so it must
  // begin at or before scanLen - 22.
  for (let i = scanLen - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) !== SIG_EOCD) continue;
    const cdCount = view.getUint16(i + 10, true);
    const cdSize = view.getUint32(i + 12, true);
    const cdOffset = view.getUint32(i + 16, true);
    if (
      cdCount === 0xffff ||
      cdSize === ZIP64_SENTINEL ||
      cdOffset === ZIP64_SENTINEL
    ) {
      throw new UnsupportedZipError('ZIP64 archives are not supported');
    }
    return { cdOffset, cdSize, cdCount };
  }
  throw new UnsupportedZipError('not a ZIP archive (no end-of-central-directory record)');
}

/**
 * Enumerate an archive's entries from its Central Directory. Reads only the
 * EOCD tail and the (small) central directory — never the whole file.
 */
export async function listZipEntries(file: Blob): Promise<ZipEntry[]> {
  const { cdOffset, cdSize, cdCount } = await readEocd(file);
  const view = await sliceView(file, cdOffset, cdOffset + cdSize);
  const decoder = new TextDecoder('utf-8');
  const entries: ZipEntry[] = [];

  let p = 0;
  for (let n = 0; n < cdCount; n += 1) {
    if (view.getUint32(p, true) !== SIG_CENTRAL) {
      throw new UnsupportedZipError('malformed central directory');
    }
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const uncompressedSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localHeaderOffset = view.getUint32(p + 42, true);

    if (
      compressedSize === ZIP64_SENTINEL ||
      uncompressedSize === ZIP64_SENTINEL ||
      localHeaderOffset === ZIP64_SENTINEL
    ) {
      throw new UnsupportedZipError('ZIP64 entries are not supported');
    }

    const nameBytes = new Uint8Array(view.buffer, view.byteOffset + p + 46, nameLen);
    const name = decoder.decode(nameBytes);

    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Open one entry as a decompressed byte stream. Reads the entry's Local File
 * Header to find where its data begins (the LFH's own name/extra lengths can
 * differ from the central directory's), slices the compressed range, and
 * inflates it via `DecompressionStream('deflate-raw')` for deflate, or returns
 * the raw slice's stream for stored entries. Memory stays bounded: only the
 * 30-byte header is read eagerly; the data flows as a stream.
 */
export async function openZipEntry(
  file: Blob,
  entry: ZipEntry,
): Promise<ReadableStream<Uint8Array>> {
  if (entry.method !== 0 && entry.method !== 8) {
    throw new UnsupportedZipError(`unsupported compression method ${entry.method}`);
  }
  const header = await sliceView(file, entry.localHeaderOffset, entry.localHeaderOffset + 30);
  if (header.getUint32(0, true) !== SIG_LOCAL) {
    throw new UnsupportedZipError('malformed local file header');
  }
  const nameLen = header.getUint16(26, true);
  const extraLen = header.getUint16(28, true);
  const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;
  const dataEnd = dataStart + entry.compressedSize;

  const raw = file.slice(dataStart, dataEnd).stream() as ReadableStream<Uint8Array>;
  if (entry.method === 0) return raw;
  // The DOM lib types `DecompressionStream.writable` as `WritableStream<BufferSource>`,
  // which `pipeThrough` rejects against a `Uint8Array` source; the runtime contract is
  // a plain byte transform, so cast to the precise pair shape.
  const inflate = new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<
    Uint8Array,
    Uint8Array
  >;
  return raw.pipeThrough(inflate);
}

/** True when the first bytes are the local-file-header magic `PK\x03\x04`. */
export function isZipMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

/** Read the first four bytes of a blob and test the ZIP magic. */
export async function isZipFile(file: Blob): Promise<boolean> {
  if (file.size < 4) return false;
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return isZipMagic(head);
}
