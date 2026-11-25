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
 * Build a loud mono 16-bit WAV click as a blob URL (no AudioContext / MES).
 * Peak-normalized so the sample is non-zero and cuts through a dense track.
 */
function makeClickWavUrl(freqHz: number, peak: number): {
  url: string;
  peakAbs: number;
} {
  const sr = 44100;
  const dur = 0.07;
  const n = Math.max(1, Math.floor(sr * dur));
  const pcm = new Float32Array(n);
  let maxAbs = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.exp(-t * 45);
    const tone =
      Math.sin(2 * Math.PI * freqHz * t) * 0.8 +
      Math.sin(2 * Math.PI * freqHz * 2 * t) * 0.2;
    const noise = i < sr * 0.003 ? (Math.random() * 2 - 1) * 0.4 : 0;
    const s = (tone + noise) * env;
    pcm[i] = s;
    const a = Math.abs(s);
    if (a > maxAbs) maxAbs = a;
  }
  const scale = maxAbs > 1e-6 ? peak / maxAbs : 0;
  const dataSize = n * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  let outPeak = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, (pcm[i] ?? 0) * scale));
    outPeak = Math.max(outPeak, Math.abs(v));
    view.setInt16(44 + i * 2, (v * 0x7fff) | 0, true);
  }
  const url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  return { url, peakAbs: outPeak };
}

/**
 * Schedules short clicks on the musical beat grid while media plays.
 *
 * Media stays on native HTMLMediaElement (no MediaElementSource).
 * Clicks also use HTMLAudioElement samples (same speaker path as the track) —
 * Web Audio destination has been silent in real browsers while element audio
 * is audible. Samples are PCM WAV blob URLs; look-ahead uses media currentTime.
 *
 * Call `resume()` from the Play / Click user gesture to unlock the click pool.
 */
export class Metronome {
  private urlHigh: string | null = null;
  private urlLow: string | null = null;
  /** Non-zero peak of generated samples (diagnostics). */
  samplePeakAbs = 0;
  private pool: HTMLAudioElement[] = [];
  private poolIndex = 0;
  private readonly poolSize = 8;
  private timer: number | null = null;
  private pendingTimeouts: number[] = [];
  private schedulerEpoch = 0;
  private startInflight = false;
  private resumeInflight: Promise<void> | null = null;
  private unlocked = false;
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
  private scheduledBeats = new Set<number>();
  private readonly scheduleHorizonSec = 0.35;
  /** Diagnostics: successful element.play() count. */
  clicksStarted = 0;

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    const was = this.enabled;
    this.enabled = on;
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
   * `audio.play()`. Pause only stops click scheduling — never touches media.
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
      if (this.enabled) this.startScheduler();
    } else {
      this.stopScheduler();
    }
  }

  /**
   * Under a user gesture: build WAV samples + unlock the HTMLAudioElement pool
   * so later scheduled plays are allowed.
   */
  async resume(): Promise<void> {
    if (this.resumeInflight) return this.resumeInflight;
    this.resumeInflight = (async () => {
      this.ensureSamples();
      await this.unlockPool();
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
   * Fire one immediate click (same HTMLAudioElement path). Used on Play when
   * Click is on, and when enabling Click mid-play — proves speakers under gesture.
   */
  async audition(): Promise<void> {
    await this.resume();
    this.fireClick(true, Math.max(this.volume, 0.85));
  }

  dispose(): void {
    this.stopScheduler();
    this.clearPending();
    this.scheduledBeats.clear();
    for (const el of this.pool) {
      try {
        el.pause();
        el.removeAttribute("src");
        el.load();
      } catch {
        // ignore
      }
    }
    this.pool = [];
    if (this.urlHigh) URL.revokeObjectURL(this.urlHigh);
    if (this.urlLow) URL.revokeObjectURL(this.urlLow);
    this.urlHigh = null;
    this.urlLow = null;
    this.resumeInflight = null;
    this.startInflight = false;
    this.unlocked = false;
  }

  private ensureSamples(): void {
    if (this.urlHigh && this.urlLow) return;
    const high = makeClickWavUrl(1600, 1);
    const low = makeClickWavUrl(1000, 0.9);
    this.urlHigh = high.url;
    this.urlLow = low.url;
    this.samplePeakAbs = Math.max(high.peakAbs, low.peakAbs);
    this.pool = [];
    for (let i = 0; i < this.poolSize; i++) {
      const el = new Audio();
      el.preload = "auto";
      el.src = this.urlHigh;
      // Keep elements out of the document; native element audio still plays.
      this.pool.push(el);
    }
  }

  /** Prime pool under a user gesture so timer-scheduled play() is allowed. */
  private async unlockPool(): Promise<void> {
    this.ensureSamples();
    if (this.unlocked || this.pool.length === 0) {
      // Still poke one element — browsers sometimes re-suspend.
      const el = this.pool[0];
      if (!el || !this.urlHigh) return;
      el.muted = true;
      el.volume = 0;
      el.src = this.urlHigh;
      try {
        await el.play();
        el.pause();
        el.currentTime = 0;
      } catch {
        // ignore — audition may still unlock
      }
      el.muted = false;
      return;
    }
    await Promise.all(
      this.pool.map(async (el) => {
        if (!this.urlHigh) return;
        el.muted = true;
        el.volume = 0;
        el.src = this.urlHigh;
        try {
          await el.play();
          el.pause();
          el.currentTime = 0;
        } catch {
          // ignore
        }
        el.muted = false;
      }),
    );
    this.unlocked = true;
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
        if (!this.playing || !this.enabled) return;
        this.scheduledBeats.clear();
        this.nextBeatIndex = this.beatIndexAt(this.getMediaTime());
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
  }

  private clearPending(): void {
    for (const id of this.pendingTimeouts) clearTimeout(id);
    this.pendingTimeouts = [];
  }

  private tick(): void {
    if (!this.enabled || !this.playing) return;
    if (!this.urlHigh || !this.urlLow) this.ensureSamples();

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

    while (true) {
      const beatIndex = this.nextBeatIndex;
      const tAbs = origin + beatIndex * beatSec;
      if (tAbs > until) break;
      if (tAbs < 0 || tAbs < mediaNow - 0.015) {
        this.nextBeatIndex += 1;
        if (this.nextBeatIndex > 1e7) break;
        continue;
      }
      if (this.scheduledBeats.has(beatIndex)) {
        this.nextBeatIndex += 1;
        continue;
      }
      const beatInBar = ((beatIndex % bpb) + bpb) % bpb;
      const delayMs = Math.max(0, (tAbs - mediaNow) * 1000);
      this.scheduleElementClick(delayMs, beatInBar === 0, beatIndex);
      this.nextBeatIndex += 1;
      if (this.nextBeatIndex > 1e7) break;
    }
  }

  private scheduleElementClick(
    delayMs: number,
    downbeat: boolean,
    beatIndex: number,
  ): void {
    this.scheduledBeats.add(beatIndex);
    const epoch = this.schedulerEpoch;
    const level = downbeat ? 1 : 0.75;
    const id = window.setTimeout(() => {
      const i = this.pendingTimeouts.indexOf(id);
      if (i >= 0) this.pendingTimeouts.splice(i, 1);
      if (epoch !== this.schedulerEpoch) return;
      if (!this.enabled || !this.playing) return;
      this.fireClick(downbeat, this.volume * level);
    }, delayMs);
    this.pendingTimeouts.push(id);
  }

  private fireClick(downbeat: boolean, vol: number): void {
    this.ensureSamples();
    const url = downbeat ? this.urlHigh : this.urlLow;
    if (!url || this.pool.length === 0) return;
    const el = this.pool[this.poolIndex % this.pool.length]!;
    this.poolIndex += 1;
    const v = Math.max(0, Math.min(1, vol));
    if (v <= 0.001) return;
    try {
      el.pause();
      el.muted = false;
      el.volume = v;
      if (el.src !== url) el.src = url;
      el.currentTime = 0;
      const p = el.play();
      this.clicksStarted += 1;
      if (p && typeof p.then === "function") {
        void p.catch(() => {
          this.clicksStarted -= 1;
        });
      }
    } catch {
      // play failed
    }
  }
}
