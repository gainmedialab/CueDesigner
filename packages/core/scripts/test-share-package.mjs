/**
 * Smoke test: build → zip bytes round-trip via web zip helpers is covered in
 * web; this script validates core sharePackage build/parse without DOM.
 */
import assert from "node:assert/strict";
import {
  buildSharePackage,
  createCue,
  createProject,
  parseSharePackage,
  placeCue,
  setProjectMedia,
  SHARE_MEDIA_DIR,
  SHARE_PROJECT_PATH,
  SHARE_README_PATH,
} from "../dist/index.js";

const project0 = createProject("Share Test Show");
const withMedia = setProjectMedia(project0, {
  id: "m1",
  name: "show-track.wav",
  mimeType: "audio/wav",
  durationSec: 12.5,
});
const cue = createCue({
  id: "c1",
  tAbs: 1.25,
  departmentId: withMedia.departments[0].id,
  cueNoDept: "1",
  label: "Hit",
});
const project = {
  ...withMedia,
  cues: placeCue(withMedia.cues, cue),
};

const fakeWav = new TextEncoder().encode("RIFF....WAVEfmt ");
const packed = buildSharePackage({
  project,
  mediaBytes: fakeWav,
  mediaName: "show-track.wav",
  mediaMimeType: "audio/wav",
});

assert.equal(packed.includedMedia, true);
assert.match(packed.filename, /\.cueproj\.zip$/);
assert.ok(packed.entries.some((e) => e.filename === SHARE_PROJECT_PATH));
assert.ok(packed.entries.some((e) => e.filename === SHARE_README_PATH));
assert.ok(
  packed.entries.some((e) => e.filename.startsWith(SHARE_MEDIA_DIR)),
  "expected media/ entry",
);

const asMap = new Map(
  packed.entries.map((e) => [
    e.filename,
    typeof e.content === "string"
      ? new TextEncoder().encode(e.content)
      : e.content,
  ]),
);

const parsed = parseSharePackage(asMap);
assert.equal(parsed.project.name, "Share Test Show");
assert.equal(parsed.project.cues.length, 1);
assert.equal(parsed.project.cues[0].label, "Hit");
assert.ok(parsed.media, "media should round-trip");
assert.equal(parsed.media.name, "show-track.wav");
assert.deepEqual([...parsed.media.bytes], [...fakeWav]);
assert.ok(
  parsed.project.media?.relativePath?.startsWith(SHARE_MEDIA_DIR),
  "relativePath set",
);

// Without media bytes — still valid package; recipient must import audio.
const cuesOnly = buildSharePackage({ project });
assert.equal(cuesOnly.includedMedia, false);
const parsedBare = parseSharePackage(
  new Map(
    cuesOnly.entries.map((e) => [
      e.filename,
      typeof e.content === "string"
        ? new TextEncoder().encode(e.content)
        : e.content,
    ]),
  ),
);
assert.equal(parsedBare.project.cues.length, 1);
assert.equal(parsedBare.media, undefined);

console.log("test-share-package: ok");
