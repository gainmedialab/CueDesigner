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
