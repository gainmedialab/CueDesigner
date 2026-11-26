/**
 * Shared LTC / MTC frame model and pure decode helpers.
 *
 * Web path: Web Audio (LTC) + Web MIDI (MTC). Electron Chromium exposes both;
 * no native addon required for chase v1. Hardware device pickers stay in the UI.
 */

import type { FrameRateLabel } from "./types.js";
import {
  formatTimecodeParts,
  frameRateInfo,
  timecodeToSeconds,
  type TimecodeParts,
} from "./time.js";

/** Session clock source — not persisted (hardware availability is ephemeral). */
export type SyncClockSource = "internal" | "ltc" | "mtc";

export const SYNC_CLOCK_SOURCES: readonly SyncClockSource[] = [
  "internal",
  "ltc",
  "mtc",
] as const;

export type SyncLockState = "unlocked" | "locking" | "locked" | "freewheel";

export interface SyncTimecodeFrame {
  hours: number;
  minutes: number;
  seconds: number;
  frames: number;
  /** Incoming stream rate when known (MTC rate bits / LTC user bits). */
  fpsLabel: FrameRateLabel | null;
  dropFrame: boolean;
}

export interface SyncStatusSnapshot {
  source: SyncClockSource;
  lock: SyncLockState;
  /** Last decoded show-timeline TC, or null. */
  tc: SyncTimecodeFrame | null;
  /** Formatted HH:MM:SS:FF / ;FF for UI. */
  tcDisplay: string | null;
  /** True when incoming FPS matches project FPS (or rate unknown). */
  fpsMatch: boolean;
  /** Human-readable detail (device name, error, waiting…). */
  detail: string;
  /** Wall-clock ms of last good frame (performance.now-compatible). */
  lastFrameAtMs: number | null;
}

export function emptySyncStatus(
  source: SyncClockSource = "internal",
): SyncStatusSnapshot {
  return {
    source,
    lock: "unlocked",
    tc: null,
    tcDisplay: null,
    fpsMatch: true,
    detail: source === "internal" ? "Internal file clock" : "Waiting…",
    lastFrameAtMs: null,
  };
}

export function syncTimecodeToParts(tc: SyncTimecodeFrame): TimecodeParts {
  return {
    hours: tc.hours,
    minutes: tc.minutes,
    seconds: tc.seconds,
    frames: tc.frames,
    dropFrame: tc.dropFrame,
  };
}

export function formatSyncTimecode(tc: SyncTimecodeFrame): string {
  return formatTimecodeParts(syncTimecodeToParts(tc));
}

/**
 * Show-timeline seconds for a decoded frame.
 * Prefer the project FPS so chase stays on the show timebase; fall back to
 * the stream's reported rate when project label is unavailable.
 */
export function syncFrameToShowSeconds(
  tc: SyncTimecodeFrame,
  projectFps: FrameRateLabel,
): number {
  const label = projectFps;
  return timecodeToSeconds(syncTimecodeToParts(tc), label);
}

/** File-relative absolute seconds from show TC + project offset. */
export function syncFrameToAbsolute(
  tc: SyncTimecodeFrame,
  projectFps: FrameRateLabel,
  showTcOffsetSec: number,
): number {
  const showSec = syncFrameToShowSeconds(tc, projectFps);
  return Math.max(0, showSec - (showTcOffsetSec || 0));
}

/** Map MTC rate bits (hours high nibble bits 5–6) → project FPS label. */
export function mtcRateToFrameRateLabel(
  rateBits: number,
): FrameRateLabel | null {
  switch (rateBits & 0b11) {
    case 0:
      return "24";
    case 1:
      return "25";
    case 2:
      return "29.97 DF";
    case 3:
      return "30";
    default:
      return null;
  }
}

/** Compare stream FPS to project FPS (DF vs NDF treated as mismatch). */
export function fpsLabelsMatch(
  incoming: FrameRateLabel | null,
  project: FrameRateLabel,
): boolean {
  if (incoming == null) return true;
  if (incoming === project) return true;
  // 29.97 NDF stream vs project "30" is a common desk mismatch — flag it.
  const a = frameRateInfo(incoming);
  const b = frameRateInfo(project);
  return a.fps === b.fps && a.dropFrame === b.dropFrame;
}

// --- MTC quarter-frame assembly ------------------------------------------------

/**
 * Assembles MIDI Timecode quarter-frame messages (status 0xF1) into full frames.
 * Also accepts full-frame SysEx (F0 7F dd 01 01 hr mn sc fr F7).
 */
export class MtcAssembler {
  private nibbles: number[] = new Array(8).fill(0);
  private received = 0;
  private lastType = -1;

  reset(): void {
    this.nibbles.fill(0);
    this.received = 0;
    this.lastType = -1;
  }

  /**
   * @param dataByte Data byte of a 0xF1 quarter-frame message
   * @returns A complete frame when the 8-nibble sequence finishes (usually on type 7)
   */
  pushQuarterFrame(dataByte: number): SyncTimecodeFrame | null {
    const type = (dataByte >> 4) & 0x7;
    const nibble = dataByte & 0x0f;
    this.nibbles[type] = nibble;

    if (type === 0 || (this.lastType >= 0 && type !== (this.lastType + 1) % 8)) {
      // Soft resync: restart counting from this piece
      this.received = 1 << type;
    } else {
      this.received |= 1 << type;
    }
    this.lastType = type;

    if (type !== 7) return null;
    if ((this.received & 0xff) !== 0xff) return null;
    this.received = 0;
    return this.buildFromNibbles();
  }

  /** Parse MTC full-frame SysEx payload (after F0 7F). */
  pushFullFrameSysEx(data: Uint8Array): SyncTimecodeFrame | null {
    // Expect: 7F / dd / 01 / 01 / hr / mn / sc / fr / F7 (dd = device)
    // Caller may pass from after F0, or the whole SysEx including F0.
    let i = 0;
    if (data.length > 0 && data[0] === 0xf0) i = 1;
    if (data.length - i < 8) return null;
    if (data[i] !== 0x7f) return null;
    // device id at i+1 — ignore
    if (data[i + 2] !== 0x01 || data[i + 3] !== 0x01) return null;
    const hr = data[i + 4]!;
    const mn = data[i + 5]!;
    const sc = data[i + 6]!;
    const fr = data[i + 7]!;
    return this.frameFromBytes(hr, mn, sc, fr);
  }

  private buildFromNibbles(): SyncTimecodeFrame {
    const frames = this.nibbles[0]! | (this.nibbles[1]! << 4);
    const seconds = this.nibbles[2]! | (this.nibbles[3]! << 4);
    const minutes = this.nibbles[4]! | (this.nibbles[5]! << 4);
    const hoursLow = this.nibbles[6]!;
    const hoursHigh = this.nibbles[7]!;
    const hours = (hoursHigh & 0x1) << 4 | hoursLow;
    const rateBits = (hoursHigh >> 1) & 0x3;
    return this.frameFromPieces(hours, minutes, seconds, frames, rateBits);
  }

  private frameFromBytes(
    hr: number,
    mn: number,
    sc: number,
    fr: number,
  ): SyncTimecodeFrame {
    const rateBits = (hr >> 5) & 0x3;
    const hours = hr & 0x1f;
    return this.frameFromPieces(hours, mn & 0x3f, sc & 0x3f, fr & 0x1f, rateBits);
  }

  private frameFromPieces(
    hours: number,
    minutes: number,
    seconds: number,
    frames: number,
    rateBits: number,
  ): SyncTimecodeFrame {
    const fpsLabel = mtcRateToFrameRateLabel(rateBits);
    const dropFrame = fpsLabel === "29.97 DF";
    return {
      hours: hours & 0x1f,
      minutes: minutes & 0x3f,
      seconds: seconds & 0x3f,
      frames: frames & 0x1f,
      fpsLabel,
      dropFrame,
    };
  }
}

// --- LTC bit decode (pure; audio front-end lives in web) -----------------------

/** SMPTE LTC sync word (bits 64–79), LSB-first storage order used by this decoder. */
export const LTC_SYNC_WORD = 0b0011_1111_1111_1101;

/**
 * Decode one 80-bit LTC frame (bit 0 = first transmitted bit / bit 0 of frame).
 * Returns null if sync word is missing.
 */
export function decodeLtcFrameBits(
  bits: ArrayLike<number>,
): SyncTimecodeFrame | null {
  if (bits.length < 80) return null;
  let sync = 0;
  for (let i = 64; i < 80; i++) {
    sync |= (bits[i]! & 1) << (i - 64);
  }
  if (sync !== LTC_SYNC_WORD) return null;

  const framesUnits = bcdNibble(bits, 0);
  const framesTens = bits[8]! | (bits[9]! << 1);
  const secsUnits = bcdNibble(bits, 16);
  const secsTens = bits[24]! | (bits[25]! << 1) | (bits[26]! << 2);
  const minsUnits = bcdNibble(bits, 32);
  const minsTens = bits[40]! | (bits[41]! << 1) | (bits[42]! << 2);
  const hoursUnits = bcdNibble(bits, 48);
  const hoursTens = bits[56]! | (bits[57]! << 1);
  // Bit 10 = drop-frame flag; bit 11 = color frame (ignored)
  const dropFrame = bits[10] === 1;

  const frames = framesTens * 10 + framesUnits;
  const seconds = secsTens * 10 + secsUnits;
  const minutes = minsTens * 10 + minsUnits;
  const hours = hoursTens * 10 + hoursUnits;

  let fpsLabel: FrameRateLabel | null = null;
  if (dropFrame) fpsLabel = "29.97 DF";

  return {
    hours,
    minutes,
    seconds,
    frames,
    fpsLabel,
    dropFrame,
  };
}

function bcdNibble(bits: ArrayLike<number>, start: number): number {
  return (
    (bits[start]! & 1) |
    ((bits[start + 1]! & 1) << 1) |
    ((bits[start + 2]! & 1) << 2) |
    ((bits[start + 3]! & 1) << 3)
  );
}

/**
 * Encode a timecode into 80 LTC bits (for tests / tone generators).
 * Does not set user bits; sync word is written at 64–79.
 */
export function encodeLtcFrameBits(
  tc: Pick<
    SyncTimecodeFrame,
    "hours" | "minutes" | "seconds" | "frames" | "dropFrame"
  >,
): Uint8Array {
  const bits = new Uint8Array(80);
  const writeBcd = (start: number, units: number, tensBits: number, tens: number) => {
    const u = units % 10;
    bits[start] = u & 1;
    bits[start + 1] = (u >> 1) & 1;
    bits[start + 2] = (u >> 2) & 1;
    bits[start + 3] = (u >> 3) & 1;
    for (let i = 0; i < tensBits; i++) {
      bits[start + 8 + i] = (tens >> i) & 1;
    }
  };
  writeBcd(0, tc.frames % 10, 2, Math.floor(tc.frames / 10));
  bits[10] = tc.dropFrame ? 1 : 0;
  writeBcd(16, tc.seconds % 10, 3, Math.floor(tc.seconds / 10));
  writeBcd(32, tc.minutes % 10, 3, Math.floor(tc.minutes / 10));
  writeBcd(48, tc.hours % 10, 2, Math.floor(tc.hours / 10));
  for (let i = 0; i < 16; i++) {
    bits[64 + i] = (LTC_SYNC_WORD >> i) & 1;
  }
  return bits;
}

/**
 * Bi-phase mark modulate LTC bits into a bipolar PCM buffer (−1 / +1).
 * `samplesPerBit` should be ≈ sampleRate / (fps * 80).
 */
export function ltcBitsToBiphasePcm(
  bits: ArrayLike<number>,
  samplesPerBit: number,
): Float32Array {
  const spb = Math.max(2, Math.round(samplesPerBit));
  const out = new Float32Array(bits.length * spb);
  let level = 1;
  let o = 0;
  for (let i = 0; i < bits.length; i++) {
    // Transition at bit start
    level = -level;
    const half = Math.floor(spb / 2);
    for (let s = 0; s < half; s++) out[o++] = level;
    if (bits[i]! & 1) {
      // Mid-bit transition for '1'
      level = -level;
    }
    while (o < (i + 1) * spb) out[o++] = level;
  }
  return out;
}
