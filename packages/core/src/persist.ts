import { defaultSettings } from "./project.js";
import {
  PROJECT_SCHEMA_VERSION,
  type GridResolution,
  type Project,
  type ProjectFile,
  type ProjectSettings,
} from "./types.js";

export class PersistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistError";
  }
}

const GRID_RESOLUTIONS: ReadonlySet<string> = new Set([
  "bar",
  "beat",
  "1/4",
  "1/8",
  "1/16",
  "1/32",
]);

function normalizeSettings(raw: unknown): ProjectSettings {
  const defaults = defaultSettings();
  if (!raw || typeof raw !== "object") return defaults;
  const s = raw as Record<string, unknown>;
  const bpm =
    typeof s.bpm === "number" && Number.isFinite(s.bpm) && s.bpm > 0
      ? s.bpm
      : defaults.bpm;
  let timeSignature: [number, number] = defaults.timeSignature;
  if (Array.isArray(s.timeSignature) && s.timeSignature.length >= 2) {
    const n = Number(s.timeSignature[0]);
    const d = Number(s.timeSignature[1]);
    if (Number.isFinite(n) && n > 0 && Number.isFinite(d) && d > 0) {
      timeSignature = [n, d];
    }
  }
  const downbeatOffsetSec =
    typeof s.downbeatOffsetSec === "number" &&
    Number.isFinite(s.downbeatOffsetSec)
      ? s.downbeatOffsetSec
      : defaults.downbeatOffsetSec;
  const gridResolution: GridResolution =
    typeof s.gridResolution === "string" &&
    GRID_RESOLUTIONS.has(s.gridResolution)
      ? (s.gridResolution as GridResolution)
      : defaults.gridResolution;
  const snapEnabled =
    typeof s.snapEnabled === "boolean" ? s.snapEnabled : defaults.snapEnabled;
  const fps =
    typeof s.fps === "string" ? (s.fps as ProjectSettings["fps"]) : defaults.fps;
  const showTcOffsetSec =
    typeof s.showTcOffsetSec === "number" && Number.isFinite(s.showTcOffsetSec)
      ? s.showTcOffsetSec
      : defaults.showTcOffsetSec;
  return {
    bpm,
    timeSignature,
    downbeatOffsetSec,
    gridResolution,
    snapEnabled,
    fps,
    showTcOffsetSec,
  };
}

function assertProjectShape(raw: unknown): asserts raw is Project {
  if (!raw || typeof raw !== "object") {
    throw new PersistError("Project root must be an object");
  }
  const p = raw as Record<string, unknown>;
  if (p.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    throw new PersistError(
      `Unsupported schema version: ${String(p.schemaVersion)} (expected ${PROJECT_SCHEMA_VERSION})`,
    );
  }
  if (typeof p.id !== "string" || typeof p.name !== "string") {
    throw new PersistError("Project missing id/name");
  }
  if (!Array.isArray(p.departments) || !Array.isArray(p.cues)) {
    throw new PersistError("Project missing departments/cues arrays");
  }
  if (!p.settings || typeof p.settings !== "object") {
    throw new PersistError("Project missing settings");
  }
}

/** Serialize a project to offline JSON (no network). */
export function serializeProject(
  project: Project,
  mediaDataUrl?: string,
): string {
  const file: ProjectFile = { project };
  if (mediaDataUrl) file.mediaDataUrl = mediaDataUrl;
  return JSON.stringify(file, null, 2);
}

/** Parse a project JSON string written by serializeProject. */
export function deserializeProject(json: string): ProjectFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new PersistError("Invalid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new PersistError("Project file must be an object");
  }
  const root = parsed as Record<string, unknown>;
  // Accept both wrapped { project } and bare Project for flexibility
  const projectRaw = "project" in root ? root.project : root;
  assertProjectShape(projectRaw);
  const normalized: Project = {
    ...projectRaw,
    settings: normalizeSettings(projectRaw.settings),
  };
  return {
    project: normalized,
    mediaDataUrl:
      typeof root.mediaDataUrl === "string" ? root.mediaDataUrl : undefined,
  };
}

/** Browser File System Access / download helper payload. */
export function projectDownloadBlob(
  project: Project,
  mediaDataUrl?: string,
): Blob {
  return new Blob([serializeProject(project, mediaDataUrl)], {
    type: "application/json",
  });
}
