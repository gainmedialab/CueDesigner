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

interface CueDesktopBridge {
  /** True when running inside the Electron shell (prefer native File menu). */
  isDesktop?: boolean;
  onShortcut(cb: (action: CueDesktopShortcutAction) => void): () => void;
  onFileAction?(cb: (action: CueDesktopFileAction) => void): () => void;
}

interface Window {
  cueDesktop?: CueDesktopBridge;
}
