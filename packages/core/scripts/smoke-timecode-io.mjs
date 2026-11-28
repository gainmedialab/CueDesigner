/**
 * Quick smoke: LTC encode→decode + MTC quarter-frame assembly.
 * Run: node packages/core/scripts/smoke-timecode-io.mjs
 * (requires packages/core build first)
 */
import {
  MtcAssembler,
  absoluteToSyncFrame,
  decodeLtcFrameBits,
  encodeLtcFrameBits,
  encodeMtcQuarterFrameData,
  formatSyncTimecode,
  frameRateLabelToMtcRateBits,
  ltcBitsToBiphasePcm,
  syncFrameToAbsolute,
} from "../dist/index.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// LTC roundtrip
const tc = {
  hours: 1,
  minutes: 2,
  seconds: 3,
  frames: 4,
  dropFrame: false,
  fpsLabel: "25",
};
const bits = encodeLtcFrameBits(tc);
const decoded = decodeLtcFrameBits(bits);
assert(decoded, "LTC decode failed");
assert(decoded.hours === 1 && decoded.minutes === 2, "LTC HMS mismatch");
assert(decoded.seconds === 3 && decoded.frames === 4, "LTC SF mismatch");
assert(formatSyncTimecode(decoded) === "01:02:03:04", "format mismatch");

// Bi-phase PCM length sanity
const pcm = ltcBitsToBiphasePcm(bits, 48);
assert(pcm.length === 80 * 48, "PCM length");

// Absolute from show TC
const tAbs = syncFrameToAbsolute(decoded, "25", 3600);
assert(Math.abs(tAbs - (1 * 3600 + 2 * 60 + 3 + 4 / 25 - 3600)) < 1e-6, "abs");

// Generate path: absolute → frame → LTC encode (transport-locked out)
const gen = absoluteToSyncFrame(125.16, "25", 3600); // 01:02:05:04 @ 25
assert(gen.hours === 1 && gen.minutes === 2, "gen HMS");
assert(gen.seconds === 5 && gen.frames === 4, "gen SF");
assert(gen.dropFrame === false, "gen DF");
const genBits = encodeLtcFrameBits(gen);
const genDecoded = decodeLtcFrameBits(genBits);
assert(genDecoded && genDecoded.frames === 4, "gen LTC roundtrip");

// MTC quarter frames for 01:02:03:04 @ 25fps (rate bits = 1)
const assembler = new MtcAssembler();
const frames = 4;
const seconds = 3;
const minutes = 2;
const hours = 1;
const rateBits = 1; // 25 fps
const nibbles = [
  frames & 0xf,
  (frames >> 4) & 0xf,
  seconds & 0xf,
  (seconds >> 4) & 0xf,
  minutes & 0xf,
  (minutes >> 4) & 0xf,
  hours & 0xf,
  ((hours >> 4) & 0x1) | (rateBits << 1),
];
let got = null;
for (let type = 0; type < 8; type++) {
  got = assembler.pushQuarterFrame((type << 4) | nibbles[type]);
}
assert(got, "MTC did not assemble");
assert(got.hours === 1 && got.frames === 4, "MTC fields");
assert(got.fpsLabel === "25", "MTC rate");

// MTC encode helper (stub for future MIDI out) round-trips via assembler
assert(frameRateLabelToMtcRateBits("25") === 1, "mtc rate bits");
const qf = encodeMtcQuarterFrameData({
  hours: 1,
  minutes: 2,
  seconds: 3,
  frames: 4,
  fpsLabel: "25",
});
assert(qf.length === 8, "qf length");
const assembler2 = new MtcAssembler();
let got2 = null;
for (const b of qf) got2 = assembler2.pushQuarterFrame(b);
assert(got2 && got2.hours === 1 && got2.frames === 4, "qf encode roundtrip");

console.log("smoke-timecode-io: ok");
