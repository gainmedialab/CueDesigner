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
