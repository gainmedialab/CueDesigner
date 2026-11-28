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

Build the web UI first, then run the shell unpackaged:

```bash
npm run build
npm run start -w @cuedesigner/electron
```

Dev against the Vite server:

```bash
# terminal 1
npm run dev:web
# terminal 2
CUEDESIGNER_DEV_URL=http://localhost:5173 npm run dev:electron
```

### Package a macOS DMG / zip

Requires a **macOS** host. Builds core + web, copies the renderer into the Electron package, then runs electron-builder:

```bash
npm run package:mac
```

Artifacts land in `packages/electron/release/` (`.app` inside the DMG, plus a `.zip`). Local builds are unsigned for show-floor testing — see [`packages/electron/README.md`](packages/electron/README.md) for signing / notarization env vars and universal binaries.

## Typecheck

```bash
npm run typecheck
```

## Phase 0 capabilities

- **Project:** New / Open / Save offline `.cueproj.json` (no network)
- **Audio:** Import WAV / AIFF / MP3 (and common browser-decodable formats); play / pause / scrub
- **Departments:** Seeded defaults (Pyro/SFX, Lighting, Audio, Cameras) + add / rename / recolour / delete
- **Cues:** Place at playhead or double-click track; select, drag-move, edit, delete
- **Cue numbering:** Primary **per-department** numbers (decimals allowed, e.g. Lighting `5.1`, Pyro `12`); **global ordinal** is the auto show-order index from absolute time (master list / SM). Place / copy / multi-dept assign the next whole number per department. Timeline markers + cue list show the dept number; list and inspector show `#ordinal`. Exports (MagicQ / grandMA / SFX / generic) lead with dept numbers.
- **Multi-dept:** Check **Place on** departments then **N** / Cue at playhead creates one cue per checked dept; **Copy to…** duplicates selected cue(s) onto other departments (same time, new per-dept numbers)
- **Shell:** Electron loads the same web UI / schema on macOS

## Shell chrome (transport hierarchy)

The default Edit / Show Mode shell keeps **Play · clock · scrub · Next countdown · Cue at playhead** on the primary transport row. Secondary controls use progressive disclosure (macOS HIG–aligned) via trailing chips — **Sync**, **Gen**, **Loop**, **Grid** — each opening one exclusive drawer. Armed / locked / generating states stay visible on the chips when drawers are closed. Keyboard shortcuts live in a **?** help popover (also **?** / Shift+/); **Esc** dismisses drawers and help. Intended for desktop / Electron at ~1280px+; not a mobile layout pass.

**File menu (HIG):** New / Open / Open Shared / Save / Share / Export live under **File** — native application menu in Electron (with ⌘/Ctrl accelerators), in-app **File** dropdown on web. Topbar chrome keeps **Edit Mode / Show Mode** and primary **Import audio**.

## BPM + magnetic snap (Phase 1)

Open the **Grid** drawer from the transport trailing chips:

| Control | What it does |
|---------|----------------|
| **BPM** | Project tempo as whole BPM only (integer quarter-notes / minute) |
| **Time sig** | Beats per bar / beat unit (e.g. 4/4) |
| **Downbeat** | Offset of bar 1 beat 1 from file start (seconds); shared by snap, grid, musical time, and click |
| **Snap** | Grid resolution: Bar, Beat, 1/4, 1/8, 1/16, 1/32 |
| **Magnetic snap** | When on, place/drag snaps to the grid |
| **Click** | Web Audio metronome on the beat grid while playing (downbeat accent); **Vol** sets level. Enabling Click auditions a tick and unlocks the click context (does not route media through MediaElementSource) |
| **FPS** | Project frame rate for show TC: 23.976, 24, 25, 29.97 DF, 29.97 NDF, 30 |
| **TC offset** | Show timecode at file start (`HH:MM:SS:FF` / `;FF` for DF) |
| **Zoom** | Timeline horizontal zoom (`−` / slider / `+`); denser ruler + waveform peaks when zoomed |

**Bypass:** hold **Alt** (Option on macOS) while placing a cue or dragging to keep free timing. Timeline shows a visible grid. Settings persist in `.cueproj.json` under `project.settings` (`bpm`, `timeSignature`, `downbeatOffsetSec`, `gridResolution`, `snapEnabled`, `timelineZoom`, `metronomeEnabled`, `metronomeVolume`, `fps`, `showTcOffsetSec`).

**Keyboard shortcuts** (ignored while typing in inputs; no Ctrl/⌘/Alt chords). Open **?** in the transport row for the same list:

| Key | Action |
|-----|--------|
| **Space** | Play / pause (same path as the transport button) |
| **F** | Toggle Follow playhead (clears scroll suspension when turning on) |
| **G** | Zoom out around playhead (same as −) |
| **H** | Zoom in around playhead (same as +) |
| **S** | Toggle Magnetic snap |
| **J** | Home — seek playhead to start (same as transport ⇤) |
| **C** | Toggle Click metronome (auditions a tick when turning on) |
| **N** | Place cue at playhead on every **Place on** department (same as **Cue at playhead**; **Alt+N** = free / unsnapped) |
| **I** | Set rehearsal loop **In (A)** at playhead |
| **O** | Set rehearsal loop **Out (B)** at playhead |
| **L** | Toggle rehearsal loop arm (wrap B→A while playing) |
| **?** | Toggle shortcut help popover |
| **Esc** | Close shell drawers / help popover |
| ⌘/Ctrl-click | Multi-select cues (for **Copy to…** / multi-delete) |

## Rehearsal loop + countdown (Phase 1)

**Loop** drawer from the transport trailing chips (Internal Sync only — LTC/MTC chase does not wrap file audio):

| Control | What it does |
|---------|----------------|
| **A–B** | Manual In/Out. Set **In** / **Out** at the playhead (**I** / **O**), arm **Loop** (**L**). While playing, wrap from B → A. |
| **Pause loop** | Play a take, then **Pause** / **Space** — captures play-start → pause as A–B and arms Loop automatically. |
| **Clear** | Clears In/Out and disarms Loop. |
| Timeline | Green **A** / orange **B** markers + shaded region when both points are set. |

**Countdown to next cue** sits in the transport row (Next −mm:ss.mmm + dept / cue label / hit time). Updates live while playing or scrubbing. Scope selector:

| Scope | Cues considered |
|-------|-----------------|
| **All depts** | Every cue after the playhead |
| **Active dept** | Only the highlighted department |
| **Place on** | Only departments checked under Place on |

**Timeline zoom:** **Ctrl**/⌘ + mouse wheel zooms toward the cursor; `−` / `+` / slider / **G**/**H** zoom around the playhead. When zoomed in, scroll horizontally (wheel also pans). During Internal playback or LTC/MTC chase the timeline **follows the playhead** when **Follow** is on (playhead kept ~35% into the visible lane). The checkbox latches across play/pause; manual scroll temporarily suspends follow (checkbox stays on; **Play** or re-check clears suspension). The waveform redraws for the visible span at device-pixel density, keyed to the same file-relative `tAbs` as the playhead, cues, and grid. Snap and Alt free-move keep working at every zoom. Zoom is kept for the session and optionally written into the project file as `timelineZoom` (1 = fit duration).

## Time display modes (Phase 1)

Transport **Abs / TC / Mus** switches the clock, timeline ruler, cue list, and inspector together:

| Mode | Format | Notes |
|------|--------|--------|
| **Absolute** | `mm:ss.mmm` | File-relative |
| **Show TC** | `HH:MM:SS:FF` (`;FF` when DF) | Uses project **FPS** + **TC offset** |
| **Musical** | `bar.beat` / `bar.beat.sub` | From BPM, time signature, and downbeat |

Canonical storage remains **file-relative absolute seconds** (`cue.tAbs`). Editing in any mode parses back to absolute; the inspector also shows Abs · TC · musical as a cross-check.

## Live timecode sync (LTC / MTC chase)

Open the **Sync** drawer (trailing chip shows lock state when collapsed). **Sync** selects the show clock source:

| Source | Path | Notes |
|--------|------|--------|
| **Internal** | HTMLMediaElement file clock | Default. Smooth Play/Pause/Space/scrub; Click metronome unchanged. |
| **LTC** | Web Audio `getUserMedia` / `enumerateDevices` → bi-phase LTC decode | **Chase-only.** Pick **Device** + **Ch** (probes channel counts for multichannel Wing / Dante / SoundGrid / aggregates). LTC is not monitored to speakers. |
| **MTC** | Web MIDI quarter-frame + full-frame SysEx | **Chase-only.** Pick **MIDI** input port (IAC / USB / desk); **↻** re-scans. |

**Chase-only rules (LTC/MTC):** switching away from Internal **pauses** file audio immediately. **Play / Pause / Space** (and scrub / home) are disabled — the playhead follows decoded show TC minus **TC offset** when **Locked** (or briefly **Freewheel** over dropouts). Unlocked external sources hold the last playhead (no file transport). Soft-seek keeps paused media aligned so returning to Internal resumes at the chase position. **FPS≠** warns when the stream rate disagrees with project **FPS**.

**LTC device picker:** Sync → LTC requests permission, enumerates `audioinput` devices, and probes each with `channelCount: { ideal: 64 }` plus `getCapabilities` / `getSettings` so high channel-count interfaces show as e.g. `Dante Virtual Soundcard (64 ch)`. Choose the channel that carries LTC (desk LTC out, console card, etc.). **↻** re-scans after hot-plug.

**MTC MIDI picker:** Sync → MTC requests Web MIDI access, lists input ports (`requestMIDIAccess` → `inputs`), and binds the selected port for quarter-frame / full-frame SysEx. Use an IAC loopback or a USB MIDI interface from the desk. **↻** re-scans after hot-plug.

No native Electron MIDI addon in this slice — Chromium Web MIDI + Web Audio cover Mac-first desktop and web.

### Generate (outgoing TC)

Open the **Gen** drawer (chip shows Disarmed / Armed / Generating). **Generate** is independent of Sync chase (arm/disarm does not tear down LTC/MTC input).

| Flavour | Path | Notes |
|---------|------|--------|
| **LTC out** | Dedicated Web Audio `AudioContext` + `setSinkId` + `ChannelMerger` | Transport-locked: emits only while **Internal** transport is **playing** and **Arm** is on. Pick **Out** device + **Ch**. Uses project **FPS** + **TC offset**. |
| **MTC out** | Web MIDI `MIDIOutput.send` quarter-frames (`0xF1`) | Same transport-locked arm model. Pick **MIDI** output port (IAC / USB / desk). Switching flavour disarms the previous backend so only one outgoing clock is live. |

**Safety:** Generate stays **disarmed** by default. LTC uses its own AudioContext (not the show-media path) — prefer a dedicated TC feed (BlackHole, Dante, interface card) and **never** route LTC into FOH or cue monitors (**LTC ≠ FOH**). MTC targets only the selected MIDI out (**MTC → MIDI**). When Sync is LTC/MTC chase, file Play is disabled so generate is silent (still transport-locked).

## Show exports (export-only)

Use the top-bar **Export** button. Downloads stay on the machine (browser download / Electron). No bidirectional sync and no live desk GO.

| Format | File | Console / controller ingest |
|--------|------|------------------------------|
| **MagicQ cuelist CSV** | `*_MagicQ.csv` | Reaper-style markers (`#,Name,Start,…`). Cue Stack → **TC View** → **Import TC Timings** → Make Cues. Match MagicQ frame type to project **FPS**. |
| **grandMA3 macro + TC** | `*_grandMA3_macro.xml` | Import into Macros pool and run once. Scaffolds DataPool sequences (one per department), empty cues, and timecode Goto events. Looks stay on the desk. Set sequence / timecode pool slots in the dialog. |
| **grandMA2 TC CSV** | `*_grandMA2_TC.csv` | Best-effort Reaper-style TC CSV for MA2 plugin / marker workflows. Prefer the MA3 macro when available. |
| **SFX / Finale CSV** | `*_SFX_Finale.csv` | Tab-delimited Finale firing-script CSV (event time, prefire, module/pin, label) for FireControl G3–style import. Optional cue `fields`: `prefireSec`, `module`/`rail`, `pin`, `position`, `hazard`. |
| **Generic CSV / TAB** | `*_cues.csv` / `*_cues.tsv` | Neutral columns: dept, cue no, abs / show TC / musical, fade, note, BPM, FPS. |

Dialog options: multi-format select, department filter, optional one-file-per-department (MagicQ / MA2). Selecting **more than one format** downloads a single `*_exports.zip` (browsers block rapid multi-file clicks); one format downloads that file alone. Pyro/SFX exports require an acknowledgement checkbox — planning data only; the app does not arm or fire hardware.

**How to test (quick):** New project → import audio → place a few cues on Lighting + Pyro/SFX → set FPS / TC offset → **Export** → download MagicQ + grandMA3 + SFX + Generic → open CSVs in a text editor; confirm TC times match Show TC mode; import MagicQ CSV on a MagicQ PC (Import TC Timings); import the MA3 XML macro on grandMA3 onPC and run it into an empty range.

## Save / Open and media (offline-first)

CueDesigner never uploads project or audio data. Everything stays on the machine (browser download + IndexedDB, or the same Chromium store inside Electron).

| Action | What happens |
|--------|----------------|
| **Import audio** | Bytes stay in memory for the session and are cached in **IndexedDB** keyed by `project.id`. |
| **Save** | Downloads a `.cueproj.json`. If media is ≤ **8 MiB**, bytes are embedded as `mediaDataUrl` (portable reopen anywhere). Larger files are **not** embedded; they remain in IndexedDB so **Open in the same browser/Electron profile** still restores playback. |
| **Open** | Restores cues from JSON, then reloads audio from embedded `mediaDataUrl` if present, otherwise from IndexedDB for that project id. Play / scrub work when media is found. If the project references media but neither source has it, the UI prompts clearly to **re-import** that file. |
| **New** | Clears session media and drops the previous project's IndexedDB media entry. |

## Team file sharing (MVP — offline packages)

Sharing is **file-based** (USB / NAS / Drive / Dropbox). No accounts, no realtime multiplayer.

| Action | What happens |
|--------|----------------|
| **Share** | Downloads a portable `ShowName.cueproj.zip` with `project.json`, optional `media/<track>`, and `README.txt` (how to open + conflict guidance). Media is packed at full size when loaded in the session (no 8 MiB embed cap). |
| **Open shared** | Picks a `.cueproj.zip` / `.zip`, restores cues + settings, and reloads packed media when present. If media is missing, the status line prompts **Import audio**. Enters **Show Mode** by default (honor `preferShowMode` in `project.json`). |

**Handoff rules:** prefer one show master; Share → send zip → teammate Open shared. Do not edit the same cloud-synced file from two machines at once (last writer wins). Local **Save** / **Open** (`.cueproj.json`) stay unchanged for single-operator work.

## Show Mode (edits locked)

Floor / SM / desk use: lock destructive programming while keeping operate tools.

| Mode | Behavior |
|------|----------|
| **Show Mode** | Blocks create/move/delete cues, Copy to…, department add/rename/recolour/delete, BPM/grid/FPS/TC-offset edits, New, Import audio. **N** / double-click place / cue drag blocked. Banner: **Show Mode — edits locked**. |
| **Still allowed** | Transport, Follow, zoom, time-display mode, Sync chase, Generate arm, rehearsal loop / countdown, Click, Save / Share / Export, Open / Open shared. |
| **Toggle** | Top-bar **Edit Mode** / **Show Mode** button. Exit asks for confirm. Banner **Exit to Edit Mode** does the same. |
| **Open shared** | Defaults to Show Mode. Package `preferShowMode: false` opens in Edit Mode. Local **Open** (`.cueproj.json`) stays Edit Mode. |

```bash
npm run test:show-mode
```

```text
My_Show.cueproj.zip
  project.json     # same schema as .cueproj.json (no mediaDataUrl)
  media/track.wav  # when session media was available
  README.txt       # open steps + conflict guidance
```

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
