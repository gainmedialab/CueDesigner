import type { Cue } from "./types.js";
import { formatAbsoluteTime } from "./time.js";

/** Session rehearsal loop mode (not persisted in project file). */
export type RehearsalLoopMode = "ab" | "pause";

export const REHEARSAL_LOOP_MODES: readonly RehearsalLoopMode[] = [
  "ab",
  "pause",
] as const;

/** Which departments the next-cue countdown considers. */
export type CountdownDeptScope = "all" | "active" | "placeOn";

export const COUNTDOWN_DEPT_SCOPES: readonly CountdownDeptScope[] = [
  "all",
  "active",
  "placeOn",
] as const;

/** Minimum A–B span so a loop is musically useful and avoids seek thrash. */
export const MIN_LOOP_SPAN_SEC = 0.05;

/**
 * True when A/B form a valid wrap region (strictly A < B by min span).
 * Null points or inverted / zero-length regions are invalid.
 */
export function isValidLoopRegion(
  loopA: number | null,
  loopB: number | null,
  minSpanSec = MIN_LOOP_SPAN_SEC,
): boolean {
  if (loopA == null || loopB == null) return false;
  if (!Number.isFinite(loopA) || !Number.isFinite(loopB)) return false;
  return loopB - loopA >= minSpanSec;
}

/**
 * Clamp A/B into [0, duration] and order them so A ≤ B.
 * Degenerate (equal) regions stay equal — caller checks `isValidLoopRegion`.
 */
export function normalizeLoopPoints(
  a: number,
  b: number,
  durationSec: number,
): { loopA: number; loopB: number } {
  const dur =
    Number.isFinite(durationSec) && durationSec > 0 ? durationSec : Infinity;
  const clamp = (t: number) =>
    Math.min(Math.max(0, Number.isFinite(t) ? t : 0), dur === Infinity ? Math.max(0, t) : dur);
  const ca = clamp(a);
  const cb = clamp(b);
  if (ca <= cb) return { loopA: ca, loopB: cb };
  return { loopA: cb, loopB: ca };
}

/**
 * While playing with loop armed, return the seek target when the playhead
 * reaches or passes Out (B). Otherwise null (no wrap this tick).
 *
 * Uses a small epsilon so we wrap just before HTMLMediaElement `ended` when
 * B is at the media end.
 */
export function loopWrapTarget(
  tAbs: number,
  loopA: number | null,
  loopB: number | null,
  opts?: { enabled?: boolean; epsilonSec?: number },
): number | null {
  if (!opts?.enabled) return null;
  if (!isValidLoopRegion(loopA, loopB)) return null;
  const eps = opts.epsilonSec ?? 0.002;
  if (tAbs + eps >= loopB!) return loopA!;
  return null;
}

/**
 * Build A–B from a play take: play-start → pause position.
 * Returns null when the span is too short (no useful loop).
 */
export function loopRegionFromPause(
  playStartSec: number,
  pauseSec: number,
  durationSec: number,
  minSpanSec = MIN_LOOP_SPAN_SEC,
): { loopA: number; loopB: number } | null {
  const { loopA, loopB } = normalizeLoopPoints(
    playStartSec,
    pauseSec,
    durationSec,
  );
  if (!isValidLoopRegion(loopA, loopB, minSpanSec)) return null;
  return { loopA, loopB };
}

export interface NextCueOptions {
  /** Restrict to these department ids. Empty / omitted = all cues. */
  departmentIds?: readonly string[] | null;
  /**
   * Treat cues within this window of the playhead as already passed
   * (avoids flickering on the cue you just hit).
   */
  epsilonSec?: number;
}

/**
 * Next cue strictly after the playhead (show order), optionally filtered by dept.
 */
export function findNextCue(
  cues: readonly Cue[],
  tAbs: number,
  opts?: NextCueOptions,
): Cue | null {
  const eps = opts?.epsilonSec ?? 0.0005;
  const deptFilter = opts?.departmentIds;
  const allow =
    deptFilter && deptFilter.length > 0
      ? new Set(deptFilter)
      : null;
  let best: Cue | null = null;
  for (const c of cues) {
    if (allow && !allow.has(c.departmentId)) continue;
    if (!(c.tAbs > tAbs + eps)) continue;
    if (
      !best ||
      c.tAbs < best.tAbs ||
      (c.tAbs === best.tAbs && c.ordinalGlobal < best.ordinalGlobal)
    ) {
      best = c;
    }
  }
  return best;
}

/** Seconds until next cue (clamped ≥ 0). Null when there is no next cue. */
export function countdownToCueSec(
  nextCue: Pick<Cue, "tAbs"> | null,
  tAbs: number,
): number | null {
  if (!nextCue) return null;
  return Math.max(0, nextCue.tAbs - tAbs);
}

/**
 * Format a remaining duration as −mm:ss.mmm (absolute-style countdown).
 * Negative zero / tiny remainders still show as −00:00.000.
 */
export function formatCountdownAbs(remainSec: number): string {
  const s = Math.max(0, remainSec);
  return `−${formatAbsoluteTime(s)}`;
}

export function countdownDeptScopeLabel(scope: CountdownDeptScope): string {
  switch (scope) {
    case "all":
      return "All depts";
    case "active":
      return "Active dept";
    case "placeOn":
      return "Place on";
    default: {
      const _exhaustive: never = scope;
      return _exhaustive;
    }
  }
}

export function rehearsalLoopModeLabel(mode: RehearsalLoopMode): string {
  switch (mode) {
    case "ab":
      return "A–B";
    case "pause":
      return "Pause loop";
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}
