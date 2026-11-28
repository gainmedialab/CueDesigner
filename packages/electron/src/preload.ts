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

export type CueDesktopFileOpenPayload = {
  action: "open" | "open-shared";
  name: string;
  base64: string;
};

export type CueDesktopFilePayload =
  | CueDesktopFileAction
  | CueDesktopFileOpenPayload;

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

function isFilePayload(value: unknown): value is CueDesktopFilePayload {
  if (typeof value === "string") {
    return FILE_ACTIONS.has(value as CueDesktopFileAction);
  }
  if (!value || typeof value !== "object") return false;
  const obj = value as { action?: unknown; name?: unknown; base64?: unknown };
  return (
    (obj.action === "open" || obj.action === "open-shared") &&
    typeof obj.name === "string" &&
    typeof obj.base64 === "string"
  );
}

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
  onFileAction(cb: (payload: CueDesktopFilePayload) => void): () => void {
    const listener = (_event: unknown, payload: unknown) => {
      if (isFilePayload(payload)) cb(payload);
    };
    ipcRenderer.on("cue:file", listener);
    return () => {
      ipcRenderer.removeListener("cue:file", listener);
    };
  },
  /** Native Save dialog — avoids Chromium blocking programmatic <a download>. */
  saveFile(opts: {
    defaultPath: string;
    data: ArrayBuffer;
  }): Promise<{ ok: true; filePath: string } | { ok: false; reason?: string }> {
    return ipcRenderer.invoke("cue:save-file", opts);
  },
});
