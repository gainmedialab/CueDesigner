import type { Project } from "../types.js";
import { csvRow, cueExportName, resolveExportCues, sanitizeFilename } from "./helpers.js";
import type { ExportFile, ExportOptions } from "./types.js";

/**
 * ChamSys MagicQ cuelist CSV (Reaper marker layout).
 *
 * MagicQ Cue Stack → TC View → Import TC Timings recognises a Reaper file by a
 * first line starting with `#`. Times are H:MM:SS:FF at the console frame rate.
 * Use Make Cues after import to append to the current playback stack.
 *
 * Reference: LTCast / CuePoints MagicQ import path.
 */
export function exportMagicQ(
  project: Project,
  options: ExportOptions = {},
): ExportFile[] {
  const base = sanitizeFilename(project.name);
  if (options.perDepartment) {
    const depts = project.departments.filter(
      (d) =>
        !options.departmentIds?.length ||
        options.departmentIds.includes(d.id),
    );
    const files: ExportFile[] = [];
    for (const d of depts) {
      const resolved = resolveExportCues(project, [d.id]);
      if (resolved.length === 0) continue;
      files.push({
        filename: `${base}_MagicQ_${sanitizeFilename(d.name)}.csv`,
        mimeType: "text/csv;charset=utf-8",
        content: buildMagicQCsv(project, {
          ...options,
          departmentIds: [d.id],
        }),
        formatId: "magicq",
        label: `MagicQ — ${d.name}`,
      });
    }
    return files;
  }

  const content = buildMagicQCsv(project, options);
  return [
    {
      filename: `${base}_MagicQ.csv`,
      mimeType: "text/csv;charset=utf-8",
      content,
      formatId: "magicq",
      label: "MagicQ cuelist CSV",
    },
  ];
}

function buildMagicQCsv(project: Project, options: ExportOptions): string {
  const rows = resolveExportCues(project, options.departmentIds);
  const lines = ["#,Name,Start,End,Length,Color"];
  rows.forEach((r, i) => {
    const name = cueExportName(r.cue, r.department);
    lines.push(csvRow([`M${i + 1}`, name, r.magicqTc, "", "", ""]));
  });
  // No BOM — MagicQ keys off the leading `#`.
  return `${lines.join("\n")}\n`;
}
