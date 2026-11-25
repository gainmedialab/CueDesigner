import {
  addDepartment,
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
  GRID_RESOLUTIONS,
  gridLineTimes,
  gridResolutionLabel,
  moveCue,
  nextDeptCueNumber,
  placeCue,
  projectDownloadBlob,
  renameDepartment,
  recolorDepartment,
  rulerMarkTimes,
  setProjectMedia,
  snapToGrid,
  touchProject,
  updateCue,
  updateSettings,
  type Cue,
  type GridResolution,
  type Project,
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
import { buildPeaks, drawPeaks, loadAudioFile } from "./audio";
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
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const [status, setStatus] = useState("New project — import audio to begin.");
  const [newDeptName, setNewDeptName] = useState("");
  const [newDeptColor, setNewDeptColor] = useState("#5b8def");

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const waveCanvasRef = useRef<HTMLCanvasElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const dragCueIdRef = useRef<string | null>(null);
  /** After zoom, restore scroll so this time stays under cursorX in the scrollport. */
  const pendingZoomAnchorRef = useRef<{ t: number; cursorX: number } | null>(
    null,
  );
  /** Current session media bytes (for save embed + IndexedDB). */
  const mediaBlobRef = useRef<Blob | null>(null);
  const mediaMetaRef = useRef<{ name: string; mimeType: string } | null>(null);
  const [scrollPortW, setScrollPortW] = useState(0);

  // Keep active department valid
  useEffect(() => {
    if (!project.departments.find((d) => d.id === activeDeptId)) {
      setActiveDeptId(project.departments[0]?.id ?? "");
    }
  }, [project.departments, activeDeptId]);

  // Audio element lifecycle
  useEffect(() => {
    const audio = new Audio();
    audio.preload = "auto";
    audioRef.current = audio;
    const onEnded = () => setPlaying(false);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.pause();
      audio.removeEventListener("ended", onEnded);
      audioRef.current = null;
    };
  }, []);

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

  // Measure timeline scrollport for denser ruler marks
  useEffect(() => {
    const el = timelineScrollRef.current;
    if (!el) return;
    const measure = () => setScrollPortW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Draw waveform on first track lane width
  useEffect(() => {
    const canvas = waveCanvasRef.current;
    if (!canvas || !peaks) return;
    drawPeaks(canvas, peaks, "#6b8caf");
    const onResize = () => drawPeaks(canvas, peaks, "#6b8caf");
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [peaks, project.departments.length, project.settings.timelineZoom]);

  const duration = project.media?.durationSec ?? 0;
  const zoom = clampTimelineZoom(project.settings.timelineZoom);

  // Keep zoom-to-cursor / zoom-around-playhead scroll anchor after layout
  useLayoutEffect(() => {
    const anchor = pendingZoomAnchorRef.current;
    const el = timelineScrollRef.current;
    if (!anchor || !el || !(duration > 0)) return;
    pendingZoomAnchorRef.current = null;
    const laneW = Math.max(1, el.scrollWidth - TRACK_LABEL_W);
    const laneX = (anchor.t / duration) * laneW;
    el.scrollLeft = Math.max(0, laneX + TRACK_LABEL_W - anchor.cursorX);
  }, [zoom, duration]);

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
          TRACK_LABEL_W + (currentTime / duration) * laneW - el.scrollLeft;
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
      const t =
        duration > 0
          ? Math.max(0, Math.min(duration, (laneX / laneW) * duration))
          : 0;
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
  }, [duration]);

  const togglePlay = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !mediaUrl) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      try {
        await audio.play();
        setPlaying(true);
      } catch (err) {
        setStatus(`Playback failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }, [mediaUrl, playing]);

  const clearPlaybackMedia = useCallback(() => {
    if (mediaUrl) URL.revokeObjectURL(mediaUrl);
    setMediaUrl(null);
    setPeaks(null);
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
      setPeaks(null);
      if (opts?.persist !== false) {
        try {
          await putProjectMedia(projectId, blob, meta);
        } catch {
          // IndexedDB optional — in-memory + embed still work this session
        }
      }
      buildPeaks(objectUrl)
        .then(setPeaks)
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
    const musical = formatMusicalPosition(tAbs, project.settings);
    setStatus(
      `Placed cue at ${formatAbsoluteTime(tAbs)} (${musical})${
        bypassSnap || !project.settings.snapEnabled ? " — free" : " — snapped"
      }`,
    );
  };

  const onLanePointer = (e: ReactPointerEvent<HTMLDivElement>, deptId: string) => {
    const lane = e.currentTarget;
    const rect = lane.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const rawT = ratio * (duration || 1);
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
    const pointerTAtStart =
      ((e.clientX - startRect.left) / startWidth) * (duration || 1);
    const grabOffsetT = pointerTAtStart - cue.tAbs;

    const onMove = (ev: PointerEvent) => {
      if (!dragCueIdRef.current) return;
      // Reject scrollport pan that can ride along with cue drag when zoomed.
      if (scrollEl && scrollEl.scrollLeft !== lockedScrollLeft) {
        scrollEl.scrollLeft = lockedScrollLeft;
      }
      const rect = lane.getBoundingClientRect();
      const width = rect.width || 1;
      const pointerT = ((ev.clientX - rect.left) / width) * (duration || 1);
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

  const playheadPct =
    duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

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
    duration > 0 ? rulerMarkTimes(duration, laneContentW || scrollPortW) : [];

  const musicalNow = formatMusicalPosition(currentTime, project.settings);
  const [sigNum, sigDen] = project.settings.timeSignature;
  const zoomLabel =
    zoom >= 10 ? `${Math.round(zoom)}×` : `${zoom.toFixed(1)}×`;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Cue<span>Designer</span>
        </div>
        <div className="meta">
          {project.name}
          {project.media ? ` · ${project.media.name}` : " · no media"}
          {` · ${project.settings.bpm} BPM · ${sigNum}/${sigDen}`}
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
        <div className="clock-block">
          <span className="clock">{formatAbsoluteTime(currentTime)}</span>
          <span className="clock-musical" title="Musical position (bar.beat)">
            {musicalNow}
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
          {formatAbsoluteTime(duration)}
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
        <label className="grid-field">
          BPM
          <input
            type="number"
            min={20}
            max={400}
            step={0.1}
            value={project.settings.bpm}
            onChange={(e) => {
              const bpm = Number(e.target.value);
              if (!Number.isFinite(bpm) || bpm <= 0) return;
              setProject((p) => updateSettings(p, { bpm }));
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
        <span className="grid-hint">
          Hold <kbd>Alt</kbd> while placing or dragging to bypass snap ·{" "}
          <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+wheel zooms to cursor
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
                <div className="ruler">
                  {rulerMarks.map((t, i) => {
                    const pct = duration > 0 ? (t / duration) * 100 : 0;
                    return (
                      <span
                        key={`${t}-${i}`}
                        className="ruler-mark"
                        style={{ left: `${pct}%` }}
                      >
                        {formatAbsoluteTime(t)}
                        <span className="ruler-musical">
                          {formatMusicalPosition(t, project.settings)}
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
                      {idx === 0 && peaks && (
                        <canvas ref={waveCanvasRef} className="waveform" />
                      )}
                      {gridLines.map((line, lineIdx) => (
                        <div
                          key={`${line.kind}-${lineIdx}-${line.t}`}
                          className={`grid-line grid-line--${line.kind}`}
                          style={{
                            left: `${duration > 0 ? (line.t / duration) * 100 : 0}%`,
                          }}
                        />
                      ))}
                      {project.cues
                        .filter((c) => c.departmentId === d.id)
                        .map((c) => {
                          const left =
                            duration > 0
                              ? `${(c.tAbs / duration) * 100}%`
                              : "0%";
                          return (
                            <div
                              key={c.id}
                              className={`cue-marker${c.id === selectedCueId ? " selected" : ""}`}
                              style={{ left, background: d.color }}
                              title={`${c.cueNoDept} ${c.label} · ${formatAbsoluteTime(c.tAbs)} · ${formatMusicalPosition(c.tAbs, project.settings)}`}
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
                    <span className="t">{formatAbsoluteTime(c.tAbs)}</span>
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
                Time (s)
                <input
                  type="number"
                  step={0.001}
                  min={0}
                  value={selectedCue.tAbs}
                  onChange={(e) =>
                    setProject((p) =>
                      touchProject({
                        ...p,
                        cues: moveCue(
                          p.cues,
                          selectedCue.id,
                          Number(e.target.value) || 0,
                        ),
                      }),
                    )
                  }
                />
              </label>
              <div className="inspector-meta">
                Musical:{" "}
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
