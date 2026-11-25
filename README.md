# CueDesigner

Timecode-controlled live-show cue programmer (desktop + web). Phase 0 foundations plus Phase 1 BPM magnetic snap: project model, audio import/transport, department tracks, cue CRUD, BPM/grid snap, offline JSON save/load with media restore.

**Planning and export only. This software does not arm, enable, or fire pyrotechnic or SFX hardware.**

## Monorepo

| Package | Role |
|---------|------|
| `@cuedesigner/core` | Shared TypeScript project schema, departments, cues, persist |
| `@cuedesigner/web` | Vite + React programmer UI |
| `@cuedesigner/electron` | macOS-first Electron shell loading the web UI |

## Requirements

- Node.js 20+
- npm 10+

## Setup

```bash
npm install
npm run build
```

## Web (primary Phase 0 client)

```bash
npm run dev:web
```

Open http://localhost:5173

## Electron (macOS)

Build the web UI first, then run the shell:

```bash
npm run build -w @cuedesigner/web
npm run build -w @cuedesigner/electron
npm run start -w @cuedesigner/electron
```

Dev against the Vite server:

```bash
# terminal 1
npm run dev:web
# terminal 2
CUEDESIGNER_DEV_URL=http://localhost:5173 npm run dev -w @cuedesigner/electron
```

## Typecheck

```bash
npm run typecheck
```

## Phase 0 capabilities

- **Project:** New / Open / Save offline `.cueproj.json` (no network)
- **Audio:** Import WAV / AIFF / MP3 (and common browser-decodable formats); play / pause / scrub
- **Departments:** Seeded defaults (Pyro/SFX, Lighting, Audio, Cameras) + add / rename / recolour / delete
- **Cues:** Place at playhead or double-click track; select, drag-move, edit, delete; per-department cue numbers + global ordinal
- **Shell:** Electron loads the same web UI / schema on macOS

## BPM + magnetic snap (Phase 1)

Use the **BPM bar** under transport:

| Control | What it does |
|---------|----------------|
| **BPM** | Project tempo (quarter-note metronome) |
| **Time sig** | Beats per bar / beat unit (e.g. 4/4) |
| **Downbeat** | Offset of bar 1 beat 1 from file start (seconds) |
| **Snap** | Grid resolution: Bar, Beat, 1/4, 1/8, 1/16, 1/32 |
| **Magnetic snap** | When on, place/drag snaps to the grid |
| **Zoom** | Timeline horizontal zoom (`−` / slider / `+`); denser ruler labels when zoomed |

**Bypass:** hold **Alt** (Option on macOS) while placing a cue or dragging to keep free timing. Timeline shows a visible grid; the clock also shows a musical **bar.beat** stub. Settings persist in `.cueproj.json` under `project.settings` (`bpm`, `timeSignature`, `downbeatOffsetSec`, `gridResolution`, `snapEnabled`, `timelineZoom`).

**Timeline zoom:** **Ctrl**/⌘ + mouse wheel zooms toward the cursor; `−` / `+` / slider zoom around the playhead. When zoomed in, scroll horizontally (wheel also pans). Snap and Alt free-move keep working at every zoom. Zoom is kept for the session and optionally written into the project file as `timelineZoom` (1 = fit duration).

LTC/MTC, export packs, and a full absolute/TC/musical ruler switch are deferred.

## Save / Open and media (offline-first)

CueDesigner never uploads project or audio data. Everything stays on the machine (browser download + IndexedDB, or the same Chromium store inside Electron).

| Action | What happens |
|--------|----------------|
| **Import audio** | Bytes stay in memory for the session and are cached in **IndexedDB** keyed by `project.id`. |
| **Save** | Downloads a `.cueproj.json`. If media is ≤ **8 MiB**, bytes are embedded as `mediaDataUrl` (portable reopen anywhere). Larger files are **not** embedded; they remain in IndexedDB so **Open in the same browser/Electron profile** still restores playback. |
| **Open** | Restores cues from JSON, then reloads audio from embedded `mediaDataUrl` if present, otherwise from IndexedDB for that project id. Play / scrub work when media is found. If the project references media but neither source has it, the UI prompts clearly to **re-import** that file. |
| **New** | Clears session media and drops the previous project's IndexedDB media entry. |

Folder / sidecar packages (copy media next to JSON) are planned for a later phase; Phase 0 uses embed-small + IndexedDB for the simplest durable browser + Electron path.

## Project file sketch

```json
{
  "project": {
    "schemaVersion": 1,
    "name": "Untitled Show",
    "settings": {
      "bpm": 120,
      "timeSignature": [4, 4],
      "downbeatOffsetSec": 0,
      "gridResolution": "1/4",
      "snapEnabled": true,
      "timelineZoom": 1,
      "fps": "25"
    },
    "departments": [],
    "cues": [],
    "media": { "name": "track.wav", "durationSec": 600, "mimeType": "audio/wav" }
  },
  "mediaDataUrl": "data:audio/wav;base64,... (optional, when ≤ 8 MiB)"
}
```

Canonical cue time is **file-relative absolute seconds**. Musical **bar.beat** is shown as a derived view from BPM + downbeat; show TC and a full ruler mode switch come later.

## License

UNLICENSED — private / proprietary until published.
