import { PROJECT_SCHEMA_VERSION, type Project, type ProjectFile } from "./types.js";

export class PersistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistError";
  }
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
  return {
    project: projectRaw,
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
