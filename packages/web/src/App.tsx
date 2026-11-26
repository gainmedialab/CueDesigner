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

const ACCEPT_AUDIO = ".wav,.aiff,.aif,.mp3,.m4a,.ogg,audio/*";
/** Matches `.track` label column / ruler gutter width. */
const TRACK_LABEL_W = 100;
const ZOOM_STEP = 1.25;

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

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const waveCanvasRef = useRef<HTMLCanvasElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
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
  /** Current session media bytes (for save embed + IndexedDB). */
  const mediaBlobRef = useRef<Blob | null>(null);
  const mediaMetaRef = useRef<{ name: string; mimeType: string } | null>(null);
  const [scrollPortW, setScrollPortW] = useState(0);

  const setScrollLeftProgrammatic = useCallback((left: number) => {
    const el = timelineScrollRef.current;
    if (!el) return;
    suppressScrollFollowPauseRef.current = true;
    el.scrollLeft = left;
    setTimelineScrollLeft(el.scrollLeft);
    // Hold suppress across deferred scroll events (some engines fire async).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        suppressScrollFollowPauseRef.current = false;
      });
    });
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
    return () => {
      audio.pause();
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("seeked", onSeeked);
      audioRef.current = null;
      metronome.dispose();
      metronomeRef.current = null;
    };
  }, []);

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

  // RAF clock while playing
  useEffect(() => {
    const tick = () => {
      const audio = audioRef.current;
      if (audio && playing) {
        setCurrentTime(audio.currentTime);
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    if (playing) {
      rafRef.current = requestAnimationFrame(tick);
    }
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [playing]);

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
  const zoom = clampTimelineZoom(project.settings.timelineZoom);

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

  // Keep zoom-to-cursor / zoom-around-playhead scroll anchor after layout
  useLayoutEffect(() => {
    const anchor = pendingZoomAnchorRef.current;
    const el = timelineScrollRef.current;
    if (!anchor || !el || !(duration > 0)) return;
    pendingZoomAnchorRef.current = null;
    const laneW = Math.max(1, el.scrollWidth - TRACK_LABEL_W);
    const laneX = (timeToLanePercent(anchor.t, duration) / 100) * laneW;
    setScrollLeftProgrammatic(
      Math.max(0, laneX + TRACK_LABEL_W - anchor.cursorX),
    );
  }, [zoom, duration, setScrollLeftProgrammatic]);

  // Follow auto-scroll during play intentionally omitted in this baseline
  // restore (pre-shortcut). The currentTime→useLayoutEffect follow path from
  // 35c6e11 caused per-frame React/waveform thrash. Checkbox still latches.

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
      let cursorX = (el?.clientWidth ?? 0) / 2;
      if (el && duration > 0) {
        const laneW = Math.max(1, el.scrollWidth - TRACK_LABEL_W);
        const playheadViewX =
          TRACK_LABEL_W +
          (timeToLanePercent(currentTime, duration) / 100) * laneW -
          el.scrollLeft;
        if (playheadViewX >= 0 && playheadViewX <= el.clientWidth) {
          cursorX = playheadViewX;
        }
      }
      applyTimelineZoom(nextZoom, { t: currentTime, cursorX });
    },
    [applyTimelineZoom, currentTime, duration],
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

  const togglePlay = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !mediaUrl) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      // Clear scroll suspension; checkbox preference stays latched.
      setFollowSuspended(false);
      try {
        // Start media immediately (native element). Click AudioContext resume
        // is non-blocking — never await click priming before audio.play().
        const playP = audio.play();
        void metronomeRef.current?.resume();
        await playP;
        setPlaying(true);
      } catch (err) {
        setStatus(`Playback failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }, [mediaUrl, playing]);

  const togglePlayRef = useRef(togglePlay);
  togglePlayRef.current = togglePlay;
  const zoomAroundPlayheadRef = useRef(zoomAroundPlayhead);
  zoomAroundPlayheadRef.current = zoomAroundPlayhead;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const seekRef = useRef(seek);
  seekRef.current = seek;

  // Space / F / G / H / S / J — transport / grid-bar / zoom paths.
  // Does not touch Click scheduling, MES, or lockToMediaClock.
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
      if (isTextEntryTarget(e.target)) return;

      // Prefer e.code so layout / modifiers don't break letter matching.
      const code = e.code;
      if (code === "Space") {
        // preventDefault stops focused <button> from also synthesizing click
        // (double toggle → Space looks dead).
        e.preventDefault();
        e.stopPropagation();
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
        // Home — seek to start (same as transport ⇤).
        e.preventDefault();
        e.stopPropagation();
        seekRef.current(0);
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
        <button type="button" className="primary" onClick={togglePlay} disabled={!mediaUrl}>
          {playing ? "Pause" : "Play"}
        </button>
        <button type="button" onClick={() => seek(0)} disabled={!mediaUrl}>
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
          disabled={!mediaUrl}
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
            onChange={(e) =>
              setProject((p) =>
                updateSettings(p, { metronomeEnabled: e.target.checked }),
              )
            }
            title="Click on the BPM beat grid while playing (accent on downbeat)"
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
              ? "Follow playhead (keep preference; auto-scroll deferred)"
              : !followPlayhead
                ? "Follow off — check to enable"
                : followSuspended
                  ? "Follow preference paused by scroll — Play clears suspension"
                  : "Follow preference on (auto-scroll during play deferred)"
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
          <kbd>Space</kbd> play/pause · <kbd>F</kbd> follow ·{" "}
          <kbd>G</kbd> zoom out · <kbd>H</kbd> zoom in ·{" "}
          <kbd>S</kbd> snap · <kbd>J</kbd> home
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
    </div>
  );
}
