import type { GridResolution, ProjectSettings } from "./types.js";

/** Quarter-note duration in seconds from BPM (standard metronome BPM). */
export function quarterNoteSec(bpm: number): number {
  const safe = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  return 60 / safe;
}

/** Duration of one notated beat for the time signature (denominator note). */
export function beatDurationSec(
  bpm: number,
  timeSignature: [number, number],
): number {
  const [, den] = timeSignature;
  const safeDen = den > 0 ? den : 4;
  return quarterNoteSec(bpm) * (4 / safeDen);
}

/** Duration of one bar. */
export function barDurationSec(
  bpm: number,
  timeSignature: [number, number],
): number {
  const [num] = timeSignature;
  const safeNum = num > 0 ? num : 4;
  return beatDurationSec(bpm, timeSignature) * safeNum;
}

/** Grid step size in seconds for the chosen resolution. */
export function gridStepSec(
  settings: Pick<ProjectSettings, "bpm" | "timeSignature" | "gridResolution">,
): number {
  const { bpm, timeSignature, gridResolution } = settings;
  const q = quarterNoteSec(bpm);
  switch (gridResolution) {
    case "bar":
      return barDurationSec(bpm, timeSignature);
    case "beat":
      return beatDurationSec(bpm, timeSignature);
    case "1/4":
      return q;
    case "1/8":
      return q / 2;
    case "1/16":
      return q / 4;
    case "1/32":
      return q / 8;
    default:
      return beatDurationSec(bpm, timeSignature);
  }
}

/**
 * Snap absolute time to the nearest grid line.
 * Grid origin is `downbeatOffsetSec` (file-relative).
 */
export function snapToGrid(
  tAbs: number,
  settings: Pick<
    ProjectSettings,
    "bpm" | "timeSignature" | "downbeatOffsetSec" | "gridResolution"
  >,
  opts?: { enabled?: boolean },
): number {
  if (opts?.enabled === false) return Math.max(0, tAbs);
  const step = gridStepSec(settings);
  if (!(step > 0) || !Number.isFinite(step)) return Math.max(0, tAbs);
  const origin = settings.downbeatOffsetSec || 0;
  const relative = tAbs - origin;
  const snapped = Math.round(relative / step) * step + origin;
  return Math.max(0, snapped);
}

export interface MusicalPosition {
  bar: number;
  beat: number;
  /** Subdivision within the beat (0-based), at 1/16 resolution for display. */
  sub: number;
}

/** Convert absolute seconds → 1-based bar / 1-based beat / 0-based 16th subdivision. */
export function absoluteToMusical(
  tAbs: number,
  settings: Pick<
    ProjectSettings,
    "bpm" | "timeSignature" | "downbeatOffsetSec"
  >,
): MusicalPosition {
  const beatSec = beatDurationSec(settings.bpm, settings.timeSignature);
  const [beatsPerBar] = settings.timeSignature;
  const safeBpb = beatsPerBar > 0 ? beatsPerBar : 4;
  const relative = Math.max(0, tAbs - (settings.downbeatOffsetSec || 0));
  const totalBeats = relative / beatSec;
  const barIndex = Math.floor(totalBeats / safeBpb);
  const beatInBar = totalBeats - barIndex * safeBpb;
  const beat = Math.floor(beatInBar);
  const frac = beatInBar - beat;
  const sub = Math.min(3, Math.floor(frac * 4));
  return {
    bar: barIndex + 1,
    beat: beat + 1,
    sub,
  };
}

/** Format as "bar.beat" (e.g. 3.2) or "bar.beat.sub" when sub > 0. */
export function formatMusicalPosition(
  tAbs: number,
  settings: Pick<
    ProjectSettings,
    "bpm" | "timeSignature" | "downbeatOffsetSec"
  >,
): string {
  const { bar, beat, sub } = absoluteToMusical(tAbs, settings);
  if (sub > 0) return `${bar}.${beat}.${sub}`;
  return `${bar}.${beat}`;
}

export const GRID_RESOLUTIONS: readonly GridResolution[] = [
  "bar",
  "beat",
  "1/4",
  "1/8",
  "1/16",
  "1/32",
] as const;

export function gridResolutionLabel(res: GridResolution): string {
  switch (res) {
    case "bar":
      return "Bar";
    case "beat":
      return "Beat";
    case "1/4":
      return "1/4";
    case "1/8":
      return "1/8";
    case "1/16":
      return "1/16";
    case "1/32":
      return "1/32";
    default:
      return String(res);
  }
}

/** Nice absolute-time intervals (seconds) for ruler marks. */
const RULER_INTERVALS_SEC = [
  0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600,
] as const;

/**
 * Absolute-time ruler mark times, denser when the timeline is wider (zoomed).
 * Targets ~`targetPx` pixels between marks given `contentWidthPx`.
 */
export function rulerMarkTimes(
  durationSec: number,
  contentWidthPx: number,
  targetPx = 80,
): number[] {
  if (!(durationSec > 0) || !(contentWidthPx > 0)) return [];
  const idealSec = (targetPx / contentWidthPx) * durationSec;
  let interval = RULER_INTERVALS_SEC[RULER_INTERVALS_SEC.length - 1]!;
  for (const candidate of RULER_INTERVALS_SEC) {
    if (candidate >= idealSec) {
      interval = candidate;
      break;
    }
  }
  const marks: number[] = [];
  const end = Math.ceil(durationSec / interval);
  for (let i = 0; i <= end; i++) {
    const t = i * interval;
    if (t > durationSec + 1e-9) break;
    marks.push(Math.min(durationSec, t));
  }
  if (marks.length === 0 || marks[marks.length - 1]! < durationSec - 1e-6) {
    marks.push(durationSec);
  }
  return marks;
}

/**
 * Visible grid line times from start..end (inclusive of lines in range).
 * Caps count so dense resolutions stay drawable.
 */
export function gridLineTimes(
  settings: Pick<
    ProjectSettings,
    "bpm" | "timeSignature" | "downbeatOffsetSec" | "gridResolution"
  >,
  durationSec: number,
  maxLines = 500,
): { t: number; kind: "bar" | "beat" | "sub" }[] {
  if (!(durationSec > 0)) return [];
  const step = gridStepSec(settings);
  if (!(step > 0)) return [];
  const origin = settings.downbeatOffsetSec || 0;
  const barSec = barDurationSec(settings.bpm, settings.timeSignature);
  const beatSec = beatDurationSec(settings.bpm, settings.timeSignature);

  const startIdx = Math.ceil((0 - origin) / step - 1e-9);
  const endIdx = Math.floor((durationSec - origin) / step + 1e-9);
  const lines: { t: number; kind: "bar" | "beat" | "sub" }[] = [];

  // If too dense, thin to every Nth line while keeping bar accents when possible
  const total = endIdx - startIdx + 1;
  const stride = total > maxLines ? Math.ceil(total / maxLines) : 1;

  for (let i = startIdx; i <= endIdx; i += stride) {
    const t = origin + i * step;
    if (t < -1e-9 || t > durationSec + 1e-9) continue;
    const rel = t - origin;
    const nearBar =
      barSec > 0 && Math.abs(rel / barSec - Math.round(rel / barSec)) < 1e-6;
    const nearBeat =
      beatSec > 0 && Math.abs(rel / beatSec - Math.round(rel / beatSec)) < 1e-6;
    lines.push({
      t: Math.max(0, Math.min(durationSec, t)),
      kind: nearBar ? "bar" : nearBeat ? "beat" : "sub",
    });
  }
  return lines;
}
