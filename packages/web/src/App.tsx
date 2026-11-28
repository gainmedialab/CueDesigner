import {
  addDepartment,
  clampBpm,
  clampTimelineZoom,
  createCue,
  createId,
  createProject,
  deleteCue,
  deleteDepartment,
  deleteCuesForDepartment,
  deserializeProject,
  emptySyncStatus,
  formatAbsoluteTime,
  formatMusicalPosition,
  formatTime,
  formatTimecode,
  FRAME_RATE_LABELS,
  GRID_RESOLUTIONS,
  gridLineTimes,
  gridResolutionLabel,
  lanePercentToTime,
  moveCue,
  musicalRulerMarkTimes,
  nextDeptCueNumber,
  parseTime,
  parseTimecode,
  placeCue,
  projectDownloadBlob,
  renameDepartment,
  recolorDepartment,
  rulerMarkTimes,
  setProjectMedia,
  snapToGrid,
  SYNC_CLOCK_SOURCES,
  TIME_DISPLAY_MODES,
  timeDisplayModeLabel,
  timeFieldLabel,
  timeInputPlaceholder,
  timeToLanePercent,
  touchProject,
  updateCue,
  updateSettings,
  type Cue,
  type FrameRateLabel,
  type GridResolution,
  type Project,
  type SyncClockSource,
  type SyncStatusSnapshot,
  type TimeDisplayMode,
} from "@cuedesigner/core";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Metronome,
  drawWaveform,
  estimateDownbeatOffsetSec,
  loadAudioFile,
  loadWaveformData,
  type WaveformData,
} from "./audio";
import {
  MEDIA_EMBED_MAX_BYTES,
  blobToDataUrl,
  dataUrlToBlob,
  deleteProjectMedia,
  formatBytes,
  getProjectMedia,
  putProjectMedia,
} from "./mediaStore";
import { ExportDialog } from "./ExportDialog";
import {
  TC_SEEK_DRIFT_SEC,
  TimecodeSync,
  type LtcAudioDeviceInfo,
  type MidiInputInfo,
} from "./timecodeSync";

const ACCEPT_AUDIO = ".wav,.aiff,.aif,.mp3,.m4a,.ogg,audio/*";
/** Matches `.track` label column / ruler gutter width. */
const TRACK_LABEL_W = 100;
const ZOOM_STEP = 1.25;
/** Keep playhead this fraction into the visible lane while following. */
const FOLLOW_VIEW_FRAC = 0.35;
/** Throttle waveform scroll-left React sync while following (~8 Hz). */
const FOLLOW_WAVE_SYNC_MS = 120;

/** Snap unless Alt/Option is held, or project snap is disabled. */
function applySnap(
  t: number,
  settings: Project["settings"],
  bypass: boolean,
): number {
  if (bypass || !settings.snapEnabled) return Math.max(0, t);
  return snapToGrid(t, settings);
}

export function App() {
  const [project, setProject] = useState<Project>(() => createProject("Untitled Show"));
  const [activeDeptId, setActiveDeptId] = useState<string>("");
  const [selectedCueId, setSelectedCueId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [waveform, setWaveform] = useState<WaveformData | null>(null);
  const [status, setStatus] = useState("New project — import audio to begin.");
  const [newDeptName, setNewDeptName] = useState("");
  const [newDeptColor, setNewDeptColor] = useState("#5b8def");
  /** Session UI preference — storage stays absolute seconds. */
  const [timeMode, setTimeMode] = useState<TimeDisplayMode>("absolute");
  const [inspectorTimeDraft, setInspectorTimeDraft] = useState<string | null>(
    null,
  );
  const [tcOffsetDraft, setTcOffsetDraft] = useState<string | null>(null);
  /** Local BPM field text while editing — null means show committed project BPM. */
  const [bpmDraft, setBpmDraft] = useState<string | null>(null);
  /** Scrollport scrollLeft — drives viewport waveform redraw. */
  const [timelineScrollLeft, setTimelineScrollLeft] = useState(0);
  /** User Follow preference — only the checkbox toggles this (latches across play/pause). */
  const [followPlayhead, setFollowPlayhead] = useState(true);
  /** Temporary pause after manual scroll; cleared on Play or re-checking Follow. */
  const [followSuspended, setFollowSuspended] = useState(false);
  /** Export dialog open — suspends Space/F/G/H/S/J/C while open; transport/Click unchanged. */
  const [exportOpen, setExportOpen] = useState(false);
  /** Session clock source — Internal keeps HTMLMediaElement transport untouched. */
  const [syncSource, setSyncSource] = useState<SyncClockSource>("internal");
  const [syncStatus, setSyncStatus] = useState<SyncStatusSnapshot>(() =>
    emptySyncStatus("internal"),
  );
  /** LTC input route — session only (devices are ephemeral). */
  const [ltcDevices, setLtcDevices] = useState<LtcAudioDeviceInfo[]>([]);
  const [ltcDeviceId, setLtcDeviceId] = useState<string>("");
  const [ltcChannelIndex, setLtcChannelIndex] = useState(0);
  const [ltcDevicesLoading, setLtcDevicesLoading] = useState(false);
  /** MTC MIDI input — session only. */
  const [midiInputs, setMidiInputs] = useState<MidiInputInfo[]>([]);
  const [midiInputId, setMidiInputId] = useState<string>("");
  const [midiInputsLoading, setMidiInputsLoading] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const syncRef = useRef<TimecodeSync | null>(null);
  const projectClockRef = useRef({
    fps: project.settings.fps,
    showTcOffsetSec: project.settings.showTcOffsetSec,
  });
  projectClockRef.current = {
    fps: project.settings.fps,
    showTcOffsetSec: project.settings.showTcOffsetSec,
  };
  const ltcRouteRef = useRef({ deviceId: "", channelIndex: 0 });
  ltcRouteRef.current = { deviceId: ltcDeviceId, channelIndex: ltcChannelIndex };
  const midiRouteRef = useRef({ inputId: "" });
  midiRouteRef.current = { inputId: midiInputId };
  const audioInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const waveCanvasRef = useRef<HTMLCanvasElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  /** Mirrors timelineZoom for RAF follow / programmatic scroll (updated each render). */
  const zoomRef = useRef(1);
  const rafRef = useRef<number | null>(null);
  const dragCueIdRef = useRef<string | null>(null);
  const metronomeRef = useRef<Metronome | null>(null);
  /** After zoom, restore scroll so this time stays under cursorX in the scrollport. */
  const pendingZoomAnchorRef = useRef<{ t: number; cursorX: number } | null>(
    null,
  );
  /** Ignore programmatic scrollLeft when deciding to suspend follow. */
  const suppressScrollFollowPauseRef = useRef(false);
  const followPlayheadRef = useRef(followPlayhead);
  followPlayheadRef.current = followPlayhead;
  /** Latest media/chase time — RAF follow + zoom-around-playhead read this. */
  const currentTimeRef = useRef(0);
  currentTimeRef.current = currentTime;
  const durationRef = useRef(0);
  const lastWaveScrollSyncMsRef = useRef(0);
  /** Current session media bytes (for save embed + IndexedDB). */
  const mediaBlobRef = useRef<Blob | null>(null);
  const mediaMetaRef = useRef<{ name: string; mimeType: string } | null>(null);
  const [scrollPortW, setScrollPortW] = useState(0);

  const followActive = followPlayhead && !followSuspended;
  const followActiveRef = useRef(followActive);
  followActiveRef.current = followActive;
  /** True while the RAF clock is actively chasing scroll (play / TC lock). */
  const followTransportActiveRef = useRef(false);

  const setScrollLeftProgrammatic = useCallback((left: number) => {
    const el = timelineScrollRef.current;
    if (!el) return;
    suppressScrollFollowPauseRef.current = true;
    el.scrollLeft = left;
    setTimelineScrollLeft(el.scrollLeft);
    // While RAF follow owns the scrollport, keep suppress latched so deferred
    // scroll events cannot suspend follow. Otherwise clear after a double-rAF
    // (some engines fire scroll async after assignment).
    if (followTransportActiveRef.current) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!followTransportActiveRef.current) {
          suppressScrollFollowPauseRef.current = false;
        }
      });
    });
  }, []);

  /** Direct scrollLeft follow — no React state per frame (avoids waveform thrash). */
  const applyFollowScroll = useCallback((t: number, dur: number) => {
    if (!followActiveRef.current) return;
    const zoomNow = zoomRef.current;
    if (!(zoomNow > 1) || !(dur > 0)) return;
    const el = timelineScrollRef.current;
    if (!el) return;
    const laneW = Math.max(1, el.scrollWidth - TRACK_LABEL_W);
    const playheadLaneX = (timeToLanePercent(t, dur) / 100) * laneW;
    const viewLaneW = Math.max(1, el.clientWidth - TRACK_LABEL_W);
    const targetViewX = viewLaneW * FOLLOW_VIEW_FRAC;
    const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
    const next = Math.max(
      0,
      Math.min(maxScroll, playheadLaneX - targetViewX),
    );
    if (Math.abs(el.scrollLeft - next) < 0.5) return;
    suppressScrollFollowPauseRef.current = true;
    el.scrollLeft = next;
    const now = performance.now();
    if (now - lastWaveScrollSyncMsRef.current > FOLLOW_WAVE_SYNC_MS) {
      lastWaveScrollSyncMsRef.current = now;
      setTimelineScrollLeft(el.scrollLeft);
    }
  }, []);

  // Keep active department valid
  useEffect(() => {
    if (!project.departments.find((d) => d.id === activeDeptId)) {
      setActiveDeptId(project.departments[0]?.id ?? "");
    }
  }, [project.departments, activeDeptId]);

  // Drop in-progress time drafts when the target or mode changes
  useEffect(() => {
    setInspectorTimeDraft(null);
  }, [selectedCueId, timeMode]);

  useEffect(() => {
    setTcOffsetDraft(null);
  }, [project.settings.fps, project.settings.showTcOffsetSec]);

  // Audio element + click metronome. Media uses native HTMLMediaElement (no MES).
  useEffect(() => {
    const audio = new Audio();
    audio.preload = "auto";
    audioRef.current = audio;
    const metronome = new Metronome();
    metronomeRef.current = metronome;
    metronome.setMediaTimeGetter(() => audioRef.current?.currentTime ?? 0);
    metronome.attachMediaElement(audio);
    const onEnded = () => setPlaying(false);
    const onSeeked = () => metronomeRef.current?.resync();
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("seeked", onSeeked);

    const sync = new TimecodeSync({
      getProjectFps: () => projectClockRef.current.fps,
      getShowTcOffsetSec: () => projectClockRef.current.showTcOffsetSec,
      getMidiInputId: () => midiRouteRef.current.inputId || null,
      getLtcDeviceId: () => ltcRouteRef.current.deviceId || null,
      getLtcChannelIndex: () => ltcRouteRef.current.channelIndex,
    });
    syncRef.current = sync;
    sync.onStatus((s) => setSyncStatus(s));

    return () => {
      audio.pause();
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("seeked", onSeeked);
      audioRef.current = null;
      metronome.dispose();
      metronomeRef.current = null;
      sync.dispose();
      syncRef.current = null;
    };
  }, []);

  const refreshLtcDevices = useCallback(async () => {
    setLtcDevicesLoading(true);
    try {
      const devices = await TimecodeSync.listLtcAudioDevices();
      setLtcDevices(devices);
      const prevId = ltcRouteRef.current.deviceId;
      const nextId =
        prevId && devices.some((d) => d.deviceId === prevId)
          ? prevId
          : (devices[0]?.deviceId ?? "");
      const selected =
        devices.find((d) => d.deviceId === nextId) ?? devices[0];
      const max = Math.max(1, selected?.channelCount ?? 1);
      const nextCh = Math.min(ltcRouteRef.current.channelIndex, max - 1);
      // Sync ref before any setSource / applyLtcRoute so getters see the route.
      ltcRouteRef.current = { deviceId: nextId, channelIndex: nextCh };
      setLtcDeviceId(nextId);
      setLtcChannelIndex(nextCh);
    } catch (err) {
      setStatus(
        `LTC device list failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setLtcDevicesLoading(false);
    }
  }, []);

  const refreshMidiInputs = useCallback(async () => {
    setMidiInputsLoading(true);
    try {
      const inputs = await TimecodeSync.listMidiInputs();
      setMidiInputs(inputs);
      const prevId = midiRouteRef.current.inputId;
      const nextId =
        prevId && inputs.some((i) => i.id === prevId)
          ? prevId
          : (inputs[0]?.id ?? "");
      midiRouteRef.current = { inputId: nextId };
      setMidiInputId(nextId);
    } catch (err) {
      setStatus(
        `MIDI input list failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setMidiInputsLoading(false);
    }
  }, []);

  // Switch LTC / MTC / Internal (permission prompts happen here).
  // External sync is chase-only: pause file transport immediately on leave Internal.
  useEffect(() => {
    const sync = syncRef.current;
    if (!sync) return;
    if (syncSource === "ltc" || syncSource === "mtc") {
      const audio = audioRef.current;
      if (audio) audio.pause();
      setPlaying(false);
      metronomeRef.current?.setPlaying(false);
    }
    let cancelled = false;
    void (async () => {
      if (syncSource === "ltc") {
        await refreshLtcDevices();
        if (cancelled) return;
      } else if (syncSource === "mtc") {
        await refreshMidiInputs();
        if (cancelled) return;
      }
      if (cancelled) return;
      await sync.setSource(syncSource);
    })();
    return () => {
      cancelled = true;
    };
  }, [syncSource, refreshLtcDevices, refreshMidiInputs]);

  // Keep FPS-match badge in sync when project FPS / offset changes.
  useEffect(() => {
    syncRef.current?.refreshProjectClock();
  }, [project.settings.fps, project.settings.showTcOffsetSec]);

  // Keep metronome grid / enable / volume in sync with project settings
  useEffect(() => {
    const m = metronomeRef.current;
    if (!m) return;
    m.setGrid({
      bpm: project.settings.bpm,
      timeSignature: project.settings.timeSignature,
      downbeatOffsetSec: project.settings.downbeatOffsetSec,
    });
    m.setEnabled(project.settings.metronomeEnabled);
    m.setVolume(project.settings.metronomeVolume);
  }, [
    project.settings.bpm,
    project.settings.timeSignature,
    project.settings.downbeatOffsetSec,
    project.settings.metronomeEnabled,
    project.settings.metronomeVolume,
  ]);

  // Auto-Downbeat from first strong onset when still at 0 (pickup files).
  useEffect(() => {
    if (!waveform) return;
    if (project.settings.downbeatOffsetSec > 0) return;
    const est = estimateDownbeatOffsetSec(waveform, {
      bpm: project.settings.bpm,
    });
    if (!(est > 0)) return;
    setProject((p) => {
      if (p.settings.downbeatOffsetSec > 0) return p;
      return updateSettings(p, { downbeatOffsetSec: est });
    });
  }, [waveform, project.settings.bpm, project.settings.downbeatOffsetSec]);

  useEffect(() => {
    metronomeRef.current?.setPlaying(playing);
  }, [playing]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (mediaUrl) {
      audio.src = mediaUrl;
      audio.load();
    } else {
      audio.removeAttribute("src");
      audio.load();
    }
  }, [mediaUrl]);

  // Keep project duration locked to the HTMLMediaElement playback clock so
  // playhead % / grid / heard audio share one timebase.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !mediaUrl) return;
    const syncDuration = () => {
      const d = audio.duration;
      if (!Number.isFinite(d) || !(d > 0)) return;
      setProject((p) => {
        if (!p.media) return p;
        if (Math.abs(p.media.durationSec - d) < 0.0005) return p;
        return setProjectMedia(p, { ...p.media, durationSec: d });
      });
    };
    audio.addEventListener("loadedmetadata", syncDuration);
    if (audio.readyState >= 1) syncDuration();
    return () => audio.removeEventListener("loadedmetadata", syncDuration);
  }, [mediaUrl]);

  // RAF clock: Internal follows HTMLMediaElement while playing; LTC/MTC is
  // chase-only (file stays paused) — playhead follows TC when locked/freewheel.
  // Soft-seek paused media on drift so returning to Internal resumes at chase pos.
  // Follow auto-scroll uses direct scrollLeft here (not a currentTime layout
  // effect) so we do not re-render the waveform every frame.
  useEffect(() => {
    const external = syncSource === "ltc" || syncSource === "mtc";
    const stopFollowTransport = () => {
      followTransportActiveRef.current = false;
      suppressScrollFollowPauseRef.current = false;
    };
    const tick = () => {
      const sync = syncRef.current;
      const chase = external ? sync?.sampleChase() : null;
      if (chase) {
        const t = chase.tAbs;
        currentTimeRef.current = t;
        setCurrentTime(t);
        followTransportActiveRef.current = true;
        applyFollowScroll(t, durationRef.current || 0);
        const audio = audioRef.current;
        if (audio && Number.isFinite(audio.duration) && audio.duration > 0) {
          const clamped = Math.min(Math.max(0, t), audio.duration);
          if (Math.abs(audio.currentTime - clamped) > TC_SEEK_DRIFT_SEC) {
            audio.currentTime = clamped;
          }
        }
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      const audio = audioRef.current;
      if (audio && playing && !external) {
        const t = audio.currentTime;
        currentTimeRef.current = t;
        setCurrentTime(t);
        followTransportActiveRef.current = true;
        applyFollowScroll(t, durationRef.current || audio.duration || 0);
        rafRef.current = requestAnimationFrame(tick);
      } else if (external) {
        // Waiting for lock — keep RAF alive without advancing from file clock.
        stopFollowTransport();
        rafRef.current = requestAnimationFrame(tick);
      } else {
        stopFollowTransport();
      }
    };
    if ((!external && playing) || external) {
      rafRef.current = requestAnimationFrame(tick);
    } else {
      stopFollowTransport();
    }
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      followTransportActiveRef.current = false;
    };
  }, [playing, syncSource, applyFollowScroll]);

  // Measure timeline scrollport for denser ruler marks + track scroll for waveform.
  // Manual scroll suspends follow (checkbox stays on); programmatic scrolls are ignored.
  useEffect(() => {
    const el = timelineScrollRef.current;
    if (!el) return;
    const measure = () => {
      setScrollPortW(el.clientWidth);
      setTimelineScrollLeft(el.scrollLeft);
    };
    measure();
    const onScroll = () => {
      setTimelineScrollLeft(el.scrollLeft);
      if (
        !suppressScrollFollowPauseRef.current &&
        followPlayheadRef.current
      ) {
        setFollowSuspended(true);
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, []);

  const duration = project.media?.durationSec ?? 0;
  durationRef.current = duration;
  const zoom = clampTimelineZoom(project.settings.timelineZoom);
  zoomRef.current = zoom;

  // Viewport waveform: peaks keyed to the same tAbs % as cues/grid/playhead.
  // Canvas covers only the visible lane slice so zoom keeps ~1 peak per device pixel.
  useEffect(() => {
    const canvas = waveCanvasRef.current;
    const scrollEl = timelineScrollRef.current;
    if (!canvas || !waveform || !scrollEl || !(duration > 0)) return;

    const laneW = Math.max(1, scrollEl.scrollWidth - TRACK_LABEL_W);
    // Lane scrolls under the sticky 100px label; only the uncovered slice is visible.
    const viewStartPx = Math.max(0, Math.min(laneW, timelineScrollLeft));
    const viewEndPx = Math.max(
      viewStartPx,
      Math.min(
        laneW,
        timelineScrollLeft + scrollEl.clientWidth - TRACK_LABEL_W,
      ),
    );
    const viewW = Math.max(1, viewEndPx - viewStartPx);
    canvas.style.left = `${viewStartPx}px`;
    canvas.style.width = `${viewW}px`;
    canvas.style.right = "auto";

    drawWaveform(canvas, waveform, {
      timelineDurationSec: duration,
      viewStartFrac: viewStartPx / laneW,
      viewEndFrac: viewEndPx / laneW,
      color: "#6b8caf",
    });
  }, [
    waveform,
    duration,
    zoom,
    timelineScrollLeft,
    scrollPortW,
    project.departments.length,
  ]);

  // Keep zoom-to-cursor / zoom-around-playhead scroll anchor after layout.
  // Re-read scrollWidth here (post-commit) so the new zoom width is used.
  // A second rAF pass covers engines that still report the pre-zoom
  // scrollWidth during the synchronous layout effect (seen under Electron).
  useLayoutEffect(() => {
    const anchor = pendingZoomAnchorRef.current;
    if (!anchor || !(duration > 0)) return;
    pendingZoomAnchorRef.current = null;
    const applyAnchor = () => {
      const el = timelineScrollRef.current;
      if (!el) return;
      const laneW = Math.max(1, el.scrollWidth - TRACK_LABEL_W);
      const laneX = (timeToLanePercent(anchor.t, duration) / 100) * laneW;
      setScrollLeftProgrammatic(
        Math.max(0, laneX + TRACK_LABEL_W - anchor.cursorX),
      );
    };
    applyAnchor();
    requestAnimationFrame(() => {
      applyAnchor();
    });
  }, [zoom, duration, setScrollLeftProgrammatic]);

  // Snap once when Follow becomes active (e.g. re-check / F / Play clears
  // suspension). Continuous follow runs inside the RAF clock. Do not depend
  // on zoom — the zoom-anchor layout effect owns that scroll restore.
  useLayoutEffect(() => {
    if (!followActive || zoomRef.current <= 1 || !(duration > 0)) return;
    applyFollowScroll(currentTimeRef.current, duration);
  }, [followActive, duration, applyFollowScroll]);

  const applyTimelineZoom = useCallback(
    (nextZoom: number, anchor: { t: number; cursorX: number } | null) => {
      const next = clampTimelineZoom(nextZoom);
      if (next === zoom) return;
      pendingZoomAnchorRef.current = anchor;
      setProject((p) => updateSettings(p, { timelineZoom: next }));
    },
    [zoom],
  );

  const zoomAroundPlayhead = useCallback(
    (nextZoom: number) => {
      const el = timelineScrollRef.current;
      const t = currentTimeRef.current;
      const dur = durationRef.current || duration;
      // Default: park playhead at the follow fraction of the visible lane so
      // off-screen zoom still anchors on the playhead (not viewport center).
      let cursorX = TRACK_LABEL_W;
      if (el) {
        const viewLaneW = Math.max(1, el.clientWidth - TRACK_LABEL_W);
        cursorX = TRACK_LABEL_W + viewLaneW * FOLLOW_VIEW_FRAC;
        if (dur > 0) {
          const laneW = Math.max(1, el.scrollWidth - TRACK_LABEL_W);
          const playheadViewX =
            TRACK_LABEL_W +
            (timeToLanePercent(t, dur) / 100) * laneW -
            el.scrollLeft;
          if (playheadViewX >= 0 && playheadViewX <= el.clientWidth) {
            cursorX = playheadViewX;
          }
        }
      }
      applyTimelineZoom(nextZoom, { t, cursorX });
    },
    [applyTimelineZoom, duration],
  );

  // Non-passive wheel so Ctrl/⌘+wheel can zoom without browser page-zoom.
  useEffect(() => {
    const el = timelineScrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) {
        if (zoom > 1 && Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
          e.preventDefault();
          // Explicit user pan — suspend follow even if a programmatic scroll
          // still holds the suppress flag from the prior frame.
          if (followPlayheadRef.current) setFollowSuspended(true);
          el.scrollLeft += e.deltaY;
        }
        return;
      }
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const contentX = el.scrollLeft + cursorX;
      const laneW = Math.max(1, el.scrollWidth - TRACK_LABEL_W);
      const laneX = contentX - TRACK_LABEL_W;
      const t = lanePercentToTime((laneX / laneW) * 100, duration);
      const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      applyTimelineZoom(zoom * factor, { t, cursorX });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyTimelineZoom, duration, zoom]);

  const seek = useCallback((t: number) => {
    const audio = audioRef.current;
    const clamped = Math.max(0, Math.min(t, audio?.duration || duration || 0));
    if (audio) audio.currentTime = clamped;
    setCurrentTime(clamped);
    // Immediate resync (seeked also fires); keeps click locked across scrub.
    metronomeRef.current?.resync();
  }, [duration]);

  const chaseOnly = syncSource === "ltc" || syncSource === "mtc";

  const togglePlay = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !mediaUrl) return;
    // LTC/MTC are chase-only — never start file transport from Play/Space.
    if (syncSource !== "internal") return;
    if (playing) {
      audio.pause();
      setPlaying(false);
      suppressScrollFollowPauseRef.current = false;
    } else {
      // Clear scroll suspension; checkbox preference stays latched.
      setFollowSuspended(false);
      try {
        // Start media immediately (native element). Click AudioContext resume
        // is non-blocking — never await click priming before audio.play().
        // primeFromGesture runs inside resume() under this user gesture stack.
        void metronomeRef.current?.resume();
        const playP = audio.play();
        await playP;
        setPlaying(true);
      } catch (err) {
        setStatus(`Playback failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }, [mediaUrl, playing, syncSource]);

  const togglePlayRef = useRef(togglePlay);
  togglePlayRef.current = togglePlay;
  const zoomAroundPlayheadRef = useRef(zoomAroundPlayhead);
  zoomAroundPlayheadRef.current = zoomAroundPlayhead;
  const seekRef = useRef(seek);
  seekRef.current = seek;
  const exportOpenRef = useRef(exportOpen);
  exportOpenRef.current = exportOpen;
  const chaseOnlyRef = useRef(chaseOnly);
  chaseOnlyRef.current = chaseOnly;
  const metronomeEnabledRef = useRef(project.settings.metronomeEnabled);
  metronomeEnabledRef.current = project.settings.metronomeEnabled;

  // Space / F / G / H / S / J / C — transport / grid-bar / zoom / Click paths.
  // Does not touch MES or lockToMediaClock; C only toggles enable + audition.
  useEffect(() => {
    /** Only block when the user is typing — not range/checkbox/button focus. */
    const isTextEntryTarget = (el: EventTarget | null): boolean => {
      const fromEvent = el instanceof Element ? el : null;
      const active =
        document.activeElement instanceof Element
          ? document.activeElement
          : null;
      for (const start of [fromEvent, active]) {
        if (!start) continue;
        const target = start.closest(
          "input, textarea, select, [contenteditable=true]",
        );
        if (!target) continue;
        if (target instanceof HTMLTextAreaElement) {
          if (!target.disabled && !target.readOnly) return true;
          continue;
        }
        if (target instanceof HTMLSelectElement) {
          if (!target.disabled) return true;
          continue;
        }
        if (target instanceof HTMLElement && target.isContentEditable) {
          return true;
        }
        if (target instanceof HTMLInputElement) {
          if (target.disabled || target.readOnly) continue;
          const type = (target.type || "text").toLowerCase();
          // Scrub / zoom / vol / checkboxes keep focus — still allow shortcuts.
          if (
            type === "button" ||
            type === "checkbox" ||
            type === "radio" ||
            type === "range" ||
            type === "file" ||
            type === "submit" ||
            type === "reset" ||
            type === "color" ||
            type === "hidden"
          ) {
            continue;
          }
          return true;
        }
      }
      return false;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.repeat) return;
      // Suspend transport shortcuts while Export dialog is open (Escape closes).
      if (exportOpenRef.current) {
        if (e.code === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setExportOpen(false);
        }
        return;
      }
      if (isTextEntryTarget(e.target)) return;

      // Prefer e.code so layout / modifiers don't break letter matching.
      const code = e.code;
      if (code === "Space") {
        // preventDefault stops focused <button> from also synthesizing click
        // (double toggle → Space looks dead). Chase-only Sync ignores Space.
        e.preventDefault();
        e.stopPropagation();
        if (chaseOnlyRef.current) return;
        void togglePlayRef.current();
        return;
      }
      if (code === "KeyF") {
        e.preventDefault();
        e.stopPropagation();
        setFollowPlayhead((prev) => {
          const next = !prev;
          if (next) setFollowSuspended(false);
          return next;
        });
        return;
      }
      if (code === "KeyG") {
        // Zoom out around playhead — same as − button.
        e.preventDefault();
        e.stopPropagation();
        zoomAroundPlayheadRef.current(zoomRef.current / ZOOM_STEP);
        return;
      }
      if (code === "KeyH") {
        // Zoom in around playhead — same as + button.
        e.preventDefault();
        e.stopPropagation();
        zoomAroundPlayheadRef.current(zoomRef.current * ZOOM_STEP);
        return;
      }
      if (code === "KeyS") {
        // Magnetic snap toggle — same as checkbox.
        e.preventDefault();
        e.stopPropagation();
        setProject((p) =>
          updateSettings(p, { snapEnabled: !p.settings.snapEnabled }),
        );
        return;
      }
      if (code === "KeyJ") {
        // Home — seek to start (same as transport ⇤). Chase-only: no file seek.
        e.preventDefault();
        e.stopPropagation();
        if (chaseOnlyRef.current) return;
        seekRef.current(0);
        return;
      }
      if (code === "KeyC") {
        // Toggle Click — same as checkbox; audition unlocks Web Audio on enable.
        e.preventDefault();
        e.stopPropagation();
        const on = !metronomeEnabledRef.current;
        if (on) metronomeRef.current?.auditionSync();
        setProject((p) =>
          updateSettings(p, { metronomeEnabled: on }),
        );
      }
    };

    // Capture on document so we see keys even when focus is on controls.
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const clearPlaybackMedia = useCallback(() => {
    if (mediaUrl) URL.revokeObjectURL(mediaUrl);
    setMediaUrl(null);
    setWaveform(null);
    mediaBlobRef.current = null;
    mediaMetaRef.current = null;
  }, [mediaUrl]);

  const applyMediaBlob = useCallback(
    async (
      blob: Blob,
      meta: { name: string; mimeType: string },
      projectId: string,
      opts?: { persist?: boolean },
    ) => {
      if (mediaUrl) URL.revokeObjectURL(mediaUrl);
      const objectUrl = URL.createObjectURL(blob);
      mediaBlobRef.current = blob;
      mediaMetaRef.current = meta;
      setMediaUrl(objectUrl);
      setWaveform(null);
      if (opts?.persist !== false) {
        try {
          await putProjectMedia(projectId, blob, meta);
        } catch {
          // IndexedDB optional — in-memory + embed still work this session
        }
      }
      loadWaveformData(objectUrl)
        .then(setWaveform)
        .catch(() => undefined);
      return objectUrl;
    },
    [mediaUrl],
  );

  const onImportAudio = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      setStatus(`Loading ${file.name}…`);
      const loaded = await loadAudioFile(file);
      URL.revokeObjectURL(loaded.objectUrl);
      const mimeType = loaded.mimeType;
      await applyMediaBlob(file, { name: loaded.name, mimeType }, project.id);
      setProject((p) =>
        setProjectMedia(p, {
          id: createId(),
          name: loaded.name,
          mimeType,
          durationSec: loaded.durationSec,
        }),
      );
      setCurrentTime(0);
      setPlaying(false);
      setStatus(
        `Imported ${loaded.name} (${formatAbsoluteTime(loaded.durationSec)}). Media cached offline in this browser.`,
      );
    } catch (err) {
      setStatus(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const onSaveProject = async () => {
    const touched = touchProject(project);
    let mediaDataUrl: string | undefined;
    const blob = mediaBlobRef.current;
    const meta = mediaMetaRef.current;

    if (blob && meta) {
      try {
        await putProjectMedia(touched.id, blob, meta);
      } catch {
        // continue — download may still embed
      }
      if (blob.size <= MEDIA_EMBED_MAX_BYTES) {
        try {
          mediaDataUrl = await blobToDataUrl(blob);
        } catch (err) {
          setStatus(
            `Save: could not embed media (${err instanceof Error ? err.message : String(err)}). Retry or re-import.`,
          );
          return;
        }
      }
    }

    const fileBlob = projectDownloadBlob(touched, mediaDataUrl);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(fileBlob);
    a.download = `${touched.name.replace(/[^\w.-]+/g, "_") || "show"}.cueproj.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    setProject(touched);

    if (!project.media) {
      setStatus("Project saved (download). Offline — no network used.");
    } else if (mediaDataUrl) {
      setStatus(
        `Project saved with embedded media (${formatBytes(blob!.size)}). Offline — no network used.`,
      );
    } else if (blob) {
      setStatus(
        `Project saved. Media (${formatBytes(blob.size)}) kept in this browser (IndexedDB) — not embedded (limit ${formatBytes(MEDIA_EMBED_MAX_BYTES)}). Reopen here restores playback; elsewhere re-import if needed.`,
      );
    } else {
      setStatus(
        "Project saved without media bytes. Re-import audio if playback is missing after reopen.",
      );
    }
  };

  const onOpenProject = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const { project: loaded, mediaDataUrl } = deserializeProject(text);
      setSelectedCueId(null);
      setActiveDeptId(loaded.departments[0]?.id ?? "");
      setPlaying(false);
      setCurrentTime(0);
      setProject(loaded);

      let restored = false;
      let missingPrompt = false;

      if (mediaDataUrl) {
        const mediaBlob = await dataUrlToBlob(mediaDataUrl);
        const name = loaded.media?.name ?? "audio";
        const mimeType =
          loaded.media?.mimeType || mediaBlob.type || "application/octet-stream";
        await applyMediaBlob(mediaBlob, { name, mimeType }, loaded.id);
        restored = true;
      } else {
        const stored = await getProjectMedia(loaded.id).catch(() => null);
        if (stored) {
          await applyMediaBlob(
            stored.blob,
            { name: stored.name, mimeType: stored.mimeType },
            loaded.id,
            { persist: false },
          );
          restored = true;
        } else {
          clearPlaybackMedia();
          if (loaded.media) missingPrompt = true;
        }
      }

      setStatus(
        `Opened ${loaded.name} (${loaded.cues.length} cues).${
          restored
            ? " Audio restored — play/scrub ready."
            : missingPrompt
              ? ` Media file missing (“${loaded.media!.name}”). Re-import audio to restore playback.`
              : ""
        }`,
      );
    } catch (err) {
      setStatus(`Open failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const onNewProject = () => {
    const previousId = project.id;
    clearPlaybackMedia();
    void deleteProjectMedia(previousId).catch(() => undefined);
    const p = createProject("Untitled Show");
    setProject(p);
    setActiveDeptId(p.departments[0]?.id ?? "");
    setSelectedCueId(null);
    setPlaying(false);
    setCurrentTime(0);
    setStatus("New project created.");
  };

  const placeAtPlayhead = (bypassSnap = false) => {
    if (!activeDeptId) return;
    const tAbs = applySnap(currentTime, project.settings, bypassSnap);
    const draft = createCue({
      id: createId(),
      tAbs,
      departmentId: activeDeptId,
      cueNoDept: nextDeptCueNumber(project.cues, activeDeptId),
      label: "Cue",
    });
    setProject((p) =>
      touchProject({ ...p, cues: placeCue(p.cues, draft) }),
    );
    setSelectedCueId(draft.id);
    setStatus(
      `Placed cue at ${formatTime(tAbs, timeMode, project.settings)}${
        bypassSnap || !project.settings.snapEnabled ? " — free" : " — snapped"
      }`,
    );
  };

  const onLanePointer = (e: ReactPointerEvent<HTMLDivElement>, deptId: string) => {
    const lane = e.currentTarget;
    const rect = lane.getBoundingClientRect();
    const ratio = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
    const rawT = lanePercentToTime(ratio * 100, duration || 1);
    if (e.detail === 2) {
      // double-click places cue (Alt bypasses snap)
      const tAbs = applySnap(rawT, project.settings, e.altKey);
      const draft = createCue({
        id: createId(),
        tAbs,
        departmentId: deptId,
        cueNoDept: nextDeptCueNumber(project.cues, deptId),
      });
      setProject((p) =>
        touchProject({ ...p, cues: placeCue(p.cues, draft) }),
      );
      setSelectedCueId(draft.id);
      setActiveDeptId(deptId);
      return;
    }
    seek(rawT);
    setActiveDeptId(deptId);
  };

  const onCuePointerDown = (
    e: ReactPointerEvent<HTMLDivElement>,
    cue: Cue,
  ) => {
    // Keep cue drag from seeking the lane or panning the zoomed timeline/waveform.
    e.stopPropagation();
    e.preventDefault();
    if (e.button !== 0) return;

    setSelectedCueId(cue.id);
    setActiveDeptId(cue.departmentId);
    dragCueIdRef.current = cue.id;

    const marker = e.currentTarget;
    marker.setPointerCapture(e.pointerId);

    // Map against the track-lane (cue % left), not .tracks (includes labels).
    const lane = marker.parentElement;
    if (!lane) return;

    const scrollEl = timelineScrollRef.current;
    const lockedScrollLeft = scrollEl?.scrollLeft ?? 0;

    const startRect = lane.getBoundingClientRect();
    const startWidth = startRect.width || 1;
    // Keep grab point relative to cue time so mousedown has zero delta.
    const pointerTAtStart = lanePercentToTime(
      ((e.clientX - startRect.left) / startWidth) * 100,
      duration || 1,
    );
    const grabOffsetT = pointerTAtStart - cue.tAbs;

    const onMove = (ev: PointerEvent) => {
      if (!dragCueIdRef.current) return;
      // Reject scrollport pan that can ride along with cue drag when zoomed.
      if (scrollEl && scrollEl.scrollLeft !== lockedScrollLeft) {
        suppressScrollFollowPauseRef.current = true;
        scrollEl.scrollLeft = lockedScrollLeft;
        suppressScrollFollowPauseRef.current = false;
      }
      const rect = lane.getBoundingClientRect();
      const width = rect.width || 1;
      const pointerT = lanePercentToTime(
        ((ev.clientX - rect.left) / width) * 100,
        duration || 1,
      );
      const raw = Math.max(0, Math.min(duration || 1, pointerT - grabOffsetT));
      setProject((p) => {
        const t = applySnap(raw, p.settings, ev.altKey);
        return touchProject({
          ...p,
          cues: moveCue(p.cues, dragCueIdRef.current!, t),
        });
      });
    };
    const onUp = (ev: PointerEvent) => {
      dragCueIdRef.current = null;
      if (marker.hasPointerCapture(ev.pointerId)) {
        marker.releasePointerCapture(ev.pointerId);
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const selectedCue = project.cues.find((c) => c.id === selectedCueId) ?? null;

  const playheadPct = timeToLanePercent(currentTime, duration);

  const gridLines =
    duration > 0
      ? gridLineTimes(
          project.settings,
          duration,
          Math.min(2000, Math.ceil(500 * zoom)),
        )
      : [];

  const laneContentW = Math.max(0, scrollPortW * zoom - TRACK_LABEL_W);
  const rulerMarks =
    duration > 0
      ? timeMode === "musical"
        ? musicalRulerMarkTimes(
            project.settings,
            duration,
            laneContentW || scrollPortW,
          )
        : rulerMarkTimes(duration, laneContentW || scrollPortW)
      : [];

  const clockNow = formatTime(currentTime, timeMode, project.settings);
  const clockEnd = formatTime(duration, timeMode, project.settings);
  const [sigNum, sigDen] = project.settings.timeSignature;
  const zoomLabel =
    zoom >= 10 ? `${Math.round(zoom)}×` : `${zoom.toFixed(1)}×`;
  const tcOffsetDisplay =
    tcOffsetDraft ??
    formatTimecode(project.settings.showTcOffsetSec, project.settings.fps);

  const commitInspectorTime = () => {
    if (inspectorTimeDraft == null || !selectedCueId) {
      setInspectorTimeDraft(null);
      return;
    }
    const parsed = parseTime(
      inspectorTimeDraft,
      timeMode,
      project.settings,
    );
    if (parsed != null) {
      setProject((p) =>
        touchProject({
          ...p,
          cues: moveCue(p.cues, selectedCueId, Math.max(0, parsed)),
        }),
      );
    }
    setInspectorTimeDraft(null);
  };

  const commitTcOffset = () => {
    if (tcOffsetDraft == null) return;
    const parsed = parseTimecode(tcOffsetDraft, project.settings.fps);
    if (parsed != null) {
      setProject((p) =>
        updateSettings(p, { showTcOffsetSec: Math.max(0, parsed) }),
      );
    }
    setTcOffsetDraft(null);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Cue<span>Designer</span>
        </div>
        <div className="meta">
          {project.name}
          {project.media ? ` · ${project.media.name}` : " · no media"}
          {` · ${project.settings.bpm} BPM · ${sigNum}/${sigDen} · ${project.settings.fps}`}
        </div>
        <div className="actions">
          <button type="button" onClick={onNewProject}>
            New
          </button>
          <button type="button" onClick={() => projectInputRef.current?.click()}>
            Open
          </button>
          <button type="button" onClick={onSaveProject}>
            Save
          </button>
          <button type="button" onClick={() => setExportOpen(true)}>
            Export
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => audioInputRef.current?.click()}
          >
            Import audio
          </button>
          <input
            ref={audioInputRef}
            className="file-input"
            type="file"
            accept={ACCEPT_AUDIO}
            onChange={onImportAudio}
          />
          <input
            ref={projectInputRef}
            className="file-input"
            type="file"
            accept=".json,.cueproj.json,application/json"
            onChange={onOpenProject}
          />
        </div>
      </header>

      <div className="transport">
        <button
          type="button"
          className="primary"
          onClick={togglePlay}
          disabled={!mediaUrl || chaseOnly}
          title={
            chaseOnly
              ? "File transport disabled while Sync is LTC/MTC (chase-only)"
              : undefined
          }
        >
          {playing ? "Pause" : "Play"}
        </button>
        <button type="button" onClick={() => seek(0)} disabled={!mediaUrl || chaseOnly}>
          ⇤
        </button>
        <div
          className="mode-switch"
          role="group"
          aria-label="Time display mode"
        >
          {TIME_DISPLAY_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              className={timeMode === mode ? "mode-btn active" : "mode-btn"}
              aria-pressed={timeMode === mode}
              onClick={() => setTimeMode(mode)}
              title={timeDisplayModeLabel(mode)}
            >
              {mode === "absolute"
                ? "Abs"
                : mode === "timecode"
                  ? "TC"
                  : "Mus"}
            </button>
          ))}
        </div>
        <div className="clock-block">
          <span className="clock" title={timeDisplayModeLabel(timeMode)}>
            {clockNow}
          </span>
          <span className="clock-mode-label">
            {timeDisplayModeLabel(timeMode)}
          </span>
        </div>
        <input
          className="scrub"
          type="range"
          min={0}
          max={duration || 1}
          step={0.001}
          value={Math.min(currentTime, duration || 1)}
          disabled={!mediaUrl || chaseOnly}
          title={
            chaseOnly
              ? "Scrub disabled while Sync is LTC/MTC — playhead follows TC"
              : undefined
          }
          onChange={(e) => seek(Number(e.target.value))}
        />
        <span className="clock" style={{ color: "var(--text-muted)", fontSize: "0.95rem" }}>
          {clockEnd}
        </span>
        <button
          type="button"
          onClick={(e) => placeAtPlayhead(e.altKey)}
          disabled={!activeDeptId}
          title="Place cue at playhead (hold Alt for free placement)"
        >
          Cue at playhead
        </button>
        <div className="sync-block" aria-label="Timecode sync source">
          <label className="sync-source-field">
            Sync
            <select
              value={syncSource}
              title="Internal = file clock. LTC/MTC = chase-only (Play/Space disabled)."
              aria-label="Timecode sync source"
              onChange={(e) =>
                setSyncSource(e.target.value as SyncClockSource)
              }
            >
              {SYNC_CLOCK_SOURCES.map((src) => (
                <option key={src} value={src}>
                  {src === "internal"
                    ? "Internal"
                    : src === "ltc"
                      ? "LTC"
                      : "MTC"}
                </option>
              ))}
            </select>
          </label>
          {syncSource === "ltc" ? (
            <>
              <label className="sync-source-field sync-ltc-device-field">
                Device
                <select
                  value={ltcDeviceId}
                  disabled={ltcDevicesLoading || ltcDevices.length === 0}
                  title="Audio input for LTC (includes multichannel Wing / Dante / SoundGrid)"
                  aria-label="LTC audio input device"
                  onChange={(e) => {
                    const id = e.target.value;
                    const info = ltcDevices.find((d) => d.deviceId === id);
                    const max = Math.max(1, info?.channelCount ?? 1);
                    const ch = Math.min(ltcChannelIndex, max - 1);
                    ltcRouteRef.current = { deviceId: id, channelIndex: ch };
                    setLtcDeviceId(id);
                    setLtcChannelIndex(ch);
                    void syncRef.current?.applyLtcRoute();
                  }}
                >
                  {ltcDevices.length === 0 ? (
                    <option value="">
                      {ltcDevicesLoading ? "Scanning…" : "No inputs"}
                    </option>
                  ) : (
                    ltcDevices.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label} ({d.channelCount} ch)
                      </option>
                    ))
                  )}
                </select>
              </label>
              <label className="sync-source-field">
                Ch
                <select
                  value={ltcChannelIndex}
                  disabled={ltcDevicesLoading || ltcDevices.length === 0}
                  title="Input channel carrying LTC (1-based in the label)"
                  aria-label="LTC input channel"
                  onChange={(e) => {
                    const ch = Number(e.target.value);
                    ltcRouteRef.current = {
                      deviceId: ltcDeviceId,
                      channelIndex: ch,
                    };
                    setLtcChannelIndex(ch);
                    void syncRef.current?.applyLtcRoute();
                  }}
                >
                  {Array.from(
                    {
                      length: Math.max(
                        1,
                        ltcDevices.find((d) => d.deviceId === ltcDeviceId)
                          ?.channelCount ?? 1,
                      ),
                    },
                    (_, i) => (
                      <option key={i} value={i}>
                        {i + 1}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <button
                type="button"
                className="sync-refresh-btn"
                disabled={ltcDevicesLoading}
                title="Re-enumerate audio inputs and channel counts"
                onClick={() => {
                  void (async () => {
                    await refreshLtcDevices();
                    void syncRef.current?.applyLtcRoute();
                  })();
                }}
              >
                {ltcDevicesLoading ? "…" : "↻"}
              </button>
            </>
          ) : null}
          {syncSource === "mtc" ? (
            <>
              <label className="sync-source-field sync-ltc-device-field">
                MIDI
                <select
                  value={midiInputId}
                  disabled={midiInputsLoading || midiInputs.length === 0}
                  title="MIDI input port for MTC (IAC, USB interface, desk)"
                  aria-label="MTC MIDI input"
                  onChange={(e) => {
                    const id = e.target.value;
                    midiRouteRef.current = { inputId: id };
                    setMidiInputId(id);
                    void syncRef.current?.applyMtcRoute();
                  }}
                >
                  {midiInputs.length === 0 ? (
                    <option value="">
                      {midiInputsLoading ? "Scanning…" : "No MIDI inputs"}
                    </option>
                  ) : (
                    midiInputs.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.manufacturer
                          ? `${i.name} (${i.manufacturer})`
                          : i.name}
                      </option>
                    ))
                  )}
                </select>
              </label>
              <button
                type="button"
                className="sync-refresh-btn"
                disabled={midiInputsLoading}
                title="Re-enumerate MIDI inputs"
                onClick={() => {
                  void (async () => {
                    await refreshMidiInputs();
                    void syncRef.current?.applyMtcRoute();
                  })();
                }}
              >
                {midiInputsLoading ? "…" : "↻"}
              </button>
            </>
          ) : null}
          <span
            className={`sync-status sync-lock-${syncStatus.lock}${
              syncStatus.fpsMatch ? "" : " sync-fps-mismatch"
            }`}
            title={syncStatus.detail}
          >
            <span className="sync-lock-dot" aria-hidden />
            <span className="sync-lock-label">
              {syncSource === "internal"
                ? "Internal"
                : syncStatus.lock === "locked"
                  ? "Locked"
                  : syncStatus.lock === "freewheel"
                    ? "Freewheel"
                    : syncStatus.lock === "locking"
                      ? "Locking"
                      : "Unlocked"}
            </span>
            {syncStatus.tcDisplay ? (
              <span className="sync-tc">{syncStatus.tcDisplay}</span>
            ) : null}
            {!syncStatus.fpsMatch ? (
              <span className="sync-fps-warn">FPS≠</span>
            ) : null}
          </span>
        </div>
      </div>

      <div className="grid-bar" aria-label="BPM and snap settings">
        <label className="grid-field bpm-field">
          BPM
          <input
            className="bpm-input"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={3}
            size={3}
            value={bpmDraft ?? String(project.settings.bpm)}
            title="Whole BPM only (integer). Clear and type, then Enter or blur to apply."
            aria-label="BPM"
            onChange={(e) => {
              const v = e.target.value;
              if (v !== "" && !/^\d+$/.test(v)) return;
              setBpmDraft(v);
            }}
            onBlur={() => {
              if (bpmDraft == null) return;
              const trimmed = bpmDraft.trim();
              setBpmDraft(null);
              if (trimmed === "") return;
              const raw = Number(trimmed);
              if (!Number.isFinite(raw)) return;
              setProject((p) => updateSettings(p, { bpm: clampBpm(raw) }));
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }}
          />
        </label>
        <label className="grid-field">
          Time sig
          <span className="time-sig">
            <input
              type="number"
              min={1}
              max={32}
              value={sigNum}
              aria-label="Beats per bar"
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                if (!Number.isFinite(n) || n <= 0) return;
                setProject((p) =>
                  updateSettings(p, {
                    timeSignature: [n, p.settings.timeSignature[1]],
                  }),
                );
              }}
            />
            <span>/</span>
            <input
              type="number"
              min={1}
              max={32}
              value={sigDen}
              aria-label="Beat unit"
              onChange={(e) => {
                const d = Number.parseInt(e.target.value, 10);
                if (!Number.isFinite(d) || d <= 0) return;
                setProject((p) =>
                  updateSettings(p, {
                    timeSignature: [p.settings.timeSignature[0], d],
                  }),
                );
              }}
            />
          </span>
        </label>
        <label className="grid-field">
          Downbeat
          <input
            type="number"
            min={0}
            step={0.001}
            value={project.settings.downbeatOffsetSec}
            title="Downbeat offset from file start (seconds)"
            onChange={(e) => {
              const downbeatOffsetSec = Number(e.target.value);
              if (!Number.isFinite(downbeatOffsetSec)) return;
              setProject((p) =>
                updateSettings(p, {
                  downbeatOffsetSec: Math.max(0, downbeatOffsetSec),
                }),
              );
            }}
          />
          <span className="unit">s</span>
        </label>
        <label className="grid-field">
          FPS
          <select
            value={project.settings.fps}
            title="Project frame rate for show timecode"
            onChange={(e) =>
              setProject((p) =>
                updateSettings(p, {
                  fps: e.target.value as FrameRateLabel,
                }),
              )
            }
          >
            {FRAME_RATE_LABELS.map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid-field">
          TC offset
          <input
            type="text"
            className="tc-offset-input"
            value={tcOffsetDisplay}
            spellCheck={false}
            title="Show timecode at file start (HH:MM:SS:FF)"
            placeholder="HH:MM:SS:FF"
            onChange={(e) => setTcOffsetDraft(e.target.value)}
            onBlur={commitTcOffset}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
        </label>
        <label className="grid-field">
          Snap
          <select
            value={project.settings.gridResolution}
            onChange={(e) =>
              setProject((p) =>
                updateSettings(p, {
                  gridResolution: e.target.value as GridResolution,
                }),
              )
            }
          >
            {GRID_RESOLUTIONS.map((res) => (
              <option key={res} value={res}>
                {gridResolutionLabel(res)}
              </option>
            ))}
          </select>
        </label>
        <label className="grid-field checkbox">
          <input
            type="checkbox"
            checked={project.settings.snapEnabled}
            onChange={(e) =>
              setProject((p) =>
                updateSettings(p, { snapEnabled: e.target.checked }),
              )
            }
          />
          Magnetic snap
        </label>
        <label className="grid-field checkbox">
          <input
            type="checkbox"
            checked={project.settings.metronomeEnabled}
            onChange={(e) => {
              const on = e.target.checked;
              // Unlock Web Audio under this gesture + audition so Click is audible.
              if (on) metronomeRef.current?.auditionSync();
              setProject((p) =>
                updateSettings(p, { metronomeEnabled: on }),
              );
            }}
            title="Click on the BPM beat grid while playing (accent on downbeat). Shortcut: C"
          />
          Click
        </label>
        <label className="grid-field click-vol-field">
          Vol
          <input
            className="click-vol-slider"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={project.settings.metronomeVolume}
            disabled={!project.settings.metronomeEnabled}
            title="Metronome click volume"
            aria-label="Metronome volume"
            onChange={(e) =>
              setProject((p) =>
                updateSettings(p, {
                  metronomeVolume: Number(e.target.value),
                }),
              )
            }
          />
        </label>
        <div className="grid-field zoom-field" aria-label="Timeline zoom">
          <span>Zoom</span>
          <button
            type="button"
            className="zoom-btn"
            title="Zoom out (around playhead)"
            disabled={zoom <= 1}
            onClick={() => zoomAroundPlayhead(zoom / ZOOM_STEP)}
          >
            −
          </button>
          <input
            className="zoom-slider"
            type="range"
            min={1}
            max={32}
            step={0.1}
            value={Math.min(32, zoom)}
            title="Timeline zoom"
            onChange={(e) => zoomAroundPlayhead(Number(e.target.value))}
          />
          <button
            type="button"
            className="zoom-btn"
            title="Zoom in (around playhead)"
            disabled={zoom >= 64}
            onClick={() => zoomAroundPlayhead(zoom * ZOOM_STEP)}
          >
            +
          </button>
          <span className="zoom-value" title="Timeline zoom factor">
            {zoomLabel}
          </span>
        </div>
        <label
          className={`grid-field follow-field${followSuspended && followPlayhead ? " suspended" : ""}`}
          title={
            zoom <= 1
              ? "Follow playhead (active when zoomed in)"
              : !followPlayhead
                ? "Follow off — check to enable"
                : followSuspended
                  ? "Follow paused by scroll — Play or re-check clears suspension"
                  : "Following playhead while playing / chasing"
          }
        >
          <input
            type="checkbox"
            checked={followPlayhead}
            disabled={zoom <= 1}
            onChange={(e) => {
              const on = e.target.checked;
              setFollowPlayhead(on);
              if (on) setFollowSuspended(false);
            }}
            aria-label="Follow playhead"
          />
          Follow
          {followSuspended && followPlayhead && zoom > 1 ? (
            <span className="follow-paused-hint" aria-live="polite">
              paused
            </span>
          ) : null}
        </label>
        <span className="grid-hint">
          Hold <kbd>Alt</kbd> while placing or dragging to bypass snap ·{" "}
          <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+wheel zooms to cursor ·{" "}
          <kbd>Space</kbd> play/pause (Internal Sync) · <kbd>F</kbd> follow ·{" "}
          <kbd>G</kbd> zoom out · <kbd>H</kbd> zoom in ·{" "}
          <kbd>S</kbd> snap · <kbd>J</kbd> home · <kbd>C</kbd> click
        </span>
      </div>

      <div className="workspace">
        <aside className="panel">
          <h2>Departments</h2>
          <ul className="dept-list">
            {project.departments.map((d) => (
              <li
                key={d.id}
                className={`dept-item${d.id === activeDeptId ? " active" : ""}`}
                onClick={() => setActiveDeptId(d.id)}
              >
                <span className="dept-swatch" style={{ background: d.color }} />
                <span>{d.name}</span>
                <button
                  type="button"
                  className="icon danger"
                  title="Delete department"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    setProject((p) =>
                      touchProject({
                        ...p,
                        departments: deleteDepartment(p.departments, d.id),
                        cues: deleteCuesForDepartment(p.cues, d.id),
                      }),
                    );
                    if (selectedCue?.departmentId === d.id) setSelectedCueId(null);
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <div className="dept-form">
            <input
              type="text"
              placeholder="New department"
              value={newDeptName}
              onChange={(e) => setNewDeptName(e.target.value)}
            />
            <input
              type="color"
              value={newDeptColor}
              onChange={(e) => setNewDeptColor(e.target.value)}
              aria-label="Department color"
            />
            <button
              type="button"
              onClick={() => {
                if (!newDeptName.trim()) return;
                setProject((p) => {
                  const next = addDepartment(
                    p.departments,
                    { name: newDeptName, color: newDeptColor },
                    createId,
                  );
                  setActiveDeptId(next[next.length - 1]!.id);
                  return touchProject({ ...p, departments: next });
                });
                setNewDeptName("");
              }}
            >
              Add department
            </button>
            {activeDeptId && (
              <>
                <input
                  type="text"
                  value={
                    project.departments.find((d) => d.id === activeDeptId)?.name ??
                    ""
                  }
                  onChange={(e) =>
                    setProject((p) =>
                      touchProject({
                        ...p,
                        departments: renameDepartment(
                          p.departments,
                          activeDeptId,
                          e.target.value,
                        ),
                      }),
                    )
                  }
                  aria-label="Rename active department"
                />
                <input
                  type="color"
                  value={
                    project.departments.find((d) => d.id === activeDeptId)
                      ?.color ?? "#888"
                  }
                  onChange={(e) =>
                    setProject((p) =>
                      touchProject({
                        ...p,
                        departments: recolorDepartment(
                          p.departments,
                          activeDeptId,
                          e.target.value,
                        ),
                      }),
                    )
                  }
                  aria-label="Recolor active department"
                />
              </>
            )}
          </div>
          <p className="hint">
            Double-click a track to place a cue. Hold Alt for free (unsnapped)
            placement.
          </p>
        </aside>

        <main className="timeline-wrap">
          <div className="timeline-scroll" ref={timelineScrollRef}>
            <div
              className="timeline-content"
              style={{ width: `${zoom * 100}%` }}
            >
              <div className="ruler-row">
                <div className="ruler-gutter" aria-hidden />
                <div className="ruler" data-mode={timeMode}>
                  {rulerMarks.map((t, i) => {
                    const pct = timeToLanePercent(t, duration);
                    return (
                      <span
                        key={`${t}-${i}`}
                        className="ruler-mark"
                        style={{ left: `${pct}%` }}
                      >
                        <span className="ruler-mark-label">
                          {formatTime(t, timeMode, project.settings)}
                        </span>
                      </span>
                    );
                  })}
                </div>
              </div>
              <div className="tracks">
                {project.departments.map((d, idx) => (
                  <div className="track" key={d.id}>
                    <div className="track-label">
                      <span
                        className="dept-swatch"
                        style={{ background: d.color }}
                      />
                      {d.name}
                    </div>
                    <div
                      className="track-lane"
                      onPointerDown={(e) => onLanePointer(e, d.id)}
                    >
                      {idx === 0 && waveform && (
                        <canvas ref={waveCanvasRef} className="waveform" />
                      )}
                      {gridLines.map((line, lineIdx) => (
                        <div
                          key={`${line.kind}-${lineIdx}-${line.t}`}
                          className={`grid-line grid-line--${line.kind}`}
                          style={{
                            left: `${timeToLanePercent(line.t, duration)}%`,
                          }}
                        />
                      ))}
                      {project.cues
                        .filter((c) => c.departmentId === d.id)
                        .map((c) => {
                          const left = `${timeToLanePercent(c.tAbs, duration)}%`;
                          return (
                            <div
                              key={c.id}
                              className={`cue-marker${c.id === selectedCueId ? " selected" : ""}`}
                              style={{ left, background: d.color }}
                              title={`${c.cueNoDept} ${c.label} · ${formatTime(c.tAbs, timeMode, project.settings)}`}
                              onPointerDown={(e) => onCuePointerDown(e, c)}
                            />
                          );
                        })}
                      <div
                        className="playhead"
                        style={{ left: `${playheadPct}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </main>

        <aside className="panel">
          <h2>Cues</h2>
          <ul className="cue-list">
            {[...project.cues]
              .sort((a, b) => a.ordinalGlobal - b.ordinalGlobal)
              .map((c) => {
                const dept = project.departments.find((d) => d.id === c.departmentId);
                return (
                  <li
                    key={c.id}
                    className={`cue-row${c.id === selectedCueId ? " selected" : ""}`}
                    onClick={() => {
                      setSelectedCueId(c.id);
                      seek(c.tAbs);
                    }}
                  >
                    <span className="t">
                      {formatTime(c.tAbs, timeMode, project.settings)}
                    </span>
                    <span className="label">
                      <span style={{ color: dept?.color }}>{dept?.name ?? "?"}</span>
                      {" · "}
                      {c.cueNoDept} {c.label}
                    </span>
                  </li>
                );
              })}
          </ul>
          {selectedCue && (
            <div className="inspector">
              <h2>Inspector</h2>
              <label>
                Label
                <input
                  type="text"
                  value={selectedCue.label}
                  onChange={(e) =>
                    setProject((p) =>
                      touchProject({
                        ...p,
                        cues: updateCue(p.cues, selectedCue.id, {
                          label: e.target.value,
                        }),
                      }),
                    )
                  }
                />
              </label>
              <label>
                Dept cue #
                <input
                  type="text"
                  value={selectedCue.cueNoDept}
                  onChange={(e) =>
                    setProject((p) =>
                      touchProject({
                        ...p,
                        cues: updateCue(p.cues, selectedCue.id, {
                          cueNoDept: e.target.value,
                        }),
                      }),
                    )
                  }
                />
              </label>
              <label>
                Note
                <input
                  type="text"
                  value={selectedCue.note ?? ""}
                  onChange={(e) =>
                    setProject((p) =>
                      touchProject({
                        ...p,
                        cues: updateCue(p.cues, selectedCue.id, {
                          note: e.target.value,
                        }),
                      }),
                    )
                  }
                />
              </label>
              <label>
                {timeFieldLabel(timeMode)}
                <input
                  type="text"
                  spellCheck={false}
                  value={
                    inspectorTimeDraft ??
                    formatTime(selectedCue.tAbs, timeMode, project.settings)
                  }
                  placeholder={timeInputPlaceholder(timeMode)}
                  onChange={(e) => setInspectorTimeDraft(e.target.value)}
                  onBlur={commitInspectorTime}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                />
              </label>
              <div className="inspector-meta">
                Abs {formatAbsoluteTime(selectedCue.tAbs)}
                {" · "}
                TC{" "}
                {formatTime(selectedCue.tAbs, "timecode", project.settings)}
                {" · "}
                {formatMusicalPosition(selectedCue.tAbs, project.settings)}
              </div>
              <button
                type="button"
                onClick={() =>
                  setProject((p) =>
                    touchProject({
                      ...p,
                      cues: moveCue(
                        p.cues,
                        selectedCue.id,
                        snapToGrid(selectedCue.tAbs, p.settings),
                      ),
                    }),
                  )
                }
              >
                Snap to grid
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  setProject((p) =>
                    touchProject({
                      ...p,
                      cues: deleteCue(p.cues, selectedCue.id),
                    }),
                  );
                  setSelectedCueId(null);
                }}
              >
                Delete cue
              </button>
            </div>
          )}
        </aside>
      </div>

      <footer className="footer">
        <span>{status}</span>
        {" · "}
        <span className="safety">
          Planning and export only. This software does not arm, enable, or fire
          pyrotechnic or SFX hardware.
        </span>
      </footer>

      <ExportDialog
        project={project}
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        onStatus={setStatus}
      />
    </div>
  );
}
