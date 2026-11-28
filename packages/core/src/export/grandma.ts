import type { FrameRateLabel, Project } from "../types.js";
import { frameRateInfo } from "../time.js";
import {
  cueExportName,
  deskCueNumber,
  resolveExportCues,
  sanitizeFilename,
} from "./helpers.js";
import { exportMagicQ } from "./magicq.js";
import type { ExportFile, ExportOptions } from "./types.js";

/**
 * grandMA3 export: XML macro that scaffolds DataPool → Sequences → Cues →
 * Timecode tracks with Goto events. No fixture/look data — desk owns looks.
 *
 * Import the `.xml` into the Macros pool and run once.
 * Command syntax follows the public QTracks / GMA3 macro reference.
 */
export function exportGrandMA3(
  project: Project,
  options: ExportOptions = {},
): ExportFile[] {
  const content = buildGrandMA3Macro(project, options);
  const base = sanitizeFilename(project.name);
  return [
    {
      filename: `${base}_grandMA3_macro.xml`,
      mimeType: "application/xml;charset=utf-8",
      content,
      formatId: "grandma3",
      label: "grandMA3 macro + TC",
    },
  ];
}

/**
 * grandMA2 path (best-effort): same Reaper TC CSV MagicQ uses.
 * Many MA2 marker/TC plugin workflows accept this layout; certify on desk later.
 */
export function exportGrandMA2(
  project: Project,
  options: ExportOptions = {},
): ExportFile[] {
  const files = exportMagicQ(project, options);
  const base = sanitizeFilename(project.name);
  return files.map((f, i) => ({
    ...f,
    filename:
      files.length === 1
        ? `${base}_grandMA2_TC.csv`
        : f.filename.replace("_MagicQ_", "_grandMA2_"),
    formatId: "grandma2" as const,
    label:
      files.length === 1
        ? "grandMA2 TC CSV (best-effort)"
        : `grandMA2 TC — ${i + 1}`,
  }));
}

function xmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function frameReadout(fps: FrameRateLabel): string {
  const info = frameRateInfo(fps);
  if (info.dropFrame) return "30 fps"; // DF readout; offset still uses wall seconds
  if (info.nominalFps === 24) return "24 fps";
  if (info.nominalFps === 25) return "25 fps";
  return "30 fps";
}

function buildGrandMA3Macro(project: Project, options: ExportOptions): string {
  const pool = options.dataPoolName?.trim() || "CueDesigner";
  const seqStart = Math.max(1, Math.floor(options.sequencePoolStart ?? 1));
  const tcSlot = Math.max(1, Math.floor(options.timecodePoolSlot ?? 1));
  const rows = resolveExportCues(project, options.departmentIds);

  // Group by department (one sequence per dept that has cues), preserving dept order.
  const deptOrder = project.departments.filter((d) =>
    rows.some((r) => r.cue.departmentId === d.id),
  );
  // Orphan cues (deleted dept) → synthetic bucket
  const orphanRows = rows.filter(
    (r) => !deptOrder.some((d) => d.id === r.cue.departmentId),
  );

  type SeqGroup = {
    name: string;
    seqIndex: number;
    cues: typeof rows;
  };
  const groups: SeqGroup[] = [];
  let seqIndex = seqStart;
  for (const d of deptOrder) {
    const cues = rows.filter((r) => r.cue.departmentId === d.id);
    if (cues.length === 0) continue;
    groups.push({ name: d.name, seqIndex, cues });
    seqIndex += 1;
  }
  if (orphanRows.length) {
    groups.push({ name: "Cues", seqIndex, cues: orphanRows });
  }

  const durationSec = Math.max(
    project.media?.durationSec ?? 0,
    ...rows.map((r) => r.cue.tAbs + (project.settings.showTcOffsetSec || 0)),
    1,
  );
  const offsetSec = project.settings.showTcOffsetSec || 0;
  const showName = project.name.replace(/"/g, "'") || "Show";
  const lines: string[] = [];

  const cmd = (command: string, wait?: number) => {
    if (wait != null) {
      lines.push(
        `    <MacroLine Command="${xmlAttr(command)}" Wait="${wait}"/>`,
      );
    } else {
      lines.push(`    <MacroLine Command="${xmlAttr(command)}"/>`);
    }
  };

  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<GMA3 DataVersion="1.4.0.0">`);
  lines.push(
    `  <Macro Name="${xmlAttr(`CueDesigner ${showName}`)}">`,
  );

  cmd("cd root");
  cmd(`Delete DataPool "${pool}" /NC`);
  cmd(`Store DataPool "${pool}" /NC`, 0.05);

  // Sequences + empty cues
  for (const g of groups) {
    cmd(
      `Label DataPool "${pool}" Sequence ${g.seqIndex} "${g.name.replace(/"/g, "'")}"`,
    );
    g.cues.forEach((r, i) => {
      // Prefer per-department cue numbers (incl. decimals) so the desk stack
      // matches Lighting 5.1 / Pyro 12 rather than a regenerated 1..N index.
      const cueNo = deskCueNumber(r.cue, i + 1);
      const fade = r.cue.fadeSec != null && Number.isFinite(r.cue.fadeSec)
        ? Math.max(0, r.cue.fadeSec)
        : 0;
      const label = cueExportName(r.cue, r.department).replace(/"/g, "'");
      cmd(
        `Store DataPool "${pool}" Sequence ${g.seqIndex} Cue ${cueNo} /Merge`,
      );
      cmd(
        `DataPool "${pool}" Sequence ${g.seqIndex} Cue ${cueNo} CueFade ${fade}`,
      );
      cmd(
        `Label DataPool "${pool}" Sequence ${g.seqIndex} Cue ${cueNo} "${label}"`,
      );
      cmd(
        `Set DataPool "${pool}" Sequence ${g.seqIndex} Cue ${cueNo} Property "Assert" "Assert"`,
      );
    });
  }

  // Timecode show
  cmd(`Store DataPool "${pool}" Timecode ${tcSlot}`);
  cmd(`Label DataPool "${pool}" Timecode ${tcSlot} "${showName.replace(/"/g, "'")}"`);
  cmd(`cd DataPool "${pool}"`);
  cmd(`cd "Timecodes"`);
  cmd(`set ${tcSlot} Property FRAMEREADOUT "${frameReadout(project.settings.fps)}"`);
  cmd(`set ${tcSlot} Property OFFSETTCSLOT "${offsetSec}"`);
  cmd(`set ${tcSlot} Property DURATION "${durationSec.toFixed(3)}"`);
  cmd(`set ${tcSlot} Property PLAYBACKANDRECORD "Manual Events"`);

  cmd(`cd DataPool "${pool}" Timecode ${tcSlot}`);
  cmd("cd 1"); // track group container

  groups.forEach((g, gi) => {
    const track = gi + 1;
    if (track === 1) {
      cmd(`Store 1 "${g.name.replace(/"/g, "'")}"`);
    } else {
      cmd(`Store ${track}`);
      cmd(`Label ${track} "${g.name.replace(/"/g, "'")}"`);
    }
    cmd(`Assign DataPool "${pool}" Sequence ${g.seqIndex} At ${track}`);
    cmd(`cd ${track}`);
    cmd("cd 1");
    cmd(`Store Type "CmdSubTrack" 1`);
    cmd("cd 1");

    g.cues.forEach((r, i) => {
      const event = i + 1;
      const cueNo = deskCueNumber(r.cue, i + 1);
      // Event time is show-timeline seconds (file abs + offset already in wall clock
      // relative to TC zero when OFFSETTCSLOT is set — use file-relative + offset).
      const eventTime = r.cue.tAbs + offsetSec;
      cmd(`Store ${event}`);
      cmd(`Set ${event} "TIME" "${eventTime.toFixed(3)}"`);
      cmd(`Set ${event} "TOKEN" "Goto"`);
      // Timecode {slot}.{trackGroup=1}.{track}.{timeRange=1}.{sub=1}.{event}
      cmd(
        `Assign DataPool "${pool}" Sequence ${g.seqIndex} Cue ${cueNo} At Timecode ${tcSlot}.1.${track}.1.1.${event}`,
      );
    });

    cmd("cd root");
    cmd(`cd DataPool "${pool}" Timecode ${tcSlot}`);
    cmd("cd 1");
  });

  cmd("cd root");
  lines.push(`  </Macro>`);
  lines.push(`</GMA3>`);
  lines.push("");
  return lines.join("\n");
}
