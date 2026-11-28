/** Optional Electron preload bridge (absent in plain web). */
type CueDesktopShortcutAction =
  | "toggle-click"
  | "place-cue"
  | "place-cue-free";

/** Native application File menu → renderer (Electron). */
type CueDesktopFileAction =
  | "new"
  | "open"
  | "open-shared"
  | "save"
  | "share"
  | "export";

/** Open / Open Shared with file bytes from the native dialog. */
type CueDesktopFileOpenPayload = {
  action: "open" | "open-shared";
  name: string;
  base64: string;
};

type CueDesktopFilePayload = CueDesktopFileAction | CueDesktopFileOpenPayload;

interface CueDesktopBridge {
  /** True when running inside the Electron shell (prefer native File menu). */
  isDesktop?: boolean;
  onShortcut(cb: (action: CueDesktopShortcutAction) => void): () => void;
  onFileAction?(cb: (payload: CueDesktopFilePayload) => void): () => void;
  /** Native Save dialog write (Save / Share). */
  saveFile?(opts: {
    defaultPath: string;
    data: ArrayBuffer;
  }): Promise<{ ok: true; filePath: string } | { ok: false; reason?: string }>;
}

interface Window {
  cueDesktop?: CueDesktopBridge;
}
