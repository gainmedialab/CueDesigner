/**
 * Minimal uncompressed (STORE) ZIP builder for browser downloads.
 * Avoids multi-file download blockers — one .zip click delivers every export.
 */

function crc32(data: Uint8Array): number {
  let c = 0xffff_ffff;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i]!;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xedb8_8320 ^ (c >>> 1)) : c >>> 1;
    }
  }
  return (c ^ 0xffff_ffff) >>> 0;
}

function u16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n & 0xffff, true);
  return b;
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export interface ZipEntry {
  filename: string;
  content: string | Uint8Array;
}

/** Build a ZIP blob (store-only) from text/binary entries. */
export function buildZipBlob(entries: ZipEntry[]): Blob {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.filename.replace(/^\/+/, ""));
    const data =
      typeof entry.content === "string"
        ? enc.encode(entry.content)
        : entry.content;
    const checksum = crc32(data);
    const size = data.length;
    // bit 11 = UTF-8 filenames
    const flags = 0x0800;
    const local = concat([
      u32(0x04034b50),
      u16(20),
      u16(flags),
      u16(0), // store
      u16(0),
      u16(0),
      u32(checksum),
      u32(size),
      u32(size),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
      data,
    ]);
    const central = concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(flags),
      u16(0),
      u16(0),
      u16(0),
      u32(checksum),
      u32(size),
      u32(size),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBytes,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const centralDir = concat(centrals);
  const end = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ]);

  const bytes = concat([...locals, centralDir, end]);
  // Copy into a plain ArrayBuffer so BlobPart typing is happy under DOM libs.
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Blob([ab], { type: "application/zip" });
}

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the click has been processed.
  window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

function readU16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

/**
 * Minimal ZIP reader for CueDesigner share packages.
 * Supports store (method 0) entries — matches buildZipBlob output.
 * Inflate/deflate archives are rejected with a clear error.
 */
export async function readZipEntries(
  source: Blob | ArrayBuffer | Uint8Array,
): Promise<{ filename: string; content: Uint8Array }[]> {
  let bytes: Uint8Array;
  if (source instanceof Uint8Array) {
    bytes = source;
  } else if (source instanceof ArrayBuffer) {
    bytes = new Uint8Array(source);
  } else {
    bytes = new Uint8Array(await source.arrayBuffer());
  }

  if (bytes.byteLength < 22) {
    throw new Error("ZIP is too small");
  }

  // Copy into a standalone buffer so DataView offsets are byte-accurate.
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const view = new DataView(ab);
  const u8 = new Uint8Array(ab);

  // Locate end-of-central-directory (scan backwards for signature).
  let eocd = -1;
  for (let i = u8.byteLength - 22; i >= 0; i--) {
    if (readU32(view, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error("ZIP end-of-central-directory not found");
  }

  const entryCount = readU16(view, eocd + 10);
  const centralSize = readU32(view, eocd + 12);
  const centralOffset = readU32(view, eocd + 16);
  if (centralOffset + centralSize > u8.byteLength) {
    throw new Error("ZIP central directory is truncated");
  }

  const dec = new TextDecoder();
  const out: { filename: string; content: Uint8Array }[] = [];
  let cursor = centralOffset;

  for (let n = 0; n < entryCount; n++) {
    if (readU32(view, cursor) !== 0x02014b50) {
      throw new Error("ZIP central directory entry is corrupt");
    }
    const method = readU16(view, cursor + 10);
    const compSize = readU32(view, cursor + 20);
    const nameLen = readU16(view, cursor + 28);
    const extraLen = readU16(view, cursor + 30);
    const commentLen = readU16(view, cursor + 32);
    const localOffset = readU32(view, cursor + 42);
    const name = dec.decode(u8.subarray(cursor + 46, cursor + 46 + nameLen));

    if (readU32(view, localOffset) !== 0x04034b50) {
      throw new Error(`ZIP local header missing for ${name}`);
    }
    const localNameLen = readU16(view, localOffset + 26);
    const localExtraLen = readU16(view, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > u8.byteLength) {
      throw new Error(`ZIP entry truncated: ${name}`);
    }

    if (method !== 0) {
      throw new Error(
        `ZIP entry “${name}” uses compression method ${method}; CueDesigner share packages must be store-only (uncompressed). Re-Share from CueDesigner.`,
      );
    }

    // Skip directory markers
    if (!name.endsWith("/")) {
      out.push({
        filename: name.replace(/^\/+/, ""),
        content: u8.subarray(dataStart, dataEnd),
      });
    }

    cursor += 46 + nameLen + extraLen + commentLen;
  }

  return out;
}
