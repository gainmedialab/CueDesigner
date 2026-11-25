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

/** bytes → base64 (browser-safe). */
function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

/** Deterministic mono click PCM (peak-normalized). */
function synthesizeClickPcm(
  sampleRate: number,
  freqHz: number,
  peak: number,
  durSec = 0.045,
): Float32Array {
  const n = Math.max(1, Math.floor(sampleRate * durSec));
  const pcm = new Float32Array(n);
  let maxAbs = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-t * 60);
    const tone =
      Math.sin(2 * Math.PI * freqHz * t) * 0.85 +
      Math.sin(2 * Math.PI * freqHz * 2 * t) * 0.15;
    const noise =
      i < sampleRate * 0.002
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

/** data: WAV for gesture audition only (never on the Play/RAF path). */
function pcmToDataUri(pcm: Float32Array, sampleRate: number): string {
  const n = pcm.length;
  const dataSize = n * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < n; i++) {
    view.setInt16(44 + i * 2, ((pcm[i] ?? 0) * 0x7fff) | 0, true);
  }
  return `data:audio/wav;base64,${bytesToBase64(new Uint8Array(buf))}`;
}

const AUDITION_SR = 44100;
const AUDITION_URI_HIGH = pcmToDataUri(
  synthesizeClickPcm(AUDITION_SR, 1600, 1),
  AUDITION_SR,
);

/**
 * Schedules short clicks on the musical beat grid while media plays.
 *
 * Media stays on native HTMLMediaElement (no MES).
 *
 * Play-path clicks use a dedicated AudioContext + AudioBufferSourceNode
 * look-ahead schedule. HTMLAudioElement pool play/seek on every beat was
 * audible but froze the playhead/timer (~0.5s) — that path is gone.
 * Gesture audition still uses one HTMLAudioElement under the Click checkbox
 * (never during RAF transport). Prefer smooth transport over audible click.
 *
 * `resume()` must not gate media.play(). No lockToMediaClock on Play.
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
  private readonly scheduleHorizonSec = 0.25;
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

  /** No-op: never create MediaElementSource. */
  attachMediaElement(_audio: HTMLMediaElement): void {
    // intentionally unused
  }

  /** Call when transport play/pause changes. Does not touch media. */
  setPlaying(playing: boolean): void {
    this.playing = playing;
    if (playing) {
      // Non-blocking context prime — never await before media.play().
      void this.ensureCtx();
      if (this.enabled) this.startScheduler();
    } else {
      this.stopScheduler();
    }
  }

  /**
   * Compatibility with App togglePlay — fire-and-forget context resume.
   * Must not delay or gate media.play().
   */
  async resume(): Promise<void> {
    await this.ensureCtx();
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

  /**
   * Fire one HTMLAudio click under the current user gesture (no await).
   * Not used on the Play/RAF path — avoids playhead hitching.
   */
  auditionSync(): void {
    try {
      const el = new Audio(AUDITION_URI_HIGH);
      el.volume = Math.max(0.85, this.volume);
      void el.play().catch(() => {
        // autoplay blocked — ignore
      });
    } catch {
      // ignore
    }
    // Also prime Web Audio under the same gesture (non-blocking).
    void this.ensureCtx().then((ctx) => {
      if (!this.bufHigh || !this.master) return;
      this.scheduleBufferClick(ctx.currentTime, true, Math.max(0.85, this.volume));
    });
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

  private async ensureCtx(): Promise<AudioContext> {
    const ctx = this.getOrCreateCtx();
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        // ignore — clicks may stay silent; transport must stay smooth
      }
    }
    return ctx;
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

  private beatIndexAt(tAbs: number): number {
    const beatSec = this.beatDurationSec();
    if (!(beatSec > 0)) return 0;
    const origin = this.grid.downbeatOffsetSec || 0;
    return Math.ceil((tAbs - origin) / beatSec - 1e-9);
  }

  private startScheduler(): void {
    this.stopScheduler();
    if (!this.playing || !this.enabled) return;
    // Sync start — do not await ctx; tick no-ops until running.
    void this.ensureCtx();
    this.nextBeatIndex = this.beatIndexAt(this.getMediaTime());
    // Low-frequency look-ahead; AudioContext does the precise starts.
    this.timer = window.setInterval(() => this.tick(), 50);
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
    if (this.nextBeatIndex < want - 1 || this.nextBeatIndex > want + 4) {
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
      if (when <= ctxNow + this.scheduleHorizonSec + 0.05) {
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
    vol: number,
  ): void {
    const ctx = this.ctx;
    const master = this.master;
    const buf = downbeat ? this.bufHigh : this.bufLow;
    if (!ctx || !master || !buf) return;
    const v = Math.max(0, Math.min(1, vol));
    if (v <= 0.001) return;
    const t0 = Math.max(when, ctx.currentTime);
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const gain = ctx.createGain();
      gain.gain.value = v;
      src.connect(gain);
      gain.connect(master);
      this.pendingSources.push(src);
      src.start(t0);
      src.stop(t0 + buf.duration + 0.01);
      this.clicksStarted += 1;
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
    } catch {
      // schedule failed — keep transport smooth
    }
  }
}
