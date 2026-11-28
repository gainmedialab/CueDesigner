/** Optional Electron preload bridge (absent in plain web). */
interface CueDesktopBridge {
  onShortcut(cb: (action: "toggle-click") => void): () => void;
}

interface Window {
  cueDesktop?: CueDesktopBridge;
}
