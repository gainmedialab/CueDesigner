/**
 * Desktop bridge: main-process shortcut nudges (bare C / N on macOS can be
 * eaten by the application menu path before renderer keydown). Web ignores this.
 */
import { contextBridge, ipcRenderer } from "electron";

export type CueDesktopShortcut =
  | "toggle-click"
  | "place-cue"
  | "place-cue-free";

const ACTIONS = new Set<CueDesktopShortcut>([
  "toggle-click",
  "place-cue",
  "place-cue-free",
]);

contextBridge.exposeInMainWorld("cueDesktop", {
  onShortcut(cb: (action: CueDesktopShortcut) => void): () => void {
    const listener = (_event: unknown, action: unknown) => {
      if (typeof action === "string" && ACTIONS.has(action as CueDesktopShortcut)) {
        cb(action as CueDesktopShortcut);
      }
    };
    ipcRenderer.on("cue:shortcut", listener);
    return () => {
      ipcRenderer.removeListener("cue:shortcut", listener);
    };
  },
});
