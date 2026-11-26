import type { Project } from "../types.js";
import { exportGenericCsv, exportGenericTab } from "./generic.js";
import { exportGrandMA2, exportGrandMA3 } from "./grandma.js";
import { exportMagicQ } from "./magicq.js";
import { exportSfxFinale } from "./sfx.js";
import type {
  ExportFile,
  ExportFormatId,
  ExportOptions,
} from "./types.js";

export * from "./types.js";
export * from "./helpers.js";
export { exportMagicQ } from "./magicq.js";
export { exportGrandMA2, exportGrandMA3 } from "./grandma.js";
export { exportSfxFinale } from "./sfx.js";
export { exportGenericCsv, exportGenericTab } from "./generic.js";

/** Build one or more downloadable files for the selected format. */
export function buildExport(
  project: Project,
  formatId: ExportFormatId,
  options: ExportOptions = {},
): ExportFile[] {
  switch (formatId) {
    case "magicq":
      return exportMagicQ(project, options);
    case "grandma3":
      return exportGrandMA3(project, options);
    case "grandma2":
      return exportGrandMA2(project, options);
    case "sfx-finale":
      return exportSfxFinale(project, options);
    case "generic-csv":
      return exportGenericCsv(project, options);
    case "generic-tab":
      return exportGenericTab(project, options);
    default: {
      const _exhaustive: never = formatId;
      return _exhaustive;
    }
  }
}

/** Build files for multiple formats (e.g. Export dialog multi-select). */
export function buildExportPack(
  project: Project,
  formatIds: readonly ExportFormatId[],
  options: ExportOptions = {},
): ExportFile[] {
  const out: ExportFile[] = [];
  const seen = new Set<ExportFormatId>();
  for (const id of formatIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(...buildExport(project, id, options));
  }
  return out;
}

/** Count cues that would be included for the given department filter. */
export function countExportCues(
  project: Project,
  departmentIds?: readonly string[],
): number {
  if (!departmentIds?.length) return project.cues.length;
  const set = new Set(departmentIds);
  return project.cues.filter((c) => set.has(c.departmentId)).length;
}
