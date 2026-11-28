# @cuedesigner/electron

macOS-first Electron shell for CueDesigner. Loads the same offline web UI (`@cuedesigner/web`) for show-floor programming — no network required at runtime.

## Prerequisites

- Node.js 20+
- npm 10+
- **Packaged `.app` / DMG / zip:** a macOS machine (Apple Silicon or Intel). Linux CI can typecheck, build main-process JS, and smoke-pack with `npm run package:dir -w @cuedesigner/electron`, but DMG/zip need macOS (`npm run package:mac` refuses other platforms).

## Dev (Vite + Electron)

```bash
# from repo root
npm install

# terminal 1 — web UI
npm run dev:web

# terminal 2 — Electron against Vite
CUEDESIGNER_DEV_URL=http://localhost:5173 npm run dev:electron
```

## Run unpackaged (file:// offline UI)

```bash
npm run build
npm run start -w @cuedesigner/electron
```

`npm run build` refreshes `packages/web/dist` **and** copies it into `packages/electron/renderer/`.  
`npm run start` re-copies the renderer again, then launches Electron.

Unpackaged Electron prefers `packages/web/dist` over any leftover `renderer/` folder so a prior `package:mac` cannot serve a stale UI after you rebuild. Packaged apps still load `renderer/` from inside the app bundle.

## Package a macOS app

Produces a runnable `.app` plus **DMG** and **zip** under `packages/electron/release/`:

```bash
# from repo root (builds core → web → electron, copies renderer, runs electron-builder)
npm run package:mac
```

Or from this package after a full `npm run build` at the root:

```bash
npm run package:mac -w @cuedesigner/electron
```

### Host architecture

Default targets match the Mac you build on (`arm64` or `x64`). For a universal binary on a Mac with both Electron arch downloads available:

```bash
npm run package:mac -- --universal
```

(`package:mac` already forwards electron-builder flags after `--`.)

### Unsigned vs signed / notarized

Local/show-test builds are **unsigned** (`identity: null` in `electron-builder.yml`) so operators can open the DMG after right-click → Open (or `xattr -cr` once).

When you have an Apple Developer account, set on the packaging Mac:

| Variable | Purpose |
|----------|---------|
| `CSC_LINK` / `CSC_KEY_PASSWORD` | Developer ID Application certificate (`.p12`) |
| `APPLE_ID` | Apple ID for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password |
| `APPLE_TEAM_ID` | Team ID |

Then remove or override `mac.identity: null` and re-run `npm run package:mac`. electron-builder will sign with hardened runtime + the entitlements in `build/entitlements.mac.plist` (mic for LTC, USB MIDI, etc.).

## Application menu (macOS HIG)

The native **File** menu owns New / Open… / Open Shared… / Save / Share… / Export… (with standard ⌘ accelerators). The web UI hides its in-app File dropdown when `cueDesktop` is present and keeps **Edit Mode / Show Mode** + **Import audio** in the window chrome. Bare **C** / **N** still bridge to Click / cue-at-playhead so the Edit menu’s ⌘C Copy is never stolen.

## Offline show defaults

- Bundled fonts (no Google Fonts CDN at runtime)
- Single-instance lock (second launch focuses the open window)
- Background throttling disabled so LTC/MTC chase keeps ticking when unfocused
- Mic / MIDI permission prompts allowed; external navigations blocked
- Renderer ships inside the app via `scripts/prepare-renderer.mjs` → `renderer/`

## Layout

| Path | Role |
|------|------|
| `src/main.ts` | BrowserWindow + application menu + shortcut/file IPC |
| `src/preload.ts` | `cueDesktop` bridge (shortcuts + File menu actions) |
| `renderer/` | Copied web `dist` (gitignored; created before package) |
| `build/icon.png` | App icon source for electron-builder |
| `build/entitlements.mac.plist` | Hardened Runtime entitlements |
| `electron-builder.yml` | DMG + zip config |
| `release/` | Build output (gitignored) |

## CI smoke (non-mac)

```bash
npm run build
npm run package:dir -w @cuedesigner/electron
```

Produces `packages/electron/release/<platform>-unpacked/` with `renderer/` + `dist/main.js` inside `app.asar`. This is not a product artifact — only a pack-layout check.

## Windows

Deferred to Phase 2+. Do not add `win` targets here until that work lands.
