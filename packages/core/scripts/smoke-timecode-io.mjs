/**
 * Quick smoke: LTC encode→decode + MTC quarter-frame assembly.
 * Run: node packages/core/scripts/smoke-timecode-io.mjs
 * (requires packages/core build first)
 */
import {
  MtcAssembler,
  decodeLtcFrameBits,
  encodeLtcFrameBits,
  formatSyncTimecode,
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

console.log("smoke-timecode-io: ok");
