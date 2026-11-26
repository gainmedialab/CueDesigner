import type { Cue, Department, Project } from "../types.js";
import {
  formatAbsoluteTime,
  formatShowTimecode,
  formatTimecodeParts,
  secondsToTimecode,
} from "../time.js";
import { formatMusicalPosition } from "../grid.js";

/** Sanitize a project/show name for download filenames. */
export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^\w.-]+/g, "_").replace(/_+/g, "_");
  return cleaned.replace(/^_+|_+$/g, "") || "show";
}

/** Escape a CSV field (RFC-ish; quotes when needed). */
export function csvEscape(value: string | number | boolean | null | undefined): string {
  const s = value == null ? "" : String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Join CSV columns with comma. */
export function csvRow(cols: Array<string | number | boolean | null | undefined>): string {
  return cols.map(csvEscape).join(",");
}

/** Join TAB columns (Finale-style). Strip forbidden control chars. */
export function tabRow(cols: Array<string | number | boolean | null | undefined>): string {
  return cols
    .map((v) => {
      const s = v == null ? "" : String(v);
      return s.replace(/[\t\r\n,;\\"']/g, " ").trim();
    })
    .join("\t");
}

export interface ResolvedCue {
  cue: Cue;
  department: Department | undefined;
  /** Show timecode string at project fps + offset (colon frames; DF uses `;`). */
  showTc: string;
  /** MagicQ / Reaper-style TC: always `H:MM:SS:FF` with colons (no DF `;`). */
  magicqTc: string;
  absolute: string;
  musical: string;
}

/** Filter + sort cues for export; resolve department + time strings. */
export function resolveExportCues(
  project: Project,
  departmentIds?: readonly string[],
): ResolvedCue[] {
  const deptFilter =
    departmentIds && departmentIds.length > 0
      ? new Set(departmentIds)
      : null;
  const deptMap = new Map(project.departments.map((d) => [d.id, d]));
  const cues = project.cues
    .filter((c) => !deptFilter || deptFilter.has(c.departmentId))
    .slice()
    .sort((a, b) => {
      if (a.tAbs !== b.tAbs) return a.tAbs - b.tAbs;
      return a.ordinalGlobal - b.ordinalGlobal;
    });

  return cues.map((cue) => {
    const showSec = cue.tAbs + (project.settings.showTcOffsetSec || 0);
    const parts = secondsToTimecode(showSec, project.settings.fps);
    // MagicQ Import TC Timings expects H:MM:SS:FF with colon separators.
    const magicqTc =
      `${parts.hours}:` +
      `${String(parts.minutes).padStart(2, "0")}:` +
      `${String(parts.seconds).padStart(2, "0")}:` +
      `${String(parts.frames).padStart(2, "0")}`;
    return {
      cue,
      department: deptMap.get(cue.departmentId),
      showTc: formatShowTimecode(cue.tAbs, project.settings),
      magicqTc,
      absolute: formatAbsoluteTime(cue.tAbs),
      musical: formatMusicalPosition(cue.tAbs, project.settings),
    };
  });
}

/** Cue display name for desk exports. */
export function cueExportName(cue: Cue, department?: Department): string {
  const label = cue.label?.trim() || `Cue ${cue.cueNoDept}`;
  if (!department) return label;
  // Prefer label; if generic "Cue", include dept + number.
  if (cue.label?.trim() && cue.label.trim() !== "Cue") return label;
  return `${department.name} ${cue.cueNoDept}`;
}

/** Format show-timeline seconds as colon-only HH:MM:SS:FF (MA macros). */
export function formatColonTimecode(
  tAbs: number,
  settings: Project["settings"],
): string {
  const showSec = tAbs + (settings.showTcOffsetSec || 0);
  const parts = secondsToTimecode(showSec, settings.fps);
  return formatTimecodeParts({ ...parts, dropFrame: false });
}

/** Read optional planning field from cue.fields. */
export function cueField(
  cue: Cue,
  key: string,
): string | number | boolean | undefined {
  return cue.fields?.[key];
}

export function cueFieldNumber(cue: Cue, key: string, fallback = 0): number {
  const v = cue.fields?.[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function cueFieldString(cue: Cue, key: string, fallback = ""): string {
  const v = cue.fields?.[key];
  if (v == null) return fallback;
  return String(v);
}
