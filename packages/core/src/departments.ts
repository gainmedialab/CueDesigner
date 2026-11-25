import type { Department } from "./types.js";

/** Seeded defaults for new projects (exact list still open in roadmap). */
export const SEEDED_DEPARTMENTS: ReadonlyArray<Omit<Department, "id">> = [
  { name: "Pyro/SFX", color: "#c45c26", shortcut: "1" },
  { name: "Lighting", color: "#2f6fed", shortcut: "2" },
  { name: "Audio", color: "#1a9f6e", shortcut: "3" },
  { name: "Cameras", color: "#8b5cf6", shortcut: "4" },
] as const;

export function createSeededDepartments(idFactory: () => string): Department[] {
  return SEEDED_DEPARTMENTS.map((d) => ({
    ...d,
    id: idFactory(),
  }));
}

export function addDepartment(
  departments: Department[],
  input: { name: string; color: string; shortcut?: string },
  idFactory: () => string,
): Department[] {
  return [
    ...departments,
    {
      id: idFactory(),
      name: input.name.trim() || "Untitled",
      color: input.color,
      shortcut: input.shortcut,
    },
  ];
}

export function renameDepartment(
  departments: Department[],
  id: string,
  name: string,
): Department[] {
  return departments.map((d) =>
    d.id === id ? { ...d, name: name.trim() || d.name } : d,
  );
}

export function recolorDepartment(
  departments: Department[],
  id: string,
  color: string,
): Department[] {
  return departments.map((d) => (d.id === id ? { ...d, color } : d));
}

export function deleteDepartment(
  departments: Department[],
  id: string,
): Department[] {
  return departments.filter((d) => d.id !== id);
}
