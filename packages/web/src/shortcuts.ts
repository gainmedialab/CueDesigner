/** Transport / grid / rehearsal shortcuts shared by App + tests. */

export type TransportShortcut =
  | "play"
  | "follow"
  | "zoomOut"
  | "zoomIn"
  | "snap"
  | "home"
  | "click"
  | "placeCue"
  | "setLoopIn"
  | "setLoopOut"
  | "toggleLoop";

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
 * Ignores Ctrl/⌘ chords (Electron Edit menu owns ⌘C copy).
 * Alt is ignored except for **N** (free / unsnapped cue, same as Cue-at-playhead button).
 *
 * Existing: Space / F / G / H / S / J / C / N.
 * Rehearsal: **I** set loop In (A), **O** set loop Out (B), **L** toggle loop.
 */
export function matchTransportShortcut(
  e: ShortcutKeyLike,
): TransportShortcut | null {
  if (e.ctrlKey || e.metaKey) return null;
  if (e.repeat) return null;
  const code = e.code ?? "";
  const key = (e.key ?? "").length === 1 ? (e.key ?? "").toLowerCase() : "";

  // N allows Alt (bypass snap). Other letter shortcuts reject Alt.
  if (code === "KeyN" || key === "n") return "placeCue";
  if (e.altKey) return null;

  if (code === "Space" || key === " " || key === "spacebar") return "play";
  if (code === "KeyF" || key === "f") return "follow";
  if (code === "KeyG" || key === "g") return "zoomOut";
  if (code === "KeyH" || key === "h") return "zoomIn";
  if (code === "KeyS" || key === "s") return "snap";
  if (code === "KeyJ" || key === "j") return "home";
  if (code === "KeyC" || key === "c") return "click";
  if (code === "KeyI" || key === "i") return "setLoopIn";
  if (code === "KeyO" || key === "o") return "setLoopOut";
  if (code === "KeyL" || key === "l") return "toggleLoop";
  return null;
}
