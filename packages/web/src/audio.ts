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

/** Deterministic mono click PCM (peak-normalized). Short = low CPU. */
function synthesizeClickPcm(
  sampleRate: number,
  freqHz: number,
  peak: number,
  durSec = 0.036,
): Float32Array {
  const n = Math.max(1, Math.floor(sampleRate * durSec));
  const pcm = new Float32Array(n);
  let maxAbs = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-t * 70);
    const tone =
      Math.sin(2 * Math.PI * freqHz * t) * 0.85 +
      Math.sin(2 * Math.PI * freqHz * 2 * t) * 0.15;
    // Tiny transient noise for perceived attack (deterministic LCG).
    const noise =
      i < sampleRate * 0.0015
        ? (((i * 1103515245 + 12345) & 0xffff) / 0xffff) * 0.5 - 0.25
        : 0;
    const s = (tone + noise) * env;
    pcm[i] = s;
    const a = Math.abs(s);
    if (a > maxAbs) maxAbs = a;
  }
  const scale = maxAbs > 1e-6 ? peak / maxAbs : 0;
  for (let i = 0; i < n; i++) {
    pcm[i] = Math.max(-1, Math.min(1, (pcm[i] ?? 0) * scale));
  }
  return pcm;
}

/**
 * Estimate file-relative downbeat from the first strong onset in the PCM.
 * Returns 0 when the first hit is already near t=0 (no silent pickup).
 */
export function estimateDownbeatOffsetSec(
  wave: WaveformData,
  opts?: { maxSearchSec?: number; bpm?: number },
): number {
  const { channel, sampleRate } = wave;
  if (!channel.length || !(sampleRate > 0)) return 0;
  const maxSearchSec = opts?.maxSearchSec ?? 2.5;
  const bpm = opts?.bpm && opts.bpm > 0 ? opts.bpm : 120;
  // Search at most ~2 bars so we don't latch onto a mid-phrase hit.
  const searchSec = Math.min(maxSearchSec, (60 / bpm) * 8);
  const n = Math.min(channel.length, Math.floor(searchSec * sampleRate));
  if (n < sampleRate * 0.02) return 0;

  const win = Math.max(1, Math.floor(sampleRate * 0.004));
  let globalMax = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(channel[i]!);
    if (a > globalMax) globalMax = a;
  }
  if (!(globalMax > 1e-4)) return 0;
  const thresh = globalMax * 0.35;

  for (let i = 0; i + win < n; i += win) {
    let peak = 0;
    for (let j = i; j < i + win; j++) {
      const a = Math.abs(channel[j]!);
      if (a > peak) peak = a;
    }
    if (peak >= thresh) {
      const t = i / sampleRate;
      return t < 0.02 ? 0 : Math.round(t * 1000) / 1000;
    }
  }
  return 0;
}

/**
 * Schedules short clicks on the musical beat grid while media plays.
 * Accent on bar downbeats. Times use the same origin as snap/grid (`downbeatOffsetSec`).
 *
 * Architecture (audible + smooth transport):
 * - Media stays on native HTMLMediaElement (never MediaElementSource).
 * - Clicks: dedicated AudioContext + peak-normalized AudioBufferSourceNode
 *   look-ahead schedule from live `audio.currentTime`.
 * - No HTMLAudioElement per tick (that path hitch the playhead/timer).
 * - `resume()` / `auditionSync()` must not gate or await-before media.play().
 *
 * Ear sync: heard media lags `currentTime`/playhead; Web Audio BufferSource
 * start latency is ~0, so schedule clicks `mediaEarLagSec` later than the
 * media beat time so the *heard* tick meets the *heard* beat.
 */
export class Metronome {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private bufHigh: AudioBuffer | null = null;
  private bufLow: AudioBuffer | null = null;
  private pendingSources: AudioBufferSourceNode[] = [];
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
  private readonly scheduleHorizonSec = 0.28;
  /**
   * How far heard media lags `currentTime`/playhead. Web Audio click start
   * is near sample-accurate, so we delay the tick by this amount.
   */
  private readonly mediaEarLagSec = 0.035;
  /** Allow scheduling a beat slightly past mediaNow (Play starts mid-beat). */
  private readonly lateGraceSec = 0.012;
  /** Diagnostics: BufferSource starts. */
  clicksStarted = 0;

  setEnabled(on: boolean): void {
    const was = this.enabled;
    this.enabled = on;
    if (!on) {
      this.stopScheduler();
      return;
    }
    if (this.playing && (!was || this.timer == null)) {
      this.startScheduler();
    }
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
    this.nextBeatIndex = this.beatIndexAt(this.getMediaTime());
  }

  setMediaTimeGetter(fn: () => number): void {
    this.getMediaTime = fn;
  }

  /** No-op: track audio stays on the element (never create MediaElementSource). */
  attachMediaElement(_audio: HTMLMediaElement): void {
    // intentionally unused
  }

  /** Call when transport play/pause changes. Does not touch media. */
  setPlaying(playing: boolean): void {
    this.playing = playing;
    if (playing) {
      // Non-blocking context prime — never await before media.play().
      this.primeFromGesture();
      if (this.enabled) this.startScheduler();
    } else {
      this.stopScheduler();
    }
  }

  /**
   * Under Play / Click gesture: create + kick resume on the click AudioContext.
   * Must not delay or gate media.play() (App calls this with void).
   */
  async resume(): Promise<void> {
    this.primeFromGesture();
    const ctx = this.ctx;
    if (ctx && ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        // ignore — clicks may stay silent; transport must stay smooth
      }
    }
  }

  /**
   * Fire one Web Audio click under the current user gesture (no await).
   * Also primes the AudioContext so later look-ahead ticks are audible.
   * Never uses HTMLAudioElement (avoids playhead hitch).
   */
  auditionSync(): void {
    this.primeFromGesture();
    const ctx = this.ctx;
    if (!ctx || !this.bufHigh || !this.master) return;
    const when = ctx.currentTime;
    this.scheduleBufferClick(when, true, Math.max(0.85, this.volume));
  }

  /** Call after seeks so clicks re-lock to media time. */
  resync(): void {
    this.clearPending();
    this.nextBeatIndex = this.beatIndexAt(this.getMediaTime());
  }

  /** Alias kept for seek call sites; do not call on Play. */
  lockToMediaClock(): void {
    this.resync();
  }

  dispose(): void {
    this.stopScheduler();
    this.clearPending();
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    this.bufHigh = null;
    this.bufLow = null;
    if (ctx) void ctx.close();
  }

  /**
   * Sync create + fire-and-forget resume under a user gesture.
   * Creating the context outside the gesture stack left it suspended (silent).
   */
  private primeFromGesture(): void {
    const ctx = this.getOrCreateCtx();
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => undefined);
    }
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
      this.bufHigh = this.makeBuffer(1600, 1);
      this.bufLow = this.makeBuffer(1000, 0.9);
    }
    return this.ctx;
  }

  private makeBuffer(freqHz: number, peak: number): AudioBuffer {
    const ctx = this.ctx!;
    const pcm = synthesizeClickPcm(ctx.sampleRate, freqHz, peak);
    const buf = ctx.createBuffer(1, pcm.length, ctx.sampleRate);
    buf.getChannelData(0).set(pcm);
    return buf;
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

  /** First beat index still eligible to schedule at media time tAbs. */
  private beatIndexAt(tAbs: number): number {
    const beatSec = this.beatDurationSec();
    if (!(beatSec > 0)) return 0;
    const origin = this.grid.downbeatOffsetSec || 0;
    // Grace + ear-lag: Play a few ms past a beat must still arm that beat
    // when its heard time is still ahead.
    const skew = this.lateGraceSec + this.mediaEarLagSec;
    return Math.ceil((tAbs - origin - skew) / beatSec - 1e-9);
  }

  private startScheduler(): void {
    this.stopScheduler();
    if (!this.playing || !this.enabled) return;
    // Sync start — do not await ctx; tick no-ops until running.
    this.primeFromGesture();
    this.nextBeatIndex = this.beatIndexAt(this.getMediaTime());
    this.timer = window.setInterval(() => this.tick(), 25);
    this.tick();
  }

  private stopScheduler(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.clearPending();
  }

  private clearPending(): void {
    for (const src of this.pendingSources) {
      try {
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
    if (!this.bufHigh || !this.bufLow) return;
    if (ctx.state !== "running") {
      void ctx.resume().catch(() => undefined);
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

    // Schedule far enough that ear-lag delayed fires stay inside the horizon.
    const until = mediaNow + this.scheduleHorizonSec;
    const ctxNow = ctx.currentTime;
    const ear = this.mediaEarLagSec;
    // Subtract Web Audio output path so relative media↔click stays stable.
    const clickOut =
      (typeof ctx.baseLatency === "number" ? ctx.baseLatency : 0) +
      (typeof ctx.outputLatency === "number" ? ctx.outputLatency : 0);

    while (true) {
      const beatIndex = this.nextBeatIndex;
      const tAbs = origin + beatIndex * beatSec;
      if (tAbs > until) break;
      if (tAbs < 0) {
        this.nextBeatIndex += 1;
        if (this.nextBeatIndex > 1e7) break;
        continue;
      }
      // Heard click meets heard beat: fire ear-lag after media beat time,
      // minus AudioContext output latency (media has its own ear lag).
      const when = ctxNow + (tAbs - mediaNow) + ear - clickOut;
      if (when < ctxNow - 0.002) {
        this.nextBeatIndex += 1;
        if (this.nextBeatIndex > 1e7) break;
        continue;
      }
      if (when <= ctxNow + this.scheduleHorizonSec + 0.08) {
        const beatInBar = ((beatIndex % bpb) + bpb) % bpb;
        const level = beatInBar === 0 ? 1 : 0.55;
        this.scheduleBufferClick(when, beatInBar === 0, this.volume * level);
      }
      this.nextBeatIndex += 1;
      if (this.nextBeatIndex > 1e7) break;
    }
  }

  private scheduleBufferClick(
    when: number,
    downbeat: boolean,
    gainLevel: number,
  ): void {
    const ctx = this.ctx;
    const master = this.master;
    const buf = downbeat ? this.bufHigh : this.bufLow;
    if (!ctx || !master || !buf) return;
    const t0 = Math.max(when, ctx.currentTime);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    const level = Math.max(0.0001, Math.min(1, gainLevel));
    gain.gain.setValueAtTime(level, t0);
    src.connect(gain);
    gain.connect(master);
    this.pendingSources.push(src);
    this.clicksStarted += 1;
    try {
      src.start(t0);
    } catch {
      const i = this.pendingSources.indexOf(src);
      if (i >= 0) this.pendingSources.splice(i, 1);
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
