/** Schema version for project migrations. */
export const PROJECT_SCHEMA_VERSION = 1 as const;

export type FrameRate =
  | 23.976
  | 24
  | 25
  | 29.97
  | 30;

export type FrameRateLabel =
  | "23.976"
  | "24"
  | "25"
  | "29.97 DF"
  | "29.97 NDF"
  | "30";

export interface MediaRef {
  /** Local blob/object URL or file path / relative media path */
  id: string;
  name: string;
  /** MIME type when known */
  mimeType?: string;
  /** Duration in seconds (file-relative) */
  durationSec: number;
  /** Optional relative path inside a .cueproj package */
  relativePath?: string;
  /** Content hash for integrity when media is external */
  hash?: string;
}

export interface Department {
  id: string;
  name: string;
  /** CSS color */
  color: string;
  /** Optional keyboard shortcut character */
  shortcut?: string;
  /** Soft-deleted departments keep cues but hide from UI */
  archived?: boolean;
}

export interface Cue {
  id: string;
  /** Canonical absolute time in seconds (file-relative) */
  tAbs: number;
  departmentId: string;
  /** Per-department cue number (decimals allowed), e.g. "5.1" */
  cueNoDept: string;
  /** Global show-order ordinal (1-based) */
  ordinalGlobal: number;
  label: string;
  note?: string;
  /** Fade duration in seconds */
  fadeSec?: number;
  /** Extensible fields for export adapters */
  fields?: Record<string, string | number | boolean>;
}

/** Magnetic grid resolution for cue snap / overlay. */
export type GridResolution =
  | "bar"
  | "beat"
  | "1/4"
  | "1/8"
  | "1/16"
  | "1/32";

export interface ProjectSettings {
  bpm: number;
  timeSignature: [number, number];
  /** Downbeat offset in seconds from file start */
  downbeatOffsetSec: number;
  /** Subdivision for magnetic snap and visible grid */
  gridResolution: GridResolution;
  /** When true, place/move snaps to grid (modifier key still bypasses) */
  snapEnabled: boolean;
  fps: FrameRateLabel;
  /** Show timecode offset from file-relative zero */
  showTcOffsetSec: number;
}

export interface Project {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  settings: ProjectSettings;
  departments: Department[];
  cues: Cue[];
  media: MediaRef | null;
}

export interface ProjectFile {
  project: Project;
  /** Optional base64 or omitted when media is external / browser File */
  mediaDataUrl?: string;
}
