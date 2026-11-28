import type { Cue, Department } from "./types.js";

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
    cueNoDept: input.cueNoDept,
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

export function nextDeptCueNumber(
  cues: Cue[],
  departmentId: string,
): string {
  const nums = cues
    .filter((c) => c.departmentId === departmentId)
    .map((c) => Number.parseFloat(c.cueNoDept))
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
  const next = cues.map((c) => (c.id === id ? { ...c, ...patch } : c));
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
