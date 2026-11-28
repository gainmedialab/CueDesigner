/**
 * Show Mode — lock destructive show edits for SM / desk floor use.
 * Session-only UI mode (not a project schema field). Share packages may
 * carry `preferShowMode` so Open shared enters view-only by default.
 */

/** Session edit gate: Edit Mode allows programming; Show Mode locks structure. */
export type AppEditMode = "edit" | "show";

/** Banner copy when Show Mode is active. */
export const SHOW_MODE_BANNER = "Show Mode — edits locked";

/** Confirm dialog when leaving Show Mode for Edit Mode. */
export const SHOW_MODE_EXIT_CONFIRM =
  "Exit Show Mode and allow edits? Cue create/move/delete, departments, and BPM/grid changes will be unlocked.";

/** Status line when a locked action is attempted. */
export function showModeBlockedStatus(action: string): string {
  return `Show Mode — ${action} locked. Exit Show Mode to edit.`;
}

/**
 * Destructive / structure-changing actions blocked in Show Mode.
 * Operate tools (transport, Follow, zoom, Sync chase, Generate arm,
 * loop/countdown, Click, Export, Save/Share) stay allowed.
 */
export type ShowModeLockedAction =
  | "createCue"
  | "moveCue"
  | "deleteCue"
  | "updateCue"
  | "copyCue"
  | "addDepartment"
  | "renameDepartment"
  | "recolorDepartment"
  | "deleteDepartment"
  | "projectSettings"
  | "importAudio"
  | "newProject";

const LOCKED: ReadonlySet<ShowModeLockedAction> = new Set([
  "createCue",
  "moveCue",
  "deleteCue",
  "updateCue",
  "copyCue",
  "addDepartment",
  "renameDepartment",
  "recolorDepartment",
  "deleteDepartment",
  "projectSettings",
  "importAudio",
  "newProject",
]);

/** True when the action must not mutate the show while Show Mode is on. */
export function isShowModeLockedAction(
  action: ShowModeLockedAction,
): boolean {
  return LOCKED.has(action);
}

/**
 * Whether a session may perform `action` given the current edit mode.
 * Edit Mode → always true. Show Mode → false for locked actions.
 */
export function canMutateShow(
  mode: AppEditMode,
  action: ShowModeLockedAction,
): boolean {
  if (mode === "edit") return true;
  return !isShowModeLockedAction(action);
}

/**
 * Open shared (.cueproj.zip) for SM/desk: enter Show Mode by default.
 * Honor an explicit package flag when present (`preferShowMode`).
 * - undefined / true → Show Mode
 * - false → Edit Mode (recipient asked to open for programming)
 */
export function resolveSharedOpenEditMode(
  preferShowMode: boolean | undefined,
): AppEditMode {
  if (preferShowMode === false) return "edit";
  return "show";
}

/** Human label for the mode indicator / toggle. */
export function editModeLabel(mode: AppEditMode): string {
  return mode === "show" ? "Show Mode" : "Edit Mode";
}
