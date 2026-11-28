/**
 * Unit checks for Show Mode helpers + share preferShowMode round-trip.
 *   npm run build -w @cuedesigner/core && node packages/core/scripts/test-show-mode.mjs
 */
import assert from "node:assert/strict";
import {
  SHOW_MODE_BANNER,
  SHOW_MODE_EXIT_CONFIRM,
  buildSharePackage,
  canMutateShow,
  createProject,
  deserializeProject,
  editModeLabel,
  isShowModeLockedAction,
  parseSharePackage,
  resolveSharedOpenEditMode,
  serializeProject,
  showModeBlockedStatus,
  SHARE_PROJECT_PATH,
} from "../dist/index.js";

assert.equal(SHOW_MODE_BANNER, "Show Mode — edits locked");
assert.ok(SHOW_MODE_EXIT_CONFIRM.includes("Exit Show Mode"));
assert.equal(editModeLabel("show"), "Show Mode");
assert.equal(editModeLabel("edit"), "Edit Mode");
assert.match(showModeBlockedStatus("create cue"), /create cue/);

assert.equal(isShowModeLockedAction("createCue"), true);
assert.equal(isShowModeLockedAction("moveCue"), true);
assert.equal(isShowModeLockedAction("deleteCue"), true);
assert.equal(isShowModeLockedAction("addDepartment"), true);
assert.equal(isShowModeLockedAction("projectSettings"), true);
assert.equal(isShowModeLockedAction("importAudio"), true);
assert.equal(isShowModeLockedAction("newProject"), true);

assert.equal(canMutateShow("edit", "createCue"), true);
assert.equal(canMutateShow("show", "createCue"), false);
assert.equal(canMutateShow("show", "deleteDepartment"), false);
assert.equal(canMutateShow("show", "projectSettings"), false);
assert.equal(canMutateShow("edit", "projectSettings"), true);

// Open shared defaults to Show Mode; false flag opens Edit Mode
assert.equal(resolveSharedOpenEditMode(undefined), "show");
assert.equal(resolveSharedOpenEditMode(true), "show");
assert.equal(resolveSharedOpenEditMode(false), "edit");

// preferShowMode round-trips through serialize / deserialize
{
  const p = createProject("Show Mode Persist");
  const json = serializeProject(p, undefined, true);
  const file = deserializeProject(json);
  assert.equal(file.preferShowMode, true);
  const jsonEdit = serializeProject(p, undefined, false);
  assert.equal(deserializeProject(jsonEdit).preferShowMode, false);
  const jsonBare = serializeProject(p);
  assert.equal(deserializeProject(jsonBare).preferShowMode, undefined);
}

// Share package defaults preferShowMode true and parses it back
{
  const project = createProject("Shared SM");
  const packed = buildSharePackage({ project });
  assert.equal(packed.preferShowMode, true);
  const projectEntry = packed.entries.find((e) => e.filename === SHARE_PROJECT_PATH);
  assert.ok(projectEntry);
  const text =
    typeof projectEntry.content === "string"
      ? projectEntry.content
      : new TextDecoder().decode(projectEntry.content);
  assert.match(text, /"preferShowMode": true/);

  const parsed = parseSharePackage(
    new Map(
      packed.entries.map((e) => [
        e.filename,
        typeof e.content === "string"
          ? new TextEncoder().encode(e.content)
          : e.content,
      ]),
    ),
  );
  assert.equal(parsed.preferShowMode, true);
  assert.equal(resolveSharedOpenEditMode(parsed.preferShowMode), "show");
}

{
  const project = createProject("Shared Edit");
  const packed = buildSharePackage({ project, preferShowMode: false });
  assert.equal(packed.preferShowMode, false);
  const parsed = parseSharePackage(
    new Map(
      packed.entries.map((e) => [
        e.filename,
        typeof e.content === "string"
          ? new TextEncoder().encode(e.content)
          : e.content,
      ]),
    ),
  );
  assert.equal(parsed.preferShowMode, false);
  assert.equal(resolveSharedOpenEditMode(parsed.preferShowMode), "edit");
}

console.log("test-show-mode: ok");
