import {
  addDepartment,
  createCue,
  createId,
  createProject,
  deleteCue,
  deleteDepartment,
  deleteCuesForDepartment,
  deserializeProject,
  formatAbsoluteTime,
  moveCue,
  nextDeptCueNumber,
  placeCue,
  projectDownloadBlob,
  renameDepartment,
  recolorDepartment,
  setProjectMedia,
  touchProject,
  updateCue,
  type Cue,
  type Project,
} from "@cuedesigner/core";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { buildPeaks, drawPeaks, loadAudioFile } from "./audio";

const ACCEPT_AUDIO = ".wav,.aiff,.aif,.mp3,.m4a,.ogg,audio/*";

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
  const laneRef = useRef<HTMLDivElement>(null);
  const waveCanvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const dragCueIdRef = useRef<string | null>(null);

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

  // Draw waveform on first track lane width
  useEffect(() => {
    const canvas = waveCanvasRef.current;
    if (!canvas || !peaks) return;
    drawPeaks(canvas, peaks, "#6b8caf");
    const onResize = () => drawPeaks(canvas, peaks, "#6b8caf");
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [peaks, project.departments.length]);

  const duration = project.media?.durationSec ?? 0;

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

  const onImportAudio = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      setStatus(`Loading ${file.name}…`);
      if (mediaUrl) URL.revokeObjectURL(mediaUrl);
      const loaded = await loadAudioFile(file);
      setMediaUrl(loaded.objectUrl);
      setPeaks(null);
      setProject((p) =>
        setProjectMedia(p, {
          id: createId(),
          name: loaded.name,
          mimeType: loaded.mimeType,
          durationSec: loaded.durationSec,
        }),
      );
      setCurrentTime(0);
      setPlaying(false);
      setStatus(`Imported ${loaded.name} (${formatAbsoluteTime(loaded.durationSec)})`);
      // Peaks async — non-blocking
      buildPeaks(loaded.objectUrl)
        .then(setPeaks)
        .catch(() => setStatus((s) => `${s} (waveform unavailable)`));
    } catch (err) {
      setStatus(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const onSaveProject = () => {
    const blob = projectDownloadBlob(touchProject(project));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${project.name.replace(/[^\w.-]+/g, "_") || "show"}.cueproj.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    setProject((p) => touchProject(p));
    setStatus("Project saved (download). Offline — no network used.");
  };

  const onOpenProject = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const { project: loaded, mediaDataUrl } = deserializeProject(text);
      if (mediaUrl) URL.revokeObjectURL(mediaUrl);
      setProject(loaded);
      setSelectedCueId(null);
      setActiveDeptId(loaded.departments[0]?.id ?? "");
      setPlaying(false);
      setCurrentTime(0);
      setPeaks(null);
      if (mediaDataUrl) {
        setMediaUrl(mediaDataUrl);
        buildPeaks(mediaDataUrl).then(setPeaks).catch(() => undefined);
      } else {
        setMediaUrl(null);
      }
      setStatus(
        `Opened ${loaded.name} (${loaded.cues.length} cues).${
          loaded.media && !mediaDataUrl
            ? " Re-import media to restore playback (path refs only)."
            : ""
        }`,
      );
    } catch (err) {
      setStatus(`Open failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const onNewProject = () => {
    if (mediaUrl) URL.revokeObjectURL(mediaUrl);
    const p = createProject("Untitled Show");
    setProject(p);
    setActiveDeptId(p.departments[0]?.id ?? "");
    setSelectedCueId(null);
    setMediaUrl(null);
    setPeaks(null);
    setPlaying(false);
    setCurrentTime(0);
    setStatus("New project created.");
  };

  const placeAtPlayhead = () => {
    if (!activeDeptId) return;
    const draft = createCue({
      id: createId(),
      tAbs: currentTime,
      departmentId: activeDeptId,
      cueNoDept: nextDeptCueNumber(project.cues, activeDeptId),
      label: "Cue",
    });
    setProject((p) =>
      touchProject({ ...p, cues: placeCue(p.cues, draft) }),
    );
    setSelectedCueId(draft.id);
    setStatus(`Placed cue at ${formatAbsoluteTime(currentTime)}`);
  };

  const onLanePointer = (e: ReactPointerEvent<HTMLDivElement>, deptId: string) => {
    const lane = e.currentTarget;
    const rect = lane.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const t = ratio * (duration || 1);
    if (e.detail === 2) {
      // double-click places cue
      const draft = createCue({
        id: createId(),
        tAbs: t,
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
    seek(t);
    setActiveDeptId(deptId);
  };

  const onCuePointerDown = (
    e: ReactPointerEvent<HTMLDivElement>,
    cue: Cue,
  ) => {
    e.stopPropagation();
    setSelectedCueId(cue.id);
    setActiveDeptId(cue.departmentId);
    dragCueIdRef.current = cue.id;
    const lane = laneRef.current;
    const onMove = (ev: PointerEvent) => {
      if (!lane || !dragCueIdRef.current) return;
      const rect = lane.getBoundingClientRect();
      const ratio = (ev.clientX - rect.left) / rect.width;
      const t = Math.max(0, Math.min(1, ratio)) * (duration || 1);
      setProject((p) =>
        touchProject({
          ...p,
          cues: moveCue(p.cues, dragCueIdRef.current!, t),
        }),
      );
    };
    const onUp = () => {
      dragCueIdRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const selectedCue = project.cues.find((c) => c.id === selectedCueId) ?? null;

  const playheadPct =
    duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Cue<span>Designer</span>
        </div>
        <div className="meta">
          {project.name}
          {project.media ? ` · ${project.media.name}` : " · no media"}
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
        <span className="clock">{formatAbsoluteTime(currentTime)}</span>
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
        <button type="button" onClick={placeAtPlayhead} disabled={!activeDeptId}>
          Cue at playhead
        </button>
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
          <p className="hint">Double-click a track to place a cue.</p>
        </aside>

        <main className="timeline-wrap">
          <div className="ruler" style={{ marginLeft: 100 }}>
            {duration > 0 &&
              Array.from({ length: Math.min(12, Math.ceil(duration / 10) + 1) }, (_, i) => {
                const t = (i / Math.max(1, Math.ceil(duration / 10))) * duration;
                const pct = duration > 0 ? (t / duration) * 100 : 0;
                return (
                  <span key={i} className="ruler-mark" style={{ left: `${pct}%` }}>
                    {formatAbsoluteTime(t)}
                  </span>
                );
              })}
          </div>
          <div className="tracks" ref={laneRef}>
            {project.departments.map((d, idx) => (
              <div className="track" key={d.id}>
                <div className="track-label">
                  <span className="dept-swatch" style={{ background: d.color }} />
                  {d.name}
                </div>
                <div
                  className="track-lane"
                  onPointerDown={(e) => onLanePointer(e, d.id)}
                >
                  {idx === 0 && peaks && (
                    <canvas ref={waveCanvasRef} className="waveform" />
                  )}
                  {project.cues
                    .filter((c) => c.departmentId === d.id)
                    .map((c) => {
                      const left =
                        duration > 0 ? `${(c.tAbs / duration) * 100}%` : "0%";
                      return (
                        <div
                          key={c.id}
                          className={`cue-marker${c.id === selectedCueId ? " selected" : ""}`}
                          style={{ left, background: d.color }}
                          title={`${c.cueNoDept} ${c.label}`}
                          onPointerDown={(e) => onCuePointerDown(e, c)}
                        />
                      );
                    })}
                  <div className="playhead" style={{ left: `${playheadPct}%` }} />
                </div>
              </div>
            ))}
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
