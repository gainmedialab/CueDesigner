/** Supported export-only pack identifiers (MVP). */
export type ExportFormatId =
  | "magicq"
  | "grandma3"
  | "grandma2"
  | "sfx-finale"
  | "generic-csv"
  | "generic-tab";

export interface ExportFormatInfo {
  id: ExportFormatId;
  /** Short UI label */
  label: string;
  /** One-line description for the Export dialog */
  description: string;
  /** True when export may include pyro/SFX planning data */
  pyroSafety: boolean;
}

export const EXPORT_FORMATS: readonly ExportFormatInfo[] = [
  {
    id: "magicq",
    label: "MagicQ cuelist CSV",
    description:
      "Reaper-style TC markers for ChamSys MagicQ (Cue Stack → TC View → Import TC Timings).",
    pyroSafety: false,
  },
  {
    id: "grandma3",
    label: "grandMA3 macro + TC",
    description:
      "XML macro that scaffolds sequences, empty cues, and timecode Goto events (looks stay on the desk).",
    pyroSafety: false,
  },
  {
    id: "grandma2",
    label: "grandMA2 TC CSV (best-effort)",
    description:
      "Reaper-style TC CSV for MA2 plugin / marker import workflows. Prefer MA3 macro when available.",
    pyroSafety: false,
  },
  {
    id: "sfx-finale",
    label: "SFX / Finale CSV",
    description:
      "Finale-compatible firing-script CSV (event time, prefire, module/pin, label) for FireControl G3–style import.",
    pyroSafety: true,
  },
  {
    id: "generic-csv",
    label: "Generic CSV",
    description: "Neutral cue list: dept, cue no, times (abs / TC / musical), label, fade, note.",
    pyroSafety: false,
  },
  {
    id: "generic-tab",
    label: "Generic TAB",
    description: "Same columns as Generic CSV, tab-separated.",
    pyroSafety: false,
  },
] as const;

export interface ExportOptions {
  /** Limit to these department ids (omit / empty = all). */
  departmentIds?: string[];
  /** When true and the format supports it, emit one file per department. */
  perDepartment?: boolean;
  /** grandMA3: first sequence pool slot (default 1). */
  sequencePoolStart?: number;
  /** grandMA3: timecode pool slot (default 1). */
  timecodePoolSlot?: number;
  /** grandMA3: DataPool name (default CueDesigner). */
  dataPoolName?: string;
}

export interface ExportFile {
  filename: string;
  mimeType: string;
  content: string;
  formatId: ExportFormatId;
  label: string;
}

export const PYRO_SAFETY_COPY =
  "Planning and export only. This software does not arm, enable, or fire pyrotechnic or SFX hardware.";
