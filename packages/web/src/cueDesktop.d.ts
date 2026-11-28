/** Optional Electron preload bridge (absent in plain web). */
type CueDesktopShortcutAction =
  | "toggle-click"
  | "place-cue"
  | "place-cue-free";

interface CueDesktopBridge {
  onShortcut(cb: (action: CueDesktopShortcutAction) => void): () => void;
}

interface Window {
  cueDesktop?: CueDesktopBridge;
}
