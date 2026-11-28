#!/usr/bin/env node
/**
 * macOS DMG/zip packaging needs a Darwin host (codesign tooling, dmg-license,
 * and a real .app layout). Fail fast with a clear message on Linux/Windows CI.
 */
if (process.platform !== "darwin") {
  console.error(
    `[package:mac] Refusing to run on ${process.platform}.\n` +
      `  Build CueDesigner.app / DMG / zip on a macOS machine:\n` +
      `    npm run package:mac\n` +
      `  On Linux agents, smoke-test the pack layout with:\n` +
      `    npm run package:dir -w @cuedesigner/electron`,
  );
  process.exit(1);
}
