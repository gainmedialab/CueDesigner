/**
 * Unit checks for matchTransportShortcut (mirrors packages/web/src/shortcuts.ts).
 *   node packages/web/scripts/test-shortcuts.mjs
 */
import assert from "node:assert/strict";

function matchTransportShortcut(e) {
  if (e.ctrlKey || e.metaKey) return null;
  if (e.repeat) return null;
  const code = e.code ?? "";
  const key = (e.key ?? "").length === 1 ? (e.key ?? "").toLowerCase() : "";
  if (code === "KeyN" || key === "n") return "placeCue";
  if (e.altKey) return null;
  if (code === "Space" || key === " " || key === "spacebar") return "play";
  if (code === "KeyF" || key === "f") return "follow";
  if (code === "KeyG" || key === "g") return "zoomOut";
  if (code === "KeyH" || key === "h") return "zoomIn";
  if (code === "KeyS" || key === "s") return "snap";
  if (code === "KeyJ" || key === "j") return "home";
  if (code === "KeyC" || key === "c") return "click";
  return null;
}

assert.equal(matchTransportShortcut({ code: "KeyC" }), "click");
assert.equal(matchTransportShortcut({ key: "c" }), "click");
assert.equal(matchTransportShortcut({ key: "C" }), "click");
assert.equal(matchTransportShortcut({ code: "KeyC", metaKey: true }), null);
assert.equal(matchTransportShortcut({ code: "KeyC", ctrlKey: true }), null);
assert.equal(matchTransportShortcut({ code: "KeyC", repeat: true }), null);
assert.equal(matchTransportShortcut({ code: "KeyS" }), "snap");
assert.equal(matchTransportShortcut({ code: "Space" }), "play");
assert.equal(matchTransportShortcut({ code: "KeyN" }), "placeCue");
assert.equal(matchTransportShortcut({ key: "n" }), "placeCue");
assert.equal(matchTransportShortcut({ code: "KeyN", altKey: true }), "placeCue");
assert.equal(matchTransportShortcut({ code: "KeyC", altKey: true }), null);
assert.equal(matchTransportShortcut({ code: "KeyN", metaKey: true }), null);

console.log(
  JSON.stringify({
    ok: true,
    clickViaCode: true,
    clickViaKey: true,
    cmdCIgnored: true,
    placeCueViaN: true,
    altNAllowed: true,
  }),
);
