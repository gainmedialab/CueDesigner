/**
 * Per-department cue numbers + global ordinal recompute / export naming.
 *   npm run build -w @cuedesigner/core && node packages/core/scripts/test-cue-numbering.mjs
 */
import assert from "node:assert/strict";
import {
  createCue,
  createProject,
  cueExportName,
  deskCueNumber,
  exportGrandMA3,
  exportMagicQ,
  exportSfxFinale,
  isValidDeptCueNumber,
  moveCue,
  nextDeptCueNumber,
  normalizeDeptCueNumber,
  placeCue,
  placeCuesOnDepartments,
  recomputeOrdinals,
  updateCue,
} from "../dist/index.js";

let idSeq = 0;
const idFactory = () => `id-${++idSeq}`;

const project = createProject("Numbering test");
const [pyro, lighting, audio] = project.departments;
assert.ok(pyro && lighting && audio);

// --- normalize / validate ---
assert.equal(normalizeDeptCueNumber("  5.1  "), "5.1");
assert.equal(normalizeDeptCueNumber("12"), "12");
assert.equal(isValidDeptCueNumber("5.1"), true);
assert.equal(isValidDeptCueNumber("   "), false);

// --- nextDeptCueNumber: whole after decimals ---
{
  let cues = [];
  cues = placeCue(
    cues,
    createCue({
      id: idFactory(),
      tAbs: 1,
      departmentId: lighting.id,
      cueNoDept: "5",
      label: "Wash",
    }),
  );
  cues = placeCue(
    cues,
    createCue({
      id: idFactory(),
      tAbs: 2,
      departmentId: lighting.id,
      cueNoDept: "5.1",
      label: "Bump",
    }),
  );
  assert.equal(nextDeptCueNumber(cues, lighting.id), "6");
  assert.equal(nextDeptCueNumber(cues, pyro.id), "1");
}

// --- place assigns independent per-dept sequences ---
idSeq = 0;
{
  const { cues } = placeCuesOnDepartments([], {
    tAbs: 3,
    departmentIds: [lighting.id, pyro.id],
    idFactory,
  });
  const light = cues.find((c) => c.departmentId === lighting.id);
  const py = cues.find((c) => c.departmentId === pyro.id);
  assert.equal(light?.cueNoDept, "1");
  assert.equal(py?.cueNoDept, "1");
  assert.deepEqual(
    cues.map((c) => c.ordinalGlobal).sort((a, b) => a - b),
    [1, 2],
  );
}

// --- ordinals recompute on move / time change ---
idSeq = 0;
{
  let cues = [];
  const a = createCue({
    id: idFactory(),
    tAbs: 10,
    departmentId: lighting.id,
    cueNoDept: "1",
    label: "Late",
  });
  const b = createCue({
    id: idFactory(),
    tAbs: 5,
    departmentId: pyro.id,
    cueNoDept: "1",
    label: "Early",
  });
  cues = placeCue(cues, a);
  cues = placeCue(cues, b);
  const early = cues.find((c) => c.id === b.id);
  const late = cues.find((c) => c.id === a.id);
  assert.equal(early?.ordinalGlobal, 1);
  assert.equal(late?.ordinalGlobal, 2);

  // Drag late cue earlier → ordinals swap
  cues = moveCue(cues, a.id, 1);
  assert.equal(cues.find((c) => c.id === a.id)?.ordinalGlobal, 1);
  assert.equal(cues.find((c) => c.id === b.id)?.ordinalGlobal, 2);

  // Inspector time edit path (updateCue tAbs)
  cues = updateCue(cues, a.id, { tAbs: 20 });
  assert.equal(cues.find((c) => c.id === b.id)?.ordinalGlobal, 1);
  assert.equal(cues.find((c) => c.id === a.id)?.ordinalGlobal, 2);

  // Editing dept number must not change ordinals by itself
  const before = cues.find((c) => c.id === b.id)?.ordinalGlobal;
  cues = updateCue(cues, b.id, { cueNoDept: "12.5" });
  assert.equal(cues.find((c) => c.id === b.id)?.cueNoDept, "12.5");
  assert.equal(cues.find((c) => c.id === b.id)?.ordinalGlobal, before);
}

// --- recomputeOrdinals stable for same-time (id tie-break) ---
{
  const cues = recomputeOrdinals([
    {
      id: "z",
      tAbs: 1,
      departmentId: lighting.id,
      cueNoDept: "2",
      ordinalGlobal: 99,
      label: "Z",
    },
    {
      id: "a",
      tAbs: 1,
      departmentId: pyro.id,
      cueNoDept: "1",
      ordinalGlobal: 99,
      label: "A",
    },
  ]);
  assert.equal(cues[0].id, "a");
  assert.equal(cues[0].ordinalGlobal, 1);
  assert.equal(cues[1].id, "z");
  assert.equal(cues[1].ordinalGlobal, 2);
}

// --- export naming / desk numbers ---
{
  const cue = {
    id: "c1",
    tAbs: 1,
    departmentId: lighting.id,
    cueNoDept: "5.1",
    ordinalGlobal: 3,
    label: "Blackout",
  };
  assert.equal(cueExportName(cue, lighting), "5.1 Blackout");
  assert.equal(cueExportName({ ...cue, label: "Cue" }, lighting), "Lighting 5.1");
  assert.equal(deskCueNumber(cue, 9), "5.1");
  assert.equal(deskCueNumber({ ...cue, cueNoDept: "x" }, 9), "9");
}

// --- MagicQ / MA / SFX use dept numbers ---
{
  let cues = [];
  cues = placeCue(
    cues,
    createCue({
      id: "mq1",
      tAbs: 10,
      departmentId: lighting.id,
      cueNoDept: "5.1",
      label: "Wash",
    }),
  );
  cues = placeCue(
    cues,
    createCue({
      id: "mq2",
      tAbs: 12,
      departmentId: pyro.id,
      cueNoDept: "12",
      label: "Hit",
    }),
  );
  const proj = { ...project, cues, name: "ExportNum" };

  const magicq = exportMagicQ(proj)[0].content;
  assert.match(magicq, /5\.1 Wash/);
  assert.match(magicq, /12 Hit/);

  const ma = exportGrandMA3(proj)[0].content;
  assert.match(ma, /Cue 5\.1 /);
  assert.match(ma, /Cue 12 /);
  assert.match(ma, /5\.1 Wash/);

  const sfx = exportSfxFinale(proj)[0].content;
  assert.match(sfx, /deptCue=5\.1/);
  assert.match(sfx, /ordinal=1/);
  assert.match(sfx, /deptCue=12/);
}

console.log("test-cue-numbering: ok");
