import type { Project } from "../types.js";
import {
  csvRow,
  resolveExportCues,
  sanitizeFilename,
  tabRow,
} from "./helpers.js";
import type { ExportFile, ExportOptions } from "./types.js";

const COLUMNS = [
  "ordinal",
  "department",
  "cueNo",
  "label",
  "tAbs_sec",
  "absolute",
  "showTc",
  "musical",
  "fadeSec",
  "note",
  "bpm",
  "fps",
  "tcOffsetSec",
] as const;

function buildRows(project: Project, options: ExportOptions): string[][] {
  const rows = resolveExportCues(project, options.departmentIds);
  return rows.map((r) => [
    String(r.cue.ordinalGlobal),
    r.department?.name ?? "",
    r.cue.cueNoDept,
    r.cue.label,
    String(r.cue.tAbs),
    r.absolute,
    r.showTc,
    r.musical,
    r.cue.fadeSec != null ? String(r.cue.fadeSec) : "",
    r.cue.note ?? "",
    String(project.settings.bpm),
    project.settings.fps,
    String(project.settings.showTcOffsetSec || 0),
  ]);
}

export function exportGenericCsv(
  project: Project,
  options: ExportOptions = {},
): ExportFile[] {
  const data = buildRows(project, options);
  const lines = [csvRow([...COLUMNS]), ...data.map((r) => csvRow(r))];
  return [
    {
      filename: `${sanitizeFilename(project.name)}_cues.csv`,
      mimeType: "text/csv;charset=utf-8",
      content: `${lines.join("\n")}\n`,
      formatId: "generic-csv",
      label: "Generic CSV",
    },
  ];
}

export function exportGenericTab(
  project: Project,
  options: ExportOptions = {},
): ExportFile[] {
  const data = buildRows(project, options);
  const lines = [tabRow([...COLUMNS]), ...data.map((r) => tabRow(r))];
  return [
    {
      filename: `${sanitizeFilename(project.name)}_cues.tsv`,
      mimeType: "text/tab-separated-values;charset=utf-8",
      content: `${lines.join("\n")}\n`,
      formatId: "generic-tab",
      label: "Generic TAB",
    },
  ];
}
