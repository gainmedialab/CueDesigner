# CueDesigner

Timecode-controlled live-show cue programmer (desktop + web). Phase 0 foundations plus Phase 1 BPM snap and absolute / show TC / musical time views: project model, audio import/transport, department tracks, cue CRUD, BPM/grid snap, offline JSON save/load with media restore.

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
| **BPM** | Project tempo as whole BPM only (integer quarter-notes / minute) |
| **Time sig** | Beats per bar / beat unit (e.g. 4/4) |
| **Downbeat** | Offset of bar 1 beat 1 from file start (seconds); shared by snap, grid, musical time, and click |
| **Snap** | Grid resolution: Bar, Beat, 1/4, 1/8, 1/16, 1/32 |
| **Magnetic snap** | When on, place/drag snaps to the grid |
| **Click** | Metronome on the beat grid while playing (downbeat accent); **Vol** sets level |
| **FPS** | Project frame rate for show TC: 23.976, 24, 25, 29.97 DF, 29.97 NDF, 30 |
| **TC offset** | Show timecode at file start (`HH:MM:SS:FF` / `;FF` for DF) |
| **Zoom** | Timeline horizontal zoom (`−` / slider / `+`); denser ruler + waveform peaks when zoomed |

**Bypass:** hold **Alt** (Option on macOS) while placing a cue or dragging to keep free timing. Timeline shows a visible grid. Settings persist in `.cueproj.json` under `project.settings` (`bpm`, `timeSignature`, `downbeatOffsetSec`, `gridResolution`, `snapEnabled`, `timelineZoom`, `metronomeEnabled`, `metronomeVolume`, `fps`, `showTcOffsetSec`).

**Timeline zoom:** **Ctrl**/⌘ + mouse wheel zooms toward the cursor; `−` / `+` / slider zoom around the playhead. When zoomed in, scroll horizontally (wheel also pans). During playback the timeline **follows the playhead** (keep-in-view). The **Follow** checkbox latches across play/pause; only the user unchecks it. Manual scroll temporarily suspends follow (checkbox stays on; **Play** or re-check resumes). The waveform redraws for the visible span at device-pixel density, keyed to the same file-relative `tAbs` as the playhead, cues, and grid. Snap and Alt free-move keep working at every zoom. Zoom is kept for the session and optionally written into the project file as `timelineZoom` (1 = fit duration).

**Keyboard shortcuts** (ignored while focus is in an input, textarea, or select):

| Key | Action |
|-----|--------|
| **Space** | Play / pause |
| **F** | Toggle **Follow** playhead |
| **C** | Toggle **Click** (metronome) |
| **G** | Zoom out (around playhead) |
| **H** | Zoom in (around playhead) |

## Time display modes (Phase 1)

Transport **Abs / TC / Mus** switches the clock, timeline ruler, cue list, and inspector together:

| Mode | Format | Notes |
|------|--------|--------|
| **Absolute** | `mm:ss.mmm` | File-relative |
| **Show TC** | `HH:MM:SS:FF` (`;FF` when DF) | Uses project **FPS** + **TC offset** |
| **Musical** | `bar.beat` / `bar.beat.sub` | From BPM, time signature, and downbeat |

Canonical storage remains **file-relative absolute seconds** (`cue.tAbs`). Editing in any mode parses back to absolute; the inspector also shows Abs · TC · musical as a cross-check.

Live LTC/MTC I/O hardware and export packs are deferred.

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
      "metronomeEnabled": false,
      "metronomeVolume": 0.5,
      "fps": "25",
      "showTcOffsetSec": 0
    },
    "departments": [],
    "cues": [],
    "media": { "name": "track.wav", "durationSec": 600, "mimeType": "audio/wav" }
  },
  "mediaDataUrl": "data:audio/wav;base64,... (optional, when ≤ 8 MiB)"
}
```

Canonical cue time is **file-relative absolute seconds**. Show TC and musical **bar.beat** are derived views (fps + TC offset; BPM + downbeat).

## License

UNLICENSED — private / proprietary until published.
