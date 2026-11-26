import type { Project } from "../types.js";
import {
  cueFieldNumber,
  cueFieldString,
  resolveExportCues,
  sanitizeFilename,
  tabRow,
} from "./helpers.js";
import type { ExportFile, ExportOptions } from "./types.js";
import { PYRO_SAFETY_COPY } from "./types.js";

/**
 * Format HH:MM:SS.mmm for Finale CSV Event Time / Effect Time.
 */
function formatEventTime(sec: number): string {
  const s = Math.max(0, sec);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const whole = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return (
    `${String(hours).padStart(2, "0")}:` +
    `${String(minutes).padStart(2, "0")}:` +
    `${String(whole).padStart(2, "0")}.` +
    `${String(ms).padStart(3, "0")}`
  );
}

/**
 * Finale-compatible CSV firing script (tab-delimited UTF-8).
 *
 * FireControl G3 / SFX Controllers ingest Finale 3D scripts; this export is the
 * planning interchange (event time, prefire, module/pin, label) — not a native
 * G3 project. Prefire / rail / pin come from cue.fields when present:
 *   fields.prefireSec | fields.module | fields.rail | fields.pin
 *
 * Otherwise module/pin auto-increment as planning placeholders.
 */
export function exportSfxFinale(
  project: Project,
  options: ExportOptions = {},
): ExportFile[] {
  const rows = resolveExportCues(project, options.departmentIds);
  const base = sanitizeFilename(project.name);
  const headerLines = [
    `CueDesigner SFX export`,
    `Show: ${project.name}`,
    `Generated: ${new Date().toISOString()}`,
    PYRO_SAFETY_COPY,
    `Format: Finale CSV firing system (tab-delimited); validate on FireControl G3`,
  ];

  const colHeader = tabRow([
    "Cue",
    "Event Time",
    "Prefire",
    "Effect Time",
    "Duration",
    "Device Count",
    "Description",
    "Size",
    "Category",
    "Type",
    "Position",
    "Module Type",
    "Rail Address",
    "Pin Address",
    "Angle",
    "Hazard",
    "Notes",
    "Part Number",
    "Track",
  ]);

  let autoModule = 1;
  let autoPin = 1;
  const body: string[] = [];

  rows.forEach((r, i) => {
    const cueIndex = i + 1;
    const prefire = cueFieldNumber(r.cue, "prefireSec", 0);
    const effectAbs = r.cue.tAbs;
    // Event time = effect − prefire (ignition precedes visual).
    const eventAbs = Math.max(0, effectAbs - prefire);
    const duration =
      r.cue.fadeSec != null && Number.isFinite(r.cue.fadeSec)
        ? Math.max(0, r.cue.fadeSec)
        : 0;
    const description =
      r.cue.label?.trim() ||
      `${r.department?.name ?? "SFX"} ${r.cue.cueNoDept}`;
    const category = r.department?.name ?? "Pyro/SFX";
    const rail =
      cueFieldString(r.cue, "rail") ||
      cueFieldString(r.cue, "module") ||
      String(autoModule).padStart(2, "0");
    const pin =
      cueFieldString(r.cue, "pin") || String(autoPin);
    if (!cueFieldString(r.cue, "rail") && !cueFieldString(r.cue, "module")) {
      autoPin += 1;
      if (autoPin > 16) {
        autoPin = 1;
        autoModule += 1;
      }
    }
    const notes = [r.cue.note?.trim(), `deptCue=${r.cue.cueNoDept}`, `ordinal=${r.cue.ordinalGlobal}`]
      .filter(Boolean)
      .join("; ");

    body.push(
      tabRow([
        cueIndex,
        formatEventTime(eventAbs),
        prefire.toFixed(2),
        formatEventTime(effectAbs),
        duration.toFixed(2),
        1,
        description,
        "NA",
        category,
        "sfx",
        cueFieldString(r.cue, "position", "Pos-01"),
        cueFieldString(r.cue, "moduleType", "csv_16ch"),
        rail,
        pin,
        "|",
        cueFieldString(r.cue, "hazard", ""),
        notes,
        cueFieldString(r.cue, "partNumber", ""),
        cueFieldString(r.cue, "track", ""),
      ]),
    );
  });

  // Finale uses CRLF; UTF-8 without BOM is fine for G3/Finale interchange.
  const content = [...headerLines, colHeader, ...body].join("\r\n") + "\r\n";

  return [
    {
      filename: `${base}_SFX_Finale.csv`,
      mimeType: "text/csv;charset=utf-8",
      content,
      formatId: "sfx-finale",
      label: "SFX / Finale CSV",
    },
  ];
}
