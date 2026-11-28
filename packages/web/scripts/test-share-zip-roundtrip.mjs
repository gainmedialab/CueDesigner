/**
 * Round-trip: core share package → store ZIP → unzip → parseSharePackage.
 * Mirrors the browser Share / Open shared path without DOM downloads.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSharePackage,
  createCue,
  createProject,
  parseSharePackage,
  placeCue,
  setProjectMedia,
} from "../../core/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Inline the store ZIP builder/reader (same algorithms as zipDownload.ts).
function crc32(data) {
  let c = 0xffff_ffff;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb8_8320 ^ (c >>> 1)) : c >>> 1;
  }
  return (c ^ 0xffff_ffff) >>> 0;
}
function u16(n) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n & 0xffff, true);
  return b;
}
function u32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}
function concat(parts) {
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
function buildZip(entries) {
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = enc.encode(entry.filename.replace(/^\/+/, ""));
    const data =
      typeof entry.content === "string"
        ? enc.encode(entry.content)
        : entry.content;
    const checksum = crc32(data);
    const size = data.length;
    const flags = 0x0800;
    const local = concat([
      u32(0x04034b50),
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
  return concat([...locals, centralDir, end]);
}

function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.ok(eocd >= 0);
  const entryCount = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = [];
  let cursor = centralOffset;
  for (let n = 0; n < entryCount; n++) {
    const method = view.getUint16(cursor + 10, true);
    const compSize = view.getUint32(cursor + 20, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = dec.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen));
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    assert.equal(method, 0);
    if (!name.endsWith("/")) {
      out.push({
        filename: name,
        content: bytes.subarray(dataStart, dataStart + compSize),
      });
    }
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const project0 = createProject("Zip Roundtrip");
const withMedia = setProjectMedia(project0, {
  id: "m1",
  name: "track.wav",
  mimeType: "audio/wav",
  durationSec: 3,
});
const cue = createCue({
  id: "c1",
  tAbs: 0.5,
  departmentId: withMedia.departments[0].id,
  cueNoDept: "1",
  label: "GO",
});
const project = { ...withMedia, cues: placeCue(withMedia.cues, cue) };
const media = new TextEncoder().encode("fake-wav-bytes");

const packed = buildSharePackage({
  project,
  mediaBytes: media,
  mediaName: "track.wav",
  mediaMimeType: "audio/wav",
});
const zipBytes = buildZip(packed.entries);
const unzipped = readZip(zipBytes);
const parsed = parseSharePackage(unzipped);

assert.equal(parsed.project.name, "Zip Roundtrip");
assert.equal(parsed.project.cues[0].label, "GO");
assert.ok(parsed.media);
assert.deepEqual([...parsed.media.bytes], [...media]);

// Sanity: source files exist for the UI path
assert.ok(
  readFileSync(join(__dirname, "../src/zipDownload.ts"), "utf8").includes(
    "readZipEntries",
  ),
);

void createRequire;
console.log("test-share-zip-roundtrip: ok");
