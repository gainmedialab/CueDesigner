/**
 * Unit checks for placeCuesOnDepartments + copyCuesToDepartments.
 *   npm run build -w @cuedesigner/core && node packages/core/scripts/test-multi-dept-cues.mjs
 */
import assert from "node:assert/strict";
import {
  copyCuesToDepartments,
  createCue,
  createProject,
  nextDeptCueNumber,
  placeCue,
  placeCuesOnDepartments,
} from "../dist/index.js";

let idSeq = 0;
const idFactory = () => `id-${++idSeq}`;

const project = createProject("Multi-dept test");
const [pyro, lighting, audio] = project.departments;
assert.ok(pyro && lighting && audio);

// --- placeCuesOnDepartments ---
idSeq = 0;
{
  const empty = project.cues;
  const { cues, createdIds } = placeCuesOnDepartments(empty, {
    tAbs: 4.5,
    departmentIds: [pyro.id, lighting.id, audio.id],
    idFactory,
    label: "Hit",
    note: "shared",
  });
  assert.equal(createdIds.length, 3);
  assert.equal(cues.length, 3);
  for (const dept of [pyro, lighting, audio]) {
    const c = cues.find((x) => x.departmentId === dept.id);
    assert.ok(c);
    assert.equal(c.tAbs, 4.5);
    assert.equal(c.label, "Hit");
    assert.equal(c.note, "shared");
    assert.equal(c.cueNoDept, "1");
  }
  // ordinals recomputed
  assert.deepEqual(
    [...cues].sort((a, b) => a.ordinalGlobal - b.ordinalGlobal).map((c) => c.ordinalGlobal),
    [1, 2, 3],
  );
}

// Dedup dept ids + empty targets
{
  const { cues, createdIds } = placeCuesOnDepartments([], {
    tAbs: 1,
    departmentIds: [pyro.id, pyro.id],
    idFactory,
  });
  assert.equal(createdIds.length, 1);
  assert.equal(cues.length, 1);

  const none = placeCuesOnDepartments(cues, {
    tAbs: 2,
    departmentIds: [],
    idFactory,
  });
  assert.equal(none.createdIds.length, 0);
  assert.equal(none.cues.length, 1);
}

// Per-dept numbering continues after existing cues
{
  let cues = placeCue(
    [],
    createCue({
      id: "existing",
      tAbs: 0.5,
      departmentId: lighting.id,
      cueNoDept: "3",
      label: "Old",
    }),
  );
  const placed = placeCuesOnDepartments(cues, {
    tAbs: 2,
    departmentIds: [lighting.id, pyro.id],
    idFactory,
  });
  const lightNew = placed.cues.find(
    (c) => c.departmentId === lighting.id && c.id !== "existing",
  );
  const pyroNew = placed.cues.find((c) => c.departmentId === pyro.id);
  assert.equal(lightNew?.cueNoDept, "4");
  assert.equal(pyroNew?.cueNoDept, "1");
  assert.equal(nextDeptCueNumber(placed.cues, lighting.id), "5");
}

// --- copyCuesToDepartments ---
idSeq = 100;
{
  let cues = placeCue(
    [],
    createCue({
      id: "src-a",
      tAbs: 10,
      departmentId: pyro.id,
      cueNoDept: "1",
      label: "Boom",
      note: "loud",
      fadeSec: 0.5,
    }),
  );
  cues = placeCue(
    cues,
    createCue({
      id: "src-b",
      tAbs: 12,
      departmentId: pyro.id,
      cueNoDept: "2",
      label: "Flash",
    }),
  );

  const { cues: copied, createdIds } = copyCuesToDepartments(cues, {
    sourceCueIds: ["src-a", "src-b"],
    targetDepartmentIds: [lighting.id, audio.id, pyro.id],
    idFactory,
  });
  // Same-dept (pyro) skipped → 2 sources × 2 targets = 4
  assert.equal(createdIds.length, 4);
  assert.equal(copied.length, 6);

  const lightingCopies = copied
    .filter((c) => c.departmentId === lighting.id)
    .sort((a, b) => a.tAbs - b.tAbs);
  assert.equal(lightingCopies.length, 2);
  assert.equal(lightingCopies[0].tAbs, 10);
  assert.equal(lightingCopies[0].label, "Boom");
  assert.equal(lightingCopies[0].note, "loud");
  assert.equal(lightingCopies[0].fadeSec, 0.5);
  assert.equal(lightingCopies[0].cueNoDept, "1");
  assert.equal(lightingCopies[1].tAbs, 12);
  assert.equal(lightingCopies[1].label, "Flash");
  assert.equal(lightingCopies[1].cueNoDept, "2");

  const audioCopies = copied
    .filter((c) => c.departmentId === audio.id)
    .sort((a, b) => a.tAbs - b.tAbs);
  assert.equal(audioCopies.length, 2);
  assert.equal(audioCopies[0].cueNoDept, "1");
  assert.equal(audioCopies[1].cueNoDept, "2");

  // Originals untouched
  const orig = copied.find((c) => c.id === "src-a");
  assert.equal(orig?.departmentId, pyro.id);
  assert.equal(orig?.cueNoDept, "1");
}

// fields copy
{
  const withFields = placeCue([], {
    ...createCue({
      id: "fld",
      tAbs: 1,
      departmentId: pyro.id,
      cueNoDept: "1",
      label: "Pin",
    }),
    fields: { module: "A", pin: 3 },
  });
  const { cues: out } = copyCuesToDepartments(withFields, {
    sourceCueIds: ["fld"],
    targetDepartmentIds: [lighting.id],
    idFactory,
  });
  const copy = out.find((c) => c.departmentId === lighting.id);
  assert.ok(copy?.fields);
  assert.deepEqual(copy.fields, { module: "A", pin: 3 });
  // Mutating copy fields must not mutate source
  copy.fields.pin = 99;
  assert.equal(out.find((c) => c.id === "fld")?.fields?.pin, 3);
}

// Empty selection / no targets
{
  const base = placeCue(
    [],
    createCue({
      id: "only",
      tAbs: 1,
      departmentId: pyro.id,
      cueNoDept: "1",
    }),
  );
  assert.equal(
    copyCuesToDepartments(base, {
      sourceCueIds: [],
      targetDepartmentIds: [lighting.id],
      idFactory,
    }).createdIds.length,
    0,
  );
  assert.equal(
    copyCuesToDepartments(base, {
      sourceCueIds: ["only"],
      targetDepartmentIds: [pyro.id],
      idFactory,
    }).createdIds.length,
    0,
  );
}

console.log(
  JSON.stringify({
    ok: true,
    placeMultiDept: true,
    copyBetweenDepts: true,
    perDeptNumbers: true,
    fieldsPreserved: true,
  }),
);
