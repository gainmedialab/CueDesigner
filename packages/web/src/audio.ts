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
 * visually pins peaks to the grid while desyncing them from heard audio.
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
 *
 * Media stays on native HTMLMediaElement speakers (no MediaElementSource —
 * MES hijacks element output and has caused total silence regressions).
 * Clicks use a dedicated AudioContext → master GainNode → destination with
 * peak-normalized AudioBuffer bursts.
 *
 * Call `resume()` from the Play / Click user gesture so the click context
 * leaves the suspended state before ticks are scheduled.
 */
export class Metronome {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private clickBufHigh: AudioBuffer | null = null;
  private clickBufLow: AudioBuffer | null = null;
  private timer: number | null = null;
  private schedulerEpoch = 0;
  /** True while startScheduler's async begin is in flight. */
  private startInflight = false;
  private resumeInflight: Promise<void> | null = null;
  private nextBeatIndex = 0;
  private enabled = false;
  private volume = 0.85;
  private playing = false;
  private grid: MetronomeGrid = {
    bpm: 120,
    timeSignature: [4, 4],
    downbeatOffsetSec: 0,
  };
  private getMediaTime: () => number = () => 0;
  private pendingSources: AudioBufferSourceNode[] = [];
  private scheduledBeats = new Set<number>();
  private readonly scheduleHorizonSec = 0.4;
  /** Diagnostics: successful src.start() count. */
  clicksStarted = 0;

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    const was = this.enabled;
    this.enabled = on;
    this.applyMasterGain();
    if (!on) {
      this.stopScheduler();
      return;
    }
    if (this.playing && (!was || (this.timer == null && !this.startInflight))) {
      this.startScheduler();
    }
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    this.applyMasterGain();
  }

  setGrid(grid: MetronomeGrid): void {
    this.grid = {
      ...grid,
      bpm: Number.isFinite(grid.bpm) && grid.bpm > 0 ? Math.round(grid.bpm) : 120,
    };
    this.nextBeatIndex = this.beatIndexAt(this.getMediaTime());
  }

  setMediaTimeGetter(fn: () => number): void {
    this.getMediaTime = fn;
  }

  /** No-op: track audio stays on the element (never create MediaElementSource). */
  attachMediaElement(_audio: HTMLMediaElement): void {
    // intentionally unused
  }

  /**
   * Transport play/pause. Call after `await resume()` and preferably after
   * `audio.play()` so currentTime is live. Pause only stops the click
   * scheduler — never mutes media (media is not on this graph).
   */
  setPlaying(playing: boolean): void {
    if (this.playing === playing) {
      if (
        playing &&
        this.enabled &&
        this.timer == null &&
        !this.startInflight
      ) {
        this.startScheduler();
      }
      return;
    }
    this.playing = playing;
    if (playing) {
      this.applyMasterGain();
      if (this.enabled) this.startScheduler();
    } else {
      this.stopScheduler();
    }
  }

  /**
   * Under a user gesture: create/resume the click AudioContext and build
   * buffers. Does not touch the media element.
   */
  async resume(): Promise<void> {
    if (this.resumeInflight) return this.resumeInflight;
    this.resumeInflight = (async () => {
      const ctx = this.getOrCreateCtx();
      this.ensureClickBuffers(ctx);
      if (ctx.state !== "running") {
        await ctx.resume();
      }
      // Second resume helps Safari if the first returned before running.
      if (ctx.state !== "running") {
        await ctx.resume();
      }
      this.applyMasterGain();
    })().finally(() => {
      this.resumeInflight = null;
    });
    return this.resumeInflight;
  }

  /** Clear pending clicks and reset beat cursor from live media time. */
  lockToMediaClock(): void {
    this.clearPending();
    this.scheduledBeats.clear();
    this.nextBeatIndex = this.beatIndexAt(this.getMediaTime());
  }

  /** @deprecated Prefer lockToMediaClock. */
  resync(): void {
    this.lockToMediaClock();
  }

  /**
   * Fire one immediate click on the click bus (proves destination under the
   * same gesture). Used on Play when Click is on, and when enabling mid-play.
   */
  async audition(): Promise<void> {
    await this.resume();
    if (!this.ctx || !this.master || !this.clickBufHigh) return;
    if (this.ctx.state !== "running") await this.ctx.resume();
    this.applyMasterGain();
    // Temporarily open the bus even if enable races React state.
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(Math.max(this.volume, 0.85), now);
    this.fireBuffer(this.clickBufHigh, now + 0.02, 1);
    // Restore enabled-gated gain after the audition sample.
    window.setTimeout(() => this.applyMasterGain(), 80);
  }

  dispose(): void {
    this.stopScheduler();
    this.clearPending();
    this.scheduledBeats.clear();
    try {
      this.master?.disconnect();
    } catch {
      // already disconnected
    }
    this.master = null;
    this.clickBufHigh = null;
    this.clickBufLow = null;
    const ctx = this.ctx;
    this.ctx = null;
    this.resumeInflight = null;
    this.startInflight = false;
    if (ctx) void ctx.close();
  }

  private getOrCreateCtx(): AudioContext {
    if (!this.ctx) {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      this.ensureClickBuffers(this.ctx);
    }
    return this.ctx;
  }

  private ensureClickBuffers(ctx: AudioContext): void {
    if (this.clickBufHigh && this.clickBufLow) return;
    this.clickBufHigh = this.makeClickBuffer(ctx, 1600, 1);
    this.clickBufLow = this.makeClickBuffer(ctx, 1000, 0.9);
  }

  /**
   * Hot click sample: bright sine + noise transient, peak-normalized to ~1.
   * Loud enough to cut through a dense track on a separate AudioContext.
   */
  private makeClickBuffer(
    ctx: AudioContext,
    freqHz: number,
    peak: number,
  ): AudioBuffer {
    const sr = ctx.sampleRate;
    const dur = 0.06;
    const len = Math.max(1, Math.floor(sr * dur));
    const buf = ctx.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);
    let maxAbs = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const env = Math.exp(-t * 48);
      const click =
        Math.sin(2 * Math.PI * freqHz * t) * 0.8 +
        Math.sin(2 * Math.PI * freqHz * 2 * t) * 0.2;
      const noise = i < sr * 0.003 ? (Math.random() * 2 - 1) * 0.45 : 0;
      const s = (click + noise) * env;
      data[i] = s;
      const a = Math.abs(s);
      if (a > maxAbs) maxAbs = a;
    }
    if (maxAbs > 1e-6) {
      const scale = peak / maxAbs;
      for (let i = 0; i < len; i++) data[i]! *= scale;
    }
    return buf;
  }

  /**
   * Master stays at volume whenever Click is enabled (even while paused).
   * Pause never mutes this bus via a separate path — only `enabled` gates it.
   */
  private applyMasterGain(): void {
    if (!this.master || !this.ctx) return;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.enabled ? this.volume : 0, now);
  }

  private beatDurationSec(): number {
    const bpmRaw = this.grid.bpm > 0 ? this.grid.bpm : 120;
    const bpm = Math.round(bpmRaw);
    const den = this.grid.timeSignature[1] > 0 ? this.grid.timeSignature[1] : 4;
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
    const epoch = this.schedulerEpoch;
    this.startInflight = true;
    const begin = async () => {
      try {
        if (epoch !== this.schedulerEpoch) return;
        if (!this.playing || !this.enabled) return;
        await this.resume();
        if (epoch !== this.schedulerEpoch) return;
        if (!this.playing || !this.enabled || !this.ctx) return;
        if (this.ctx.state !== "running") {
          await this.ctx.resume();
        }
        if (epoch !== this.schedulerEpoch) return;
        this.scheduledBeats.clear();
        this.nextBeatIndex = this.beatIndexAt(this.getMediaTime());
        this.applyMasterGain();
        if (this.timer != null) {
          clearInterval(this.timer);
          this.timer = null;
        }
        this.timer = window.setInterval(() => this.tick(), 25);
        this.tick();
      } finally {
        if (epoch === this.schedulerEpoch) this.startInflight = false;
      }
    };
    void begin();
  }

  private stopScheduler(): void {
    this.schedulerEpoch += 1;
    this.startInflight = false;
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.clearPending();
    this.scheduledBeats.clear();
    // Do NOT mute master here — pause must not zero the click bus; enabled flag
    // and scheduling gate sound. Media is never on this graph.
  }

  private clearPending(): void {
    for (const src of this.pendingSources) {
      try {
        src.onended = null;
        src.stop();
      } catch {
        // already stopped
      }
      try {
        src.disconnect();
      } catch {
        // already disconnected
      }
    }
    this.pendingSources = [];
  }

  private tick(): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || !this.enabled || !this.playing) return;
    if (ctx.state !== "running") {
      void ctx.resume();
      return;
    }

    const beatSec = this.beatDurationSec();
    if (!(beatSec > 0)) return;

    const mediaNow = this.getMediaTime();
    if (!Number.isFinite(mediaNow)) return;

    const origin = this.grid.downbeatOffsetSec || 0;
    const bpb = this.beatsPerBar();
    const want = this.beatIndexAt(mediaNow);
    if (this.nextBeatIndex < want - 1 || this.nextBeatIndex > want + 8) {
      this.nextBeatIndex = want;
    }
    const until = mediaNow + this.scheduleHorizonSec;
    const ctxNow = ctx.currentTime;

    while (true) {
      const beatIndex = this.nextBeatIndex;
      const tAbs = origin + beatIndex * beatSec;
      if (tAbs > until) break;
      if (tAbs < 0 || tAbs < mediaNow - 0.002) {
        this.nextBeatIndex += 1;
        if (this.nextBeatIndex > 1e7) break;
        continue;
      }
      const when = ctxNow + (tAbs - mediaNow);
      if (when > ctxNow + this.scheduleHorizonSec + 0.05) break;
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
    if (!ctx || !this.master) return;
    this.ensureClickBuffers(ctx);

    if (this.scheduledBeats.has(beatIndex)) return;
    if (when < ctx.currentTime - 0.002) return;

    const buf = downbeat ? this.clickBufHigh : this.clickBufLow;
    if (!buf) return;

    this.scheduledBeats.add(beatIndex);
    const level = downbeat ? 1 : 0.75;
    this.fireBuffer(buf, Math.max(when, ctx.currentTime), level);
  }

  private fireBuffer(
    buf: AudioBuffer,
    when: number,
    level: number,
  ): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;

    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    gain.gain.value = level;
    src.buffer = buf;
    src.connect(gain);
    gain.connect(master);
    this.pendingSources.push(src);
    this.clicksStarted += 1;
    try {
      src.start(when);
      src.stop(when + buf.duration + 0.01);
    } catch {
      this.clicksStarted -= 1;
      return;
    }
    src.onended = () => {
      const i = this.pendingSources.indexOf(src);
      if (i >= 0) this.pendingSources.splice(i, 1);
      try {
        src.disconnect();
        gain.disconnect();
      } catch {
        // already disconnected
      }
    };
  }
}
