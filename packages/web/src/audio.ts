/** Decode an audio File to an HTMLAudioElement-ready object URL + duration. */
export async function loadAudioFile(file: File): Promise<{
  objectUrl: string;
  durationSec: number;
  mimeType: string;
  name: string;
}> {
  const objectUrl = URL.createObjectURL(file);
  const durationSec = await probeDuration(objectUrl);
  return {
    objectUrl,
    durationSec,
    mimeType: file.type || guessMime(file.name),
    name: file.name,
  };
}

function guessMime(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".aiff") || lower.endsWith(".aif")) return "audio/aiff";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  return "application/octet-stream";
}

function probeDuration(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    audio.preload = "metadata";
    const onMeta = () => {
      cleanup();
      resolve(Number.isFinite(audio.duration) ? audio.duration : 0);
    };
    const onErr = () => {
      cleanup();
      reject(new Error("Failed to read audio metadata"));
    };
    const cleanup = () => {
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("error", onErr);
    };
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("error", onErr);
    audio.src = url;
  });
}

/** Decoded mono (or first-channel) PCM for time-accurate waveform peaks. */
export interface WaveformData {
  channel: Float32Array;
  sampleRate: number;
  /** Decoded buffer length in seconds (may differ slightly from HTMLMediaElement). */
  bufferDurationSec: number;
}

/** Decode audio bytes once; peaks are derived later against timeline tAbs. */
export async function loadWaveformData(
  objectUrl: string,
): Promise<WaveformData> {
  const res = await fetch(objectUrl);
  const buf = await res.arrayBuffer();
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(buf.slice(0));
    const channel = decoded.getChannelData(0);
    return {
      channel,
      sampleRate: decoded.sampleRate,
      bufferDurationSec: decoded.duration,
    };
  } finally {
    await ctx.close();
  }
}

/**
 * Peak buckets for a file-relative time span [startSec, endSec).
 * Sample indices use `t * sampleRate` so peaks match heard PCM / HTMLMediaElement
 * playback time (same tAbs as playhead). Do not stretch by lane duration — that
 * visually pins peaks to the grid while desyncing them from audio.
 */
export function peaksForTimeSpan(
  wave: WaveformData,
  startSec: number,
  endSec: number,
  buckets: number,
  _timelineDurationSec?: number,
): Float32Array {
  const n = Math.max(1, Math.floor(buckets));
  const peaks = new Float32Array(n);
  const span = endSec - startSec;
  if (!(span > 0) || wave.channel.length === 0) return peaks;

  const { channel, sampleRate } = wave;
  const len = channel.length;

  for (let i = 0; i < n; i++) {
    const t0 = startSec + (i / n) * span;
    const t1 = startSec + ((i + 1) / n) * span;
    let s0 = Math.floor(t0 * sampleRate);
    let s1 = Math.floor(t1 * sampleRate);
    if (s1 <= s0) s1 = s0 + 1;
    if (s0 >= len) {
      peaks[i] = 0;
      continue;
    }
    s0 = Math.max(0, s0);
    s1 = Math.min(len, s1);
    let max = 0;
    for (let j = s0; j < s1; j++) {
      const v = Math.abs(channel[j]!);
      if (v > max) max = v;
    }
    peaks[i] = max;
  }
  return peaks;
}

/**
 * Draw waveform into a canvas that covers a lane time span [startSec, endSec)
 * mapped to the full canvas width — same % mapping as cues/grid (`t / duration`).
 * Bucket count tracks CSS pixels (× devicePixelRatio) for dense peaks when zoomed.
 */
export function drawWaveform(
  canvas: HTMLCanvasElement,
  wave: WaveformData,
  opts: {
    /** Timeline duration (project media / playhead timebase), seconds. */
    timelineDurationSec: number;
    /** Lane-local left of this canvas as a fraction of full lane [0,1]. */
    viewStartFrac: number;
    /** Lane-local right of this canvas as a fraction of full lane [0,1]. */
    viewEndFrac: number;
    color: string;
  },
): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!(w > 0) || !(h > 0)) return;

  canvas.width = Math.max(1, Math.floor(w * dpr));
  canvas.height = Math.max(1, Math.floor(h * dpr));
  const g = canvas.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const dur = opts.timelineDurationSec;
  if (!(dur > 0)) return;

  const startSec = Math.max(0, opts.viewStartFrac) * dur;
  const endSec = Math.min(1, Math.max(opts.viewStartFrac, opts.viewEndFrac)) * dur;
  // ~1 bucket per device pixel keeps transients sharp when zoomed.
  const buckets = Math.max(1, Math.ceil(w * dpr));
  const peaks = peaksForTimeSpan(wave, startSec, endSec, buckets, dur);

  g.fillStyle = opts.color;
  const mid = h / 2;
  const n = peaks.length;
  const barW = Math.max(1, w / n);
  for (let i = 0; i < n; i++) {
    const x = (i / n) * w;
    const amp = peaks[i]! * mid;
    g.fillRect(x, mid - amp, barW, amp * 2);
  }
}

/** @deprecated Prefer loadWaveformData + drawWaveform (time-accurate). */
export async function buildPeaks(
  objectUrl: string,
  buckets = 512,
): Promise<Float32Array> {
  const wave = await loadWaveformData(objectUrl);
  return peaksForTimeSpan(wave, 0, wave.bufferDurationSec, buckets);
}

/** @deprecated Prefer drawWaveform. */
export function drawPeaks(
  canvas: HTMLCanvasElement,
  peaks: Float32Array,
  color: string,
): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.max(1, Math.floor(w * dpr));
  canvas.height = Math.max(1, Math.floor(h * dpr));
  const g = canvas.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.fillStyle = color;
  const mid = h / 2;
  const n = peaks.length;
  for (let i = 0; i < n; i++) {
    const x = (i / n) * w;
    const amp = peaks[i]! * mid;
    g.fillRect(x, mid - amp, Math.max(1, w / n), amp * 2);
  }
}

// --- Metronome (BPM grid click) ------------------------------------------------

export interface MetronomeGrid {
  bpm: number;
  timeSignature: [number, number];
  downbeatOffsetSec: number;
}

/**
 * Schedules short clicks on the musical beat grid while media plays.
 * Accent on bar downbeats. Times use the same origin as snap/grid (`downbeatOffsetSec`).
 *
 * Clock model: route the HTMLMediaElement through the same AudioContext as the
 * click synth (MediaElementSource), and convert media tAbs → context time via a
 * stable media/ctx anchor captured on play/seek.
 *
 * Important:
 * - Create the AudioContext + MediaElementSource lazily on the first user-gesture
 *   `resume()` (not on mount). A suspended context with a live MediaElementSource
 *   is a common source of mute/glitch on play.
 * - Never disconnect/reconnect the MediaElementSource during the session.
 * - Do not re-anchor on small `currentTime` quanta — HTMLMediaElement.currentTime
 *   jumps in ~50–250ms steps; a tight drift threshold cancels pending clicks and
 *   makes the metronome sound severely out of sync / glitchy.
 */
export class Metronome {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private mediaSource: MediaElementAudioSourceNode | null = null;
  private mediaEl: HTMLMediaElement | null = null;
  private timer: number | null = null;
  private nextBeatIndex = 0;
  private enabled = false;
  private volume = 0.5;
  private playing = false;
  private grid: MetronomeGrid = {
    bpm: 120,
    timeSignature: [4, 4],
    downbeatOffsetSec: 0,
  };
  private getMediaTime: () => number = () => 0;
  /** Media time at last anchor capture. */
  private anchorMedia = 0;
  /** AudioContext.currentTime at last anchor capture. */
  private anchorCtx = 0;
  private anchored = false;
  private pendingOsc: OscillatorNode[] = [];
  /** Beat indices already scheduled for this play/seek window (dedupe). */
  private scheduledBeats = new Set<number>();
  private readonly lookAheadSec = 0.1;
  private readonly scheduleHorizonSec = 0.35;
  /**
   * Re-anchor only on real seeks/stalls — must stay well above typical
   * HTMLMediaElement.currentTime quantization (~50–250ms).
   */
  private readonly driftResyncSec = 0.22;

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.stopScheduler();
    else if (this.playing) this.startScheduler();
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(
        this.volume,
        this.ctx.currentTime,
        0.02,
      );
    }
  }

  setGrid(grid: MetronomeGrid): void {
    this.grid = {
      ...grid,
      bpm: Number.isFinite(grid.bpm) && grid.bpm > 0 ? Math.round(grid.bpm) : 120,
    };
    // Resync beat index from current media time on next tick
    this.nextBeatIndex = this.beatIndexAt(this.estimatedMediaTime());
  }

  setMediaTimeGetter(fn: () => number): void {
    this.getMediaTime = fn;
  }

  /**
   * Remember the media element. Graph wiring happens on `resume()` so the
   * AudioContext is created under a user gesture and is not left suspended
   * with a MediaElementSource attached at page load.
   */
  attachMediaElement(audio: HTMLMediaElement): void {
    this.mediaEl = audio;
  }

  /** Call when transport play/pause changes. */
  setPlaying(playing: boolean): void {
    this.playing = playing;
    if (playing) {
      if (this.enabled) this.startScheduler();
    } else {
      this.stopScheduler();
    }
  }

  /**
   * Ensure shared AudioContext + MediaElementSource exist and the context is
   * running. Call from a user gesture *before* `audio.play()` so the track is
   * never audible through the element default path, then stolen mid-note.
   */
  async resume(): Promise<void> {
    const ctx = this.getOrCreateCtx();
    this.ensureMediaRouted(ctx);
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
  }

  /** Call after seeks (and when media currentTime jumps) so clicks re-lock. */
  resync(): void {
    this.clearPending();
    this.scheduledBeats.clear();
    this.captureAnchor();
    this.nextBeatIndex = this.beatIndexAt(this.estimatedMediaTime());
  }

  dispose(): void {
    this.stopScheduler();
    this.clearPending();
    this.scheduledBeats.clear();
    try {
      this.mediaSource?.disconnect();
    } catch {
      // already disconnected
    }
    this.mediaSource = null;
    this.mediaEl = null;
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    this.anchored = false;
    if (ctx) void ctx.close();
  }

  private getOrCreateCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  /** Create MediaElementSource once; never reconnect during the session. */
  private ensureMediaRouted(ctx: AudioContext): void {
    if (!this.mediaEl || this.mediaSource) return;
    this.mediaSource = ctx.createMediaElementSource(this.mediaEl);
    this.mediaSource.connect(ctx.destination);
  }

  private captureAnchor(): void {
    if (!this.ctx) return;
    this.anchorMedia = this.getMediaTime();
    this.anchorCtx = this.ctx.currentTime;
    this.anchored = true;
  }

  /** Smooth media-time estimate from the AudioContext clock. */
  private estimatedMediaTime(): number {
    if (!this.ctx || !this.anchored) return this.getMediaTime();
    return this.anchorMedia + (this.ctx.currentTime - this.anchorCtx);
  }

  /** Map a media (file-relative) time onto AudioContext.currentTime. */
  private mediaToCtx(tMedia: number): number {
    if (!this.ctx || !this.anchored) return this.ctx?.currentTime ?? 0;
    return this.anchorCtx + (tMedia - this.anchorMedia);
  }

  private beatDurationSec(): number {
    const bpmRaw = this.grid.bpm > 0 ? this.grid.bpm : 120;
    const bpm = Math.round(bpmRaw);
    const den = this.grid.timeSignature[1] > 0 ? this.grid.timeSignature[1] : 4;
    // Same as core beatDurationSec: quarter-note BPM × (4/denominator).
    return (60 / bpm) * (4 / den);
  }

  private beatsPerBar(): number {
    const n = this.grid.timeSignature[0];
    return n > 0 ? n : 4;
  }

  private beatIndexAt(tAbs: number): number {
    const beatSec = this.beatDurationSec();
    if (!(beatSec > 0)) return 0;
    const origin = this.grid.downbeatOffsetSec || 0;
    return Math.ceil((tAbs - origin) / beatSec - 1e-9);
  }

  private startScheduler(): void {
    this.stopScheduler();
    void this.resume().then(() => {
      if (!this.playing || !this.enabled) return;
      this.scheduledBeats.clear();
      this.captureAnchor();
      this.nextBeatIndex = this.beatIndexAt(this.estimatedMediaTime());
      this.timer = window.setInterval(() => this.tick(), 25);
      this.tick();
    });
  }

  private stopScheduler(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.clearPending();
    this.scheduledBeats.clear();
    this.anchored = false;
  }

  private clearPending(): void {
    for (const osc of this.pendingOsc) {
      try {
        osc.stop();
      } catch {
        // already stopped
      }
      try {
        osc.disconnect();
      } catch {
        // already disconnected
      }
    }
    this.pendingOsc = [];
  }

  private tick(): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || !this.enabled || !this.playing) return;

    const beatSec = this.beatDurationSec();
    if (!(beatSec > 0)) return;

    // Re-anchor only on large jumps (seek / stall). Small currentTime quanta
    // must not clear pending oscillators — that was the severe click desync.
    const reported = this.getMediaTime();
    if (this.anchored) {
      const est = this.estimatedMediaTime();
      if (Math.abs(reported - est) > this.driftResyncSec) {
        this.clearPending();
        this.scheduledBeats.clear();
        this.captureAnchor();
        this.nextBeatIndex = this.beatIndexAt(this.estimatedMediaTime());
      }
    } else {
      this.captureAnchor();
      this.nextBeatIndex = this.beatIndexAt(this.estimatedMediaTime());
    }

    const origin = this.grid.downbeatOffsetSec || 0;
    const bpb = this.beatsPerBar();
    const mediaNow = this.estimatedMediaTime();
    const want = this.beatIndexAt(mediaNow);
    if (this.nextBeatIndex < want - 1 || this.nextBeatIndex > want + 4) {
      this.nextBeatIndex = want;
    }
    const until = mediaNow + this.scheduleHorizonSec;
    const ctxHorizon =
      ctx.currentTime + this.lookAheadSec + this.scheduleHorizonSec;

    while (true) {
      const beatIndex = this.nextBeatIndex;
      const tAbs = origin + beatIndex * beatSec;
      if (tAbs > until) break;
      if (tAbs < 0 || tAbs < mediaNow - 0.002) {
        this.nextBeatIndex += 1;
        if (this.nextBeatIndex > 1e7) break;
        continue;
      }
      const when = this.mediaToCtx(tAbs);
      // Not yet in the schedule window — wait; do not skip the beat.
      if (when > ctxHorizon) break;
      const beatInBar = ((beatIndex % bpb) + bpb) % bpb;
      this.scheduleClick(when, beatInBar === 0, beatIndex);
      this.nextBeatIndex += 1;
      if (this.nextBeatIndex > 1e7) break;
    }
  }

  private scheduleClick(
    when: number,
    downbeat: boolean,
    beatIndex: number,
  ): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;

    if (this.scheduledBeats.has(beatIndex)) return;
    // Skip clicks that would fire in the past (avoid late "catch-up" blips).
    if (when < ctx.currentTime - 0.002) return;

    this.scheduledBeats.add(beatIndex);

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = downbeat ? 1200 : 800;
    const peak = downbeat ? 1 : 0.55;
    const t0 = Math.max(when, ctx.currentTime);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.045);
    osc.connect(gain);
    gain.connect(master);
    this.pendingOsc.push(osc);
    osc.start(t0);
    osc.stop(t0 + 0.05);
    osc.onended = () => {
      const i = this.pendingOsc.indexOf(osc);
      if (i >= 0) this.pendingOsc.splice(i, 1);
      try {
        osc.disconnect();
        gain.disconnect();
      } catch {
        // already disconnected
      }
    };
  }
}
