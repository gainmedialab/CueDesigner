/** Transport / grid shortcuts shared by App + tests. */

export type TransportShortcut =
  | "play"
  | "follow"
  | "zoomOut"
  | "zoomIn"
  | "snap"
  | "home"
  | "click";

export interface ShortcutKeyLike {
  code?: string;
  key?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
}

/**
 * Map a key event to a transport shortcut.
 * Prefers `code` (physical), falls back to `key` (layout / Electron before-input).
 * Ignores Ctrl/⌘/Alt chords (Electron Edit menu owns ⌘C copy).
 */
export function matchTransportShortcut(
  e: ShortcutKeyLike,
): TransportShortcut | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.repeat) return null;
  const code = e.code ?? "";
  const key = (e.key ?? "").length === 1 ? (e.key ?? "").toLowerCase() : "";

  if (code === "Space" || key === " " || key === "spacebar") return "play";
  if (code === "KeyF" || key === "f") return "follow";
  if (code === "KeyG" || key === "g") return "zoomOut";
  if (code === "KeyH" || key === "h") return "zoomIn";
  if (code === "KeyS" || key === "s") return "snap";
  if (code === "KeyJ" || key === "j") return "home";
  if (code === "KeyC" || key === "c") return "click";
  return null;
}
