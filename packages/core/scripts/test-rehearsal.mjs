/**
 * Unit checks for rehearsal loop + next-cue countdown helpers.
 *   npm run build -w @cuedesigner/core && node packages/core/scripts/test-rehearsal.mjs
 */
import assert from "node:assert/strict";
import {
  countdownToCueSec,
  findNextCue,
  formatCountdownAbs,
  isValidLoopRegion,
  loopRegionFromPause,
  loopWrapTarget,
  normalizeLoopPoints,
  placeCue,
  createCue,
  createProject,
} from "../dist/index.js";

// --- loop region ---
assert.equal(isValidLoopRegion(1, 2), true);
assert.equal(isValidLoopRegion(1, 1.01), false); // < min span
assert.equal(isValidLoopRegion(null, 2), false);
assert.equal(isValidLoopRegion(2, 1), false);

{
  const n = normalizeLoopPoints(5, 2, 10);
  assert.equal(n.loopA, 2);
  assert.equal(n.loopB, 5);
}
{
  const n = normalizeLoopPoints(-1, 99, 10);
  assert.equal(n.loopA, 0);
  assert.equal(n.loopB, 10);
}

assert.equal(loopWrapTarget(1.9, 1, 2, { enabled: true }), null);
assert.equal(loopWrapTarget(2, 1, 2, { enabled: true }), 1);
assert.equal(loopWrapTarget(2.01, 1, 2, { enabled: true }), 1);
assert.equal(loopWrapTarget(2, 1, 2, { enabled: false }), null);
assert.equal(loopWrapTarget(2, null, 2, { enabled: true }), null);

{
  const r = loopRegionFromPause(3, 8, 60);
  assert.deepEqual(r, { loopA: 3, loopB: 8 });
}
assert.equal(loopRegionFromPause(5, 5.01, 60), null);
assert.equal(loopRegionFromPause(8, 3, 60)?.loopA, 3);

// --- next cue / countdown ---
const project = createProject("Rehearsal test");
const [pyro, lighting] = project.departments;
assert.ok(pyro && lighting);

let cues = [];
cues = placeCue(
  cues,
  createCue({
    id: "a",
    tAbs: 1,
    departmentId: pyro.id,
    cueNoDept: "1",
    label: "Pyro early",
  }),
);
cues = placeCue(
  cues,
  createCue({
    id: "b",
    tAbs: 5,
    departmentId: lighting.id,
    cueNoDept: "1",
    label: "LX mid",
  }),
);
cues = placeCue(
  cues,
  createCue({
    id: "c",
    tAbs: 5,
    departmentId: pyro.id,
    cueNoDept: "2",
    label: "Pyro mid",
  }),
);
cues = placeCue(
  cues,
  createCue({
    id: "d",
    tAbs: 10,
    departmentId: lighting.id,
    cueNoDept: "2",
    label: "LX late",
  }),
);

assert.equal(findNextCue(cues, 0)?.id, "a");
assert.equal(findNextCue(cues, 1)?.id, "b"); // same-time pair: lower ordinal first after pass
assert.equal(findNextCue(cues, 4.9)?.label, "LX mid");
assert.equal(
  findNextCue(cues, 0, { departmentIds: [lighting.id] })?.id,
  "b",
);
assert.equal(
  findNextCue(cues, 5, { departmentIds: [lighting.id] })?.id,
  "d",
);
assert.equal(findNextCue(cues, 10), null);
assert.equal(findNextCue(cues, 10, { departmentIds: [] })?.id ?? null, null);

assert.equal(countdownToCueSec(findNextCue(cues, 3), 3), 2);
assert.equal(countdownToCueSec(null, 3), null);
assert.equal(formatCountdownAbs(3.25), "−00:03.250");
assert.equal(formatCountdownAbs(0), "−00:00.000");

console.log(
  JSON.stringify({
    ok: true,
    loopWrap: true,
    pauseRegion: true,
    nextCueFilter: true,
    countdownFormat: true,
  }),
);
