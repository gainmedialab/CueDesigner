#!/usr/bin/env node
/**
 * Copy the built web UI into packages/electron/renderer so electron-builder
 * can ship a self-contained macOS app (no workspace sibling paths at runtime).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.join(__dirname, "..");
const webDist = path.join(electronRoot, "..", "web", "dist");
const rendererDest = path.join(electronRoot, "renderer");
const indexHtml = path.join(webDist, "index.html");

if (!fs.existsSync(indexHtml)) {
  console.error(
    "[prepare-renderer] Missing packages/web/dist/index.html.\n" +
      "  Run: npm run build -w @cuedesigner/web",
  );
  process.exit(1);
}

fs.rmSync(rendererDest, { recursive: true, force: true });
fs.cpSync(webDist, rendererDest, { recursive: true });

const files = fs.readdirSync(rendererDest);
console.log(
  `[prepare-renderer] Copied ${files.length} entries → ${path.relative(process.cwd(), rendererDest)}`,
);
