/**
 * Desktop bridge: main-process shortcut nudges (bare C on macOS can be eaten
 * by the application menu path before renderer keydown). Web builds ignore this.
 */
import { contextBridge, ipcRenderer } from "electron";

export type CueDesktopShortcut = "toggle-click";

contextBridge.exposeInMainWorld("cueDesktop", {
  onShortcut(cb: (action: CueDesktopShortcut) => void): () => void {
    const listener = (_event: unknown, action: unknown) => {
      if (action === "toggle-click") cb(action);
    };
    ipcRenderer.on("cue:shortcut", listener);
    return () => {
      ipcRenderer.removeListener("cue:shortcut", listener);
    };
  },
});
