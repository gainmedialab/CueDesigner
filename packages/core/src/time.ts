import type { FrameRateLabel, ProjectSettings } from "./types.js";
import { beatDurationSec, formatMusicalPosition } from "./grid.js";

/** Display / edit mode for clocks, ruler, cue list, and inspector. */
export type TimeDisplayMode = "absolute" | "timecode" | "musical";

export const TIME_DISPLAY_MODES: readonly TimeDisplayMode[] = [
  "absolute",
  "timecode",
  "musical",
] as const;

export const FRAME_RATE_LABELS: readonly FrameRateLabel[] = [
  "23.976",
  "24",
  "25",
  "29.97 DF",
  "29.97 NDF",
  "30",
] as const;

export interface FrameRateInfo {
  label: FrameRateLabel;
  /** True playback / counting rate (frames per second). */
  fps: number;
  /** Nominal integer rate used for HH:MM:SS:FF fields (24/25/30). */
  nominalFps: number;
  dropFrame: boolean;
}

export function frameRateInfo(label: FrameRateLabel): FrameRateInfo {
  switch (label) {
    case "23.976":
      return {
        label,
        fps: 24000 / 1001,
        nominalFps: 24,
        dropFrame: false,
      };
    case "24":
      return { label, fps: 24, nominalFps: 24, dropFrame: false };
    case "25":
      return { label, fps: 25, nominalFps: 25, dropFrame: false };
    case "29.97 DF":
      return {
        label,
        fps: 30000 / 1001,
        nominalFps: 30,
        dropFrame: true,
      };
    case "29.97 NDF":
      return {
        label,
        fps: 30000 / 1001,
        nominalFps: 30,
        dropFrame: false,
      };
    case "30":
      return { label, fps: 30, nominalFps: 30, dropFrame: false };
    default: {
      const _exhaustive: never = label;
      return _exhaustive;
    }
  }
}

export function isFrameRateLabel(value: string): value is FrameRateLabel {
  return (FRAME_RATE_LABELS as readonly string[]).includes(value);
}

/** Format file-relative seconds as mm:ss.mmm */
export function formatAbsoluteTime(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  const whole = Math.floor(rem);
  const ms = Math.round((rem - whole) * 1000);
  return `${String(m).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

/** Parse mm:ss or mm:ss.mmm (and bare seconds) to seconds. */
export function parseAbsoluteTime(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Number.parseFloat(trimmed);
  }
  const m = trimmed.match(/^(\d+):(\d{1,2})(?:\.(\d{1,3}))?$/);
  if (!m) return null;
  const minutes = Number.parseInt(m[1]!, 10);
  const seconds = Number.parseInt(m[2]!, 10);
  const ms = m[3] ? Number.parseInt(m[3].padEnd(3, "0"), 10) : 0;
  if (seconds >= 60) return null;
  return minutes * 60 + seconds + ms / 1000;
}

export function clampTime(t: number, durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return Math.max(0, t);
  return Math.min(Math.max(0, t), durationSec);
}

export interface TimecodeParts {
  hours: number;
  minutes: number;
  seconds: number;
  frames: number;
  dropFrame: boolean;
}

/** Convert wall-clock seconds (show TC timeline) → SMPTE parts. */
export function secondsToTimecode(
  sec: number,
  fpsLabel: FrameRateLabel,
): TimecodeParts {
  const info = frameRateInfo(fpsLabel);
  const s = Math.max(0, sec);
  const totalFrames = Math.round(s * info.fps);
  if (info.dropFrame) {
    return framesToDropFrameParts(totalFrames, info.nominalFps);
  }
  return framesToNdfParts(totalFrames, info.nominalFps);
}

/** Convert SMPTE parts → wall-clock seconds on the show TC timeline. */
export function timecodeToSeconds(
  parts: Pick<TimecodeParts, "hours" | "minutes" | "seconds" | "frames">,
  fpsLabel: FrameRateLabel,
): number {
  const info = frameRateInfo(fpsLabel);
  const totalFrames = info.dropFrame
    ? dropFramePartsToFrames(parts, info.nominalFps)
    : ndfPartsToFrames(parts, info.nominalFps);
  return totalFrames / info.fps;
}

function framesToNdfParts(totalFrames: number, nominalFps: number): TimecodeParts {
  const fr = Math.max(1, Math.round(nominalFps));
  const f = Math.max(0, Math.floor(totalFrames));
  const frames = f % fr;
  const totalSecs = Math.floor(f / fr);
  const seconds = totalSecs % 60;
  const totalMins = Math.floor(totalSecs / 60);
  const minutes = totalMins % 60;
  const hours = Math.floor(totalMins / 60) % 100;
  return { hours, minutes, seconds, frames, dropFrame: false };
}

function ndfPartsToFrames(
  parts: Pick<TimecodeParts, "hours" | "minutes" | "seconds" | "frames">,
  nominalFps: number,
): number {
  const fr = Math.max(1, Math.round(nominalFps));
  const frames = Math.min(Math.max(0, Math.floor(parts.frames)), fr - 1);
  const seconds = Math.min(Math.max(0, Math.floor(parts.seconds)), 59);
  const minutes = Math.min(Math.max(0, Math.floor(parts.minutes)), 59);
  const hours = Math.max(0, Math.floor(parts.hours));
  return ((hours * 60 + minutes) * 60 + seconds) * fr + frames;
}

/** SMPTE drop-frame: skip frame 00 and 01 at the start of each minute except :00, :10, :20, :30, :40, :50. */
function framesToDropFrameParts(
  totalFrames: number,
  nominalFps: number,
): TimecodeParts {
  const fr = Math.max(1, Math.round(nominalFps));
  const dropFrames = Math.round(fr * 0.066666); // 2 @ 30
  const framesPer10Minutes = fr * 60 * 10 - 9 * dropFrames; // 17982 @ 30
  const framesPerMinute = fr * 60 - dropFrames; // 1798 @ 30

  const fRaw = Math.max(0, Math.floor(totalFrames));
  const d = Math.floor(fRaw / framesPer10Minutes);
  const m = fRaw % framesPer10Minutes;

  let f = fRaw + 9 * dropFrames * d;
  if (m >= dropFrames) {
    f += dropFrames * Math.floor((m - dropFrames) / framesPerMinute);
  }

  return { ...framesToNdfParts(f, fr), dropFrame: true };
}

function dropFramePartsToFrames(
  parts: Pick<TimecodeParts, "hours" | "minutes" | "seconds" | "frames">,
  nominalFps: number,
): number {
  const fr = Math.max(1, Math.round(nominalFps));
  const dropFrames = Math.round(fr * 0.066666);
  const framesPer10Minutes = fr * 60 * 10 - 9 * dropFrames;
  const framesPerMinute = fr * 60 - dropFrames;
  const hours = Math.max(0, Math.floor(parts.hours));
  const minutes = Math.min(Math.max(0, Math.floor(parts.minutes)), 59);
  const seconds = Math.min(Math.max(0, Math.floor(parts.seconds)), 59);
  let frames = Math.min(Math.max(0, Math.floor(parts.frames)), fr - 1);

  // Illegal DF addresses (dropped frames) → clamp up to first valid frame
  if (minutes % 10 !== 0 && seconds === 0 && frames < dropFrames) {
    frames = dropFrames;
  }

  const totalMinutes = 60 * hours + minutes;
  return (
    framesPer10Minutes * Math.floor(totalMinutes / 10) +
    framesPerMinute * (totalMinutes % 10) +
    fr * seconds +
    frames
  );
}

export function formatTimecodeParts(parts: TimecodeParts): string {
  const sep = parts.dropFrame ? ";" : ":";
  return (
    `${String(parts.hours).padStart(2, "0")}:` +
    `${String(parts.minutes).padStart(2, "0")}:` +
    `${String(parts.seconds).padStart(2, "0")}` +
    sep +
    `${String(parts.frames).padStart(2, "0")}`
  );
}

/** Format show-timeline seconds as HH:MM:SS:FF (or ;FF for DF). */
export function formatTimecode(sec: number, fpsLabel: FrameRateLabel): string {
  return formatTimecodeParts(secondsToTimecode(sec, fpsLabel));
}

/**
 * Parse HH:MM:SS:FF / HH:MM:SS;FF (and HH:MM:SS.FF) to show-timeline seconds.
 * Accepts `;` or `:` before frames; DF vs NDF follows the project fps label.
 */
export function parseTimecode(
  input: string,
  fpsLabel: FrameRateLabel,
): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const m = trimmed.match(
    /^(\d{1,2}):(\d{1,2}):(\d{1,2})[:;.](\d{1,2})$/,
  );
  if (!m) return null;
  const hours = Number.parseInt(m[1]!, 10);
  const minutes = Number.parseInt(m[2]!, 10);
  const seconds = Number.parseInt(m[3]!, 10);
  const frames = Number.parseInt(m[4]!, 10);
  const info = frameRateInfo(fpsLabel);
  if (minutes >= 60 || seconds >= 60 || frames >= info.nominalFps) return null;
  return timecodeToSeconds({ hours, minutes, seconds, frames }, fpsLabel);
}

/** File-relative absolute → show TC string (applies project offset). */
export function formatShowTimecode(
  tAbs: number,
  settings: Pick<ProjectSettings, "fps" | "showTcOffsetSec">,
): string {
  return formatTimecode(tAbs + (settings.showTcOffsetSec || 0), settings.fps);
}

/** Show TC string → file-relative absolute (subtracts project offset). */
export function parseShowTimecode(
  input: string,
  settings: Pick<ProjectSettings, "fps" | "showTcOffsetSec">,
): number | null {
  const showSec = parseTimecode(input, settings.fps);
  if (showSec == null) return null;
  return Math.max(0, showSec - (settings.showTcOffsetSec || 0));
}

/** Convert musical bar.beat(.sub) → absolute seconds. */
export function musicalToAbsolute(
  bar: number,
  beat: number,
  sub: number,
  settings: Pick<
    ProjectSettings,
    "bpm" | "timeSignature" | "downbeatOffsetSec"
  >,
): number {
  const beatSec = beatDurationSec(settings.bpm, settings.timeSignature);
  const [beatsPerBar] = settings.timeSignature;
  const safeBpb = beatsPerBar > 0 ? beatsPerBar : 4;
  const safeBar = Math.max(1, Math.floor(bar));
  const safeBeat = Math.min(safeBpb, Math.max(1, Math.floor(beat)));
  const safeSub = Math.min(3, Math.max(0, Math.floor(sub)));
  const totalBeats =
    (safeBar - 1) * safeBpb + (safeBeat - 1) + safeSub / 4;
  return Math.max(0, (settings.downbeatOffsetSec || 0) + totalBeats * beatSec);
}

/** Parse "bar.beat" or "bar.beat.sub" → absolute seconds. */
export function parseMusicalPosition(
  input: string,
  settings: Pick<
    ProjectSettings,
    "bpm" | "timeSignature" | "downbeatOffsetSec"
  >,
): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const bar = Number.parseInt(m[1]!, 10);
  const beat = Number.parseInt(m[2]!, 10);
  const sub = m[3] ? Number.parseInt(m[3]!, 10) : 0;
  if (bar < 1 || beat < 1 || sub < 0) return null;
  return musicalToAbsolute(bar, beat, sub, settings);
}

export function timeDisplayModeLabel(mode: TimeDisplayMode): string {
  switch (mode) {
    case "absolute":
      return "Absolute";
    case "timecode":
      return "Show TC";
    case "musical":
      return "Musical";
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

/** Format file-relative absolute time in the active display mode. */
export function formatTime(
  tAbs: number,
  mode: TimeDisplayMode,
  settings: Pick<
    ProjectSettings,
    | "bpm"
    | "timeSignature"
    | "downbeatOffsetSec"
    | "fps"
    | "showTcOffsetSec"
  >,
): string {
  switch (mode) {
    case "absolute":
      return formatAbsoluteTime(tAbs);
    case "timecode":
      return formatShowTimecode(tAbs, settings);
    case "musical":
      return formatMusicalPosition(tAbs, settings);
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

/** Parse a display-mode string back to file-relative absolute seconds. */
export function parseTime(
  input: string,
  mode: TimeDisplayMode,
  settings: Pick<
    ProjectSettings,
    | "bpm"
    | "timeSignature"
    | "downbeatOffsetSec"
    | "fps"
    | "showTcOffsetSec"
  >,
): number | null {
  switch (mode) {
    case "absolute":
      return parseAbsoluteTime(input);
    case "timecode":
      return parseShowTimecode(input, settings);
    case "musical":
      return parseMusicalPosition(input, settings);
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

/** Placeholder / input hint for the active mode. */
export function timeInputPlaceholder(mode: TimeDisplayMode): string {
  switch (mode) {
    case "absolute":
      return "mm:ss.mmm";
    case "timecode":
      return "HH:MM:SS:FF";
    case "musical":
      return "bar.beat";
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

/** Inspector field label for the active mode. */
export function timeFieldLabel(mode: TimeDisplayMode): string {
  switch (mode) {
    case "absolute":
      return "Time";
    case "timecode":
      return "Show TC";
    case "musical":
      return "Position";
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}
