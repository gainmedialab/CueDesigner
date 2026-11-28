import type { Cue, Department } from "./types.js";

/** Trim + collapse whitespace for a per-department cue number. */
export function normalizeDeptCueNumber(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * True when the string is a usable dept cue number (non-empty after normalize).
 * Decimals and whole numbers are both valid (`5`, `5.1`).
 */
export function isValidDeptCueNumber(raw: string): boolean {
  return normalizeDeptCueNumber(raw).length > 0;
}

/** Parse a dept cue number for sequencing / desk export; NaN if not numeric. */
export function parseDeptCueNumber(raw: string): number {
  const n = Number.parseFloat(normalizeDeptCueNumber(raw));
  return Number.isFinite(n) ? n : Number.NaN;
}

export function createCue(input: {
  id: string;
  tAbs: number;
  departmentId: string;
  cueNoDept: string;
  label?: string;
  note?: string;
  fadeSec?: number;
}): Omit<Cue, "ordinalGlobal"> {
  return {
    id: input.id,
    tAbs: Math.max(0, input.tAbs),
    departmentId: input.departmentId,
    cueNoDept: normalizeDeptCueNumber(input.cueNoDept) || "1",
    label: input.label?.trim() || "Cue",
    note: input.note,
    fadeSec: input.fadeSec,
  };
}

/** Recompute 1-based global ordinals by absolute time, then id. */
export function recomputeOrdinals(cues: Cue[]): Cue[] {
  const sorted = [...cues].sort((a, b) => {
    if (a.tAbs !== b.tAbs) return a.tAbs - b.tAbs;
    return a.id.localeCompare(b.id);
  });
  return sorted.map((c, i) => ({ ...c, ordinalGlobal: i + 1 }));
}

/**
 * Next whole-number cue for a department: floor(max numeric) + 1.
 * Non-numeric / empty dept numbers are ignored when finding max.
 * After `5.1` the next auto number is `6`.
 */
export function nextDeptCueNumber(
  cues: Cue[],
  departmentId: string,
): string {
  const nums = cues
    .filter((c) => c.departmentId === departmentId)
    .map((c) => parseDeptCueNumber(c.cueNoDept))
    .filter((n) => Number.isFinite(n));
  const max = nums.length ? Math.max(...nums) : 0;
  return String(Math.floor(max) + 1);
}

export function placeCue(
  cues: Cue[],
  draft: Omit<Cue, "ordinalGlobal">,
): Cue[] {
  return recomputeOrdinals([...cues, { ...draft, ordinalGlobal: 0 }]);
}

/**
 * Place one cue on each target department at the same absolute time.
 * Each department gets its own next cue number. Label/note/fade optional.
 */
export function placeCuesOnDepartments(
  cues: Cue[],
  input: {
    tAbs: number;
    departmentIds: string[];
    idFactory: () => string;
    label?: string;
    note?: string;
    fadeSec?: number;
  },
): { cues: Cue[]; createdIds: string[] } {
  const uniqueDeptIds = [...new Set(input.departmentIds.filter(Boolean))];
  if (uniqueDeptIds.length === 0) {
    return { cues, createdIds: [] };
  }
  let next = cues;
  const createdIds: string[] = [];
  const tAbs = Math.max(0, input.tAbs);
  for (const departmentId of uniqueDeptIds) {
    const id = input.idFactory();
    const draft = createCue({
      id,
      tAbs,
      departmentId,
      cueNoDept: nextDeptCueNumber(next, departmentId),
      label: input.label,
      note: input.note,
      fadeSec: input.fadeSec,
    });
    next = placeCue(next, draft);
    createdIds.push(id);
  }
  return { cues: next, createdIds };
}

/**
 * Copy selected cues onto other departments at the same absolute times.
 * Preserves label, note, fade, and fields; assigns new per-dept cue numbers.
 * Same-department targets are skipped (use place/duplicate on the source track).
 */
export function copyCuesToDepartments(
  cues: Cue[],
  input: {
    sourceCueIds: string[];
    targetDepartmentIds: string[];
    idFactory: () => string;
  },
): { cues: Cue[]; createdIds: string[] } {
  const sources = input.sourceCueIds
    .map((id) => cues.find((c) => c.id === id))
    .filter((c): c is Cue => Boolean(c));
  const targetDeptIds = [...new Set(input.targetDepartmentIds.filter(Boolean))];
  if (sources.length === 0 || targetDeptIds.length === 0) {
    return { cues, createdIds: [] };
  }

  // Stable order: show order of sources, then targets in caller order.
  const orderedSources = [...sources].sort((a, b) => {
    if (a.tAbs !== b.tAbs) return a.tAbs - b.tAbs;
    return a.ordinalGlobal - b.ordinalGlobal;
  });

  let next = cues;
  const createdIds: string[] = [];
  for (const source of orderedSources) {
    for (const departmentId of targetDeptIds) {
      if (departmentId === source.departmentId) continue;
      const id = input.idFactory();
      const draft = createCue({
        id,
        tAbs: source.tAbs,
        departmentId,
        cueNoDept: nextDeptCueNumber(next, departmentId),
        label: source.label,
        note: source.note,
        fadeSec: source.fadeSec,
      });
      const withFields: Omit<Cue, "ordinalGlobal"> = source.fields
        ? { ...draft, fields: { ...source.fields } }
        : draft;
      next = placeCue(next, withFields);
      createdIds.push(id);
    }
  }
  return { cues: next, createdIds };
}

export function updateCue(
  cues: Cue[],
  id: string,
  patch: Partial<Omit<Cue, "id" | "ordinalGlobal">>,
): Cue[] {
  const next = cues.map((c) => {
    if (c.id !== id) return c;
    const merged = { ...c, ...patch };
    if (patch.cueNoDept != null) {
      const normalized = normalizeDeptCueNumber(patch.cueNoDept);
      merged.cueNoDept = normalized || c.cueNoDept;
    }
    return merged;
  });
  // Ordinals always follow absolute time order (show-order index for SM).
  return recomputeOrdinals(next);
}

export function moveCue(cues: Cue[], id: string, tAbs: number): Cue[] {
  return updateCue(cues, id, { tAbs: Math.max(0, tAbs) });
}

export function deleteCue(cues: Cue[], id: string): Cue[] {
  return recomputeOrdinals(cues.filter((c) => c.id !== id));
}

export function deleteCuesForDepartment(
  cues: Cue[],
  departmentId: string,
): Cue[] {
  return recomputeOrdinals(
    cues.filter((c) => c.departmentId !== departmentId),
  );
}

export function cuesForDepartment(
  cues: Cue[],
  departmentId: string,
): Cue[] {
  return cues.filter((c) => c.departmentId === departmentId);
}

export function departmentById(
  departments: Department[],
  id: string,
): Department | undefined {
  return departments.find((d) => d.id === id);
}
