/**
 * Desktop bridge: main-process shortcut nudges (bare C / N on macOS can be
 * eaten by the application menu path before renderer keydown) + File menu
 * actions from the native application menu. Web ignores this.
 */
import { contextBridge, ipcRenderer } from "electron";

export type CueDesktopShortcut =
  | "toggle-click"
  | "place-cue"
  | "place-cue-free";

export type CueDesktopFileAction =
  | "new"
  | "open"
  | "open-shared"
  | "save"
  | "share"
  | "export";

const SHORTCUT_ACTIONS = new Set<CueDesktopShortcut>([
  "toggle-click",
  "place-cue",
  "place-cue-free",
]);

const FILE_ACTIONS = new Set<CueDesktopFileAction>([
  "new",
  "open",
  "open-shared",
  "save",
  "share",
  "export",
]);

contextBridge.exposeInMainWorld("cueDesktop", {
  isDesktop: true,
  onShortcut(cb: (action: CueDesktopShortcut) => void): () => void {
    const listener = (_event: unknown, action: unknown) => {
      if (
        typeof action === "string" &&
        SHORTCUT_ACTIONS.has(action as CueDesktopShortcut)
      ) {
        cb(action as CueDesktopShortcut);
      }
    };
    ipcRenderer.on("cue:shortcut", listener);
    return () => {
      ipcRenderer.removeListener("cue:shortcut", listener);
    };
  },
  onFileAction(cb: (action: CueDesktopFileAction) => void): () => void {
    const listener = (_event: unknown, action: unknown) => {
      if (
        typeof action === "string" &&
        FILE_ACTIONS.has(action as CueDesktopFileAction)
      ) {
        cb(action as CueDesktopFileAction);
      }
    };
    ipcRenderer.on("cue:file", listener);
    return () => {
      ipcRenderer.removeListener("cue:file", listener);
    };
  },
});
