# CueDesigner

Timecode-controlled live-show cue programmer (desktop + web). Phase 0 foundations: project model, audio import/transport, department tracks, cue CRUD, offline JSON save/load.

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

## Project file sketch

Single JSON file for Phase 0 (folder package + media copy lands later):

```json
{
  "project": {
    "schemaVersion": 1,
    "name": "Untitled Show",
    "settings": { "bpm": 120, "fps": "25", "...": "..." },
    "departments": [],
    "cues": [],
    "media": { "name": "track.wav", "durationSec": 600 }
  }
}
```

Canonical cue time is **file-relative absolute seconds**. Show TC and musical views are Phase 1.

## License

UNLICENSED — private / proprietary until published.
