import { deserializeProject, PersistError, serializeProject } from "./persist.js";
import { touchProject } from "./project.js";
import type { MediaRef, Project, ProjectFile } from "./types.js";

/** Portable team-share archive extension (Drive / Dropbox / USB). */
export const SHARE_PACKAGE_EXTENSION = ".cueproj.zip";

/** Canonical project JSON path inside a share package. */
export const SHARE_PROJECT_PATH = "project.json";

/** Media folder prefix inside a share package. */
export const SHARE_MEDIA_DIR = "media/";

/** Human-readable handoff notes inside every share package. */
export const SHARE_README_PATH = "README.txt";

export interface SharePackageEntry {
  filename: string;
  content: string | Uint8Array;
}

export interface SharePackageMedia {
  /** Relative path inside the package, e.g. media/track.wav */
  relativePath: string;
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface BuiltSharePackage {
  /** Suggested download filename, e.g. My_Show.cueproj.zip */
  filename: string;
  entries: SharePackageEntry[];
  /** True when media bytes were packed under media/ */
  includedMedia: boolean;
}

export interface ParsedSharePackage {
  project: Project;
  mediaDataUrl?: string;
  /** Binary media extracted from the package media/ folder when present */
  media?: SharePackageMedia;
  /** Paths found in the archive (for diagnostics) */
  entryNames: string[];
}

/** Sanitize a user-facing name for use as a download / zip entry basename. */
export function sanitizeShareBasename(name: string, fallback = "show"): string {
  const cleaned = name.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || fallback;
}

function mediaExtension(name: string, mimeType?: string): string {
  const fromName = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  if (fromName && /^\.[\w.+-]+$/i.test(fromName) && fromName.length <= 12) {
    return fromName.toLowerCase();
  }
  switch (mimeType) {
    case "audio/wav":
    case "audio/wave":
    case "audio/x-wav":
      return ".wav";
    case "audio/aiff":
    case "audio/x-aiff":
      return ".aiff";
    case "audio/mpeg":
    case "audio/mp3":
      return ".mp3";
    case "audio/mp4":
    case "audio/m4a":
    case "audio/x-m4a":
      return ".m4a";
    case "audio/ogg":
      return ".ogg";
    default:
      return ".bin";
  }
}

function mediaEntryName(media: MediaRef): string {
  const base = sanitizeShareBasename(
    media.name.replace(/\.[^.]+$/, "") || "track",
    "track",
  );
  return `${SHARE_MEDIA_DIR}${base}${mediaExtension(media.name, media.mimeType)}`;
}

/** Conflict / handoff guidance written into every share package. */
export function sharePackageReadme(project: Project, includedMedia: boolean): string {
  const mediaLine = includedMedia
    ? `- Media is under ${SHARE_MEDIA_DIR} and referenced by project.media.relativePath.`
    : `- This package has NO media bytes. The recipient must use Import audio for “${project.media?.name ?? "the show track"}”.`;

  return `CueDesigner shared show package
================================

Show: ${project.name}
Project id: ${project.id}
Cues: ${project.cues.length}
Shared: ${new Date().toISOString()}

How to open
-----------
1. In CueDesigner (web or Electron), click **Open shared**.
2. Choose this .cueproj.zip file (USB, NAS, Drive, or Dropbox download).
3. Cues, departments, and settings restore offline — no account or network required.
4. If media is missing, the app prompts you to Import audio.

Contents
--------
- ${SHARE_PROJECT_PATH} — full show (same schema as .cueproj.json)
${mediaLine}
- ${SHARE_README_PATH} — this file

Team handoff (MVP file sharing)
-------------------------------
CueDesigner MVP sharing is **file-based**, not realtime multiplayer.

- Prefer one **show master** who owns the latest package.
- Hand off via USB / NAS / Drive / Dropbox: Share → send zip → teammate Open shared.
- Do **not** edit the same Dropbox/Drive copy from two machines at once.
  Last writer wins and silent overwrites are easy; instead Share a new package after your pass.
- Keep department exports (MagicQ / grandMA / SFX) separate from the master show package.
- Local **Save** (.cueproj.json) remains for single-operator work; **Share** is for portable handoff with media.

Offline
-------
No internet is required after install. Never upload show files to CueDesigner servers —
everything stays on the machines you copy between.
`;
}

/**
 * Build zip entries for a portable team-share package.
 * Always packs project.json + README; packs media/ when bytes are provided.
 */
export function buildSharePackage(options: {
  project: Project;
  mediaBytes?: Uint8Array | null;
  mediaName?: string;
  mediaMimeType?: string;
}): BuiltSharePackage {
  const touched = touchProject(options.project);
  let project = touched;
  const entries: SharePackageEntry[] = [];
  let includedMedia = false;

  if (options.mediaBytes && options.mediaBytes.byteLength > 0) {
    const mediaMeta: MediaRef = {
      id: project.media?.id ?? "media",
      name: options.mediaName || project.media?.name || "track",
      mimeType: options.mediaMimeType || project.media?.mimeType,
      durationSec: project.media?.durationSec ?? 0,
      hash: project.media?.hash,
    };
    const relativePath = mediaEntryName(mediaMeta);
    project = {
      ...project,
      media: {
        ...mediaMeta,
        relativePath,
      },
    };
    entries.push({ filename: relativePath, content: options.mediaBytes });
    includedMedia = true;
  } else if (project.media) {
    // Clear stale relativePath so recipients don't look for missing files.
    const { relativePath: _drop, ...rest } = project.media;
    void _drop;
    project = { ...project, media: { ...rest } };
  }

  // project.json uses the same ProjectFile shape as .cueproj.json (no mediaDataUrl —
  // binary lives under media/ for teammate handoff).
  entries.unshift({
    filename: SHARE_PROJECT_PATH,
    content: serializeProject(project),
  });
  entries.push({
    filename: SHARE_README_PATH,
    content: sharePackageReadme(project, includedMedia),
  });

  const filename = `${sanitizeShareBasename(project.name)}${SHARE_PACKAGE_EXTENSION}`;
  return { filename, entries, includedMedia };
}

function normalizeZipPath(name: string): string {
  return name.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function findProjectJson(
  files: Map<string, Uint8Array>,
): { path: string; text: string } {
  const preferred = [
    SHARE_PROJECT_PATH,
    "show.cueproj.json",
    "project.cueproj.json",
  ];
  for (const p of preferred) {
    const bytes = files.get(p);
    if (bytes) {
      return { path: p, text: new TextDecoder().decode(bytes) };
    }
  }
  // Any *.cueproj.json at archive root
  for (const [path, bytes] of files) {
    if (!path.includes("/") && path.endsWith(".cueproj.json")) {
      return { path, text: new TextDecoder().decode(bytes) };
    }
  }
  // Bare .json at root that looks like a project
  for (const [path, bytes] of files) {
    if (!path.includes("/") && path.endsWith(".json") && path !== SHARE_README_PATH) {
      const text = new TextDecoder().decode(bytes);
      try {
        deserializeProject(text);
        return { path, text };
      } catch {
        // try next
      }
    }
  }
  throw new PersistError(
    `Share package missing ${SHARE_PROJECT_PATH} (or a .cueproj.json)`,
  );
}

function pickMediaBytes(
  project: Project,
  files: Map<string, Uint8Array>,
): SharePackageMedia | undefined {
  const candidates: string[] = [];
  if (project.media?.relativePath) {
    candidates.push(normalizeZipPath(project.media.relativePath));
  }
  // Any file under media/
  for (const path of files.keys()) {
    if (path.startsWith(SHARE_MEDIA_DIR) && !path.endsWith("/")) {
      candidates.push(path);
    }
  }
  for (const path of candidates) {
    const bytes = files.get(path);
    if (!bytes || bytes.byteLength === 0) continue;
    const name =
      project.media?.name ||
      path.slice(path.lastIndexOf("/") + 1) ||
      "track";
    return {
      relativePath: path,
      name,
      mimeType: project.media?.mimeType || "application/octet-stream",
      bytes,
    };
  }
  return undefined;
}

/**
 * Parse a share package from already-extracted zip entries.
 * Accepts Map or list of {filename, content}.
 */
export function parseSharePackage(
  entries:
    | ReadonlyMap<string, Uint8Array>
    | readonly { filename: string; content: Uint8Array }[],
): ParsedSharePackage {
  const files = new Map<string, Uint8Array>();
  if (entries instanceof Map) {
    for (const [k, v] of entries) {
      files.set(normalizeZipPath(k), v);
    }
  } else {
    for (const e of entries as readonly { filename: string; content: Uint8Array }[]) {
      files.set(normalizeZipPath(e.filename), e.content);
    }
  }
  if (files.size === 0) {
    throw new PersistError("Share package is empty");
  }

  const { text } = findProjectJson(files);
  const file: ProjectFile = deserializeProject(text);
  const media = pickMediaBytes(file.project, files);

  return {
    project: file.project,
    mediaDataUrl: file.mediaDataUrl,
    media,
    entryNames: [...files.keys()],
  };
}

/** True when a filename looks like a CueDesigner share archive. */
export function isSharePackageFilename(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith(".cueproj.zip") ||
    lower.endsWith(".cuedesigner.zip") ||
    (lower.endsWith(".zip") && lower.includes("cue"))
  );
}
