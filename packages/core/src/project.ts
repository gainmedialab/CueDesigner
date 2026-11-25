import { createSeededDepartments } from "./departments.js";
import {
  PROJECT_SCHEMA_VERSION,
  type MediaRef,
  type Project,
  type ProjectSettings,
} from "./types.js";

/** Clamp timeline zoom to a practical range (1 = fit, higher = denser). */
export function clampTimelineZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom < 1) return 1;
  return Math.min(64, zoom);
}

/** Clamp metronome volume to 0..1. */
export function clampMetronomeVolume(volume: number): number {
  if (!Number.isFinite(volume)) return 0.5;
  return Math.max(0, Math.min(1, volume));
}

/** Whole-number BPM only (quarter-notes per minute), clamped to a practical range. */
export function clampBpm(bpm: number): number {
  if (!Number.isFinite(bpm)) return 120;
  return Math.max(20, Math.min(400, Math.round(bpm)));
}

export function defaultSettings(): ProjectSettings {
  return {
    bpm: 120,
    timeSignature: [4, 4],
    downbeatOffsetSec: 0,
    gridResolution: "1/4",
    snapEnabled: true,
    timelineZoom: 1,
    metronomeEnabled: false,
    metronomeVolume: 0.5,
    fps: "25",
    showTcOffsetSec: 0,
  };
}

export function updateSettings(
  project: Project,
  patch: Partial<ProjectSettings>,
): Project {
  const next = { ...project.settings, ...patch };
  if (patch.bpm != null) {
    next.bpm = clampBpm(patch.bpm);
  }
  if (patch.timelineZoom != null) {
    next.timelineZoom = clampTimelineZoom(patch.timelineZoom);
  }
  if (patch.metronomeVolume != null) {
    next.metronomeVolume = clampMetronomeVolume(patch.metronomeVolume);
  }
  if (patch.downbeatOffsetSec != null && Number.isFinite(patch.downbeatOffsetSec)) {
    next.downbeatOffsetSec = Math.max(0, patch.downbeatOffsetSec);
  }
  return touchProject({
    ...project,
    settings: next,
  });
}

export function createId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createProject(name = "Untitled Show"): Project {
  const now = new Date().toISOString();
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: createId(),
    name,
    createdAt: now,
    updatedAt: now,
    settings: defaultSettings(),
    departments: createSeededDepartments(createId),
    cues: [],
    media: null,
  };
}

export function touchProject(project: Project): Project {
  return { ...project, updatedAt: new Date().toISOString() };
}

export function setProjectMedia(
  project: Project,
  media: MediaRef | null,
): Project {
  return touchProject({ ...project, media });
}

export function renameProject(project: Project, name: string): Project {
  return touchProject({ ...project, name: name.trim() || project.name });
}
