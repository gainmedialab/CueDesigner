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

/** Deterministic mono click PCM (peak-normalized). Short = frees pool slots fast. */
function synthesizeClickPcm(
  sampleRate: number,
  freqHz: number,
  peak: number,
  durSec = 0.032,
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

const CLICK_SR = 44100;
/** Module-level samples — built once, never on the Play/RAF path. */
const CLICK_URI_HIGH = pcmToDataUri(synthesizeClickPcm(CLICK_SR, 1600, 1), CLICK_SR);
const CLICK_URI_LOW = pcmToDataUri(synthesizeClickPcm(CLICK_SR, 1000, 0.9), CLICK_SR);

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

  // Envelope: max abs in ~4ms windows.
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
      // Near-zero onset → grid origin already fine.
      return t < 0.02 ? 0 : Math.round(t * 1000) / 1000;
    }
  }
  return 0;
}

/**
 * Schedules short clicks on the musical beat grid while media plays.
 *
 * Media stays on native HTMLMediaElement (no MES).
 *
 * Web Audio → destination is silent in the user's browser; HTMLAudio works
 * for speakers but pause/seek/play thrash previously froze the playhead.
 * Play-path strategy: preloaded HTMLAudio pool, **never pause()** on the beat
 * path, reuse only free (paused/ended) elements, seek to 0 only when needed,
 * skip the beat if the pool is busy. One-time muted unlock under Play/Click
 * gesture via `resume()` / `auditionSync()` (must not gate media.play()).
 *
 * Sync (two latency terms, look-ahead from live media `currentTime`):
 * - `clickStartLeadSec` — fire HTMLAudio.play() early for click-element start delay
 * - `mediaEarLagSec` — heard media lags `currentTime` / playhead
 * Net lead = clickStart − mediaEar so the *heard* click meets the *heard* beat,
 * not only the visual playhead.
 */
export class Metronome {
  private poolHigh: HTMLAudioElement[] = [];
  private poolLow: HTMLAudioElement[] = [];
  private cursorHigh = 0;
  private cursorLow = 0;
  private readonly poolPerAccent = 6;
  private unlocked = false;
  private unlockInflight: Promise<void> | null = null;
  private timer: number | null = null;
  private pendingTimeouts: number[] = [];
  private schedulerEpoch = 0;
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
  private scheduledBeats = new Set<number>();
  private readonly scheduleHorizonSec = 0.28;
  /** HTMLAudioElement.play() → audible tick (start latency). */
  private readonly clickStartLeadSec = 0.08;
  /**
   * How far heard media lags `currentTime`/playhead. Full click-only lead
   * lined ticks up with the playhead but put them ahead of heard music.
   */
  private readonly mediaEarLagSec = 0.05;
  /** Diagnostics: successful element.play() attempts. */
  clicksStarted = 0;

  /** Net: fire play() this far before beat media time. */
  private netLeadSec(): number {
    return Math.max(0, this.clickStartLeadSec - this.mediaEarLagSec);
  }

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
      if (this.enabled) this.startScheduler();
    } else {
      this.stopScheduler();
    }
  }

  /**
   * Under Play / Click gesture: ensure pool + one-time muted unlock.
   * Must not delay or gate media.play() (App calls this with void).
   */
  async resume(): Promise<void> {
    this.ensurePool();
    await this.unlockPool();
  }

  /** Call after seeks so clicks re-lock to media time. */
  resync(): void {
    this.clearPending();
    this.scheduledBeats.clear();
    this.nextBeatIndex = this.beatIndexAt(this.getMediaTime());
  }

  /** Alias kept for seek call sites; do not call on Play. */
  lockToMediaClock(): void {
    this.resync();
  }

  /**
   * Fire one click under the current user gesture (no await).
   * Uses a one-shot element so it cannot race muted pool unlock.
   * Also primes / unlocks the pool for later scheduled plays.
   */
  auditionSync(): void {
    this.ensurePool();
    try {
      const el = new Audio(CLICK_URI_HIGH);
      el.volume = Math.max(this.volume, 0.85);
      void el.play().catch(() => {
        // ignore
      });
    } catch {
      // ignore
    }
    void this.unlockPool();
  }

  dispose(): void {
    this.stopScheduler();
    this.clearPending();
    this.scheduledBeats.clear();
    for (const el of [...this.poolHigh, ...this.poolLow]) {
      try {
        el.pause();
        el.removeAttribute("src");
        el.load();
      } catch {
        // ignore
      }
    }
    this.poolHigh = [];
    this.poolLow = [];
    this.unlocked = false;
    this.unlockInflight = null;
  }

  private ensurePool(): void {
    if (this.poolHigh.length > 0 && this.poolLow.length > 0) return;
    this.poolHigh = [];
    this.poolLow = [];
    for (let i = 0; i < this.poolPerAccent; i++) {
      const hi = new Audio(CLICK_URI_HIGH);
      hi.preload = "auto";
      const lo = new Audio(CLICK_URI_LOW);
      lo.preload = "auto";
      this.poolHigh.push(hi);
      this.poolLow.push(lo);
    }
  }

  /**
   * One-time muted play/pause so timer-scheduled play() is allowed.
   * Only unlocks two representatives — unlocking the whole pool (12×)
   * contended with media and wobbling the clock at Play start.
   */
  private async unlockPool(): Promise<void> {
    this.ensurePool();
    if (this.unlocked) return;
    if (this.unlockInflight) return this.unlockInflight;
    this.unlockInflight = (async () => {
      const sample = [this.poolHigh[0], this.poolLow[0]].filter(
        (el): el is HTMLAudioElement => !!el,
      );
      for (const el of sample) {
        el.muted = true;
        el.volume = 0;
        try {
          await el.play();
          el.pause();
          el.currentTime = 0;
        } catch {
          // ignore — site engagement / audition may still unlock
        }
        el.muted = false;
      }
      this.unlocked = true;
    })().finally(() => {
      this.unlockInflight = null;
    });
    return this.unlockInflight;
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
    this.ensurePool();
    // Non-blocking unlock — never await before media already playing.
    void this.unlockPool();
    this.scheduledBeats.clear();
    this.nextBeatIndex = this.beatIndexAt(this.getMediaTime());
    this.timer = window.setInterval(() => this.tick(), 40);
    this.tick();
  }

  private stopScheduler(): void {
    this.schedulerEpoch += 1;
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

    const beatSec = this.beatDurationSec();
    if (!(beatSec > 0)) return;

    const mediaNow = this.getMediaTime();
    if (!Number.isFinite(mediaNow)) return;

    const origin = this.grid.downbeatOffsetSec || 0;
    const bpb = this.beatsPerBar();
    const lead = this.netLeadSec();
    const want = this.beatIndexAt(mediaNow);
    if (this.nextBeatIndex < want - 1 || this.nextBeatIndex > want + 4) {
      this.nextBeatIndex = want;
    }
    // Horizon includes lead so we can arm play() before the beat.
    const until = mediaNow + this.scheduleHorizonSec + lead;

    while (true) {
      const beatIndex = this.nextBeatIndex;
      const tAbs = origin + beatIndex * beatSec;
      if (tAbs > until) break;
      // Missed window (past beat) — do not skip beats that are still inside
      // the lead arming window (first beat when Play starts slightly late).
      if (tAbs < 0 || mediaNow > tAbs + 0.045) {
        this.nextBeatIndex += 1;
        if (this.nextBeatIndex > 1e7) break;
        continue;
      }
      if (this.scheduledBeats.has(beatIndex)) {
        this.nextBeatIndex += 1;
        continue;
      }
      const beatInBar = ((beatIndex % bpb) + bpb) % bpb;
      // Fire play() early by net lead so heard click meets heard media beat.
      const fireAtMedia = tAbs - lead;
      const delayMs = Math.max(0, (fireAtMedia - mediaNow) * 1000);
      this.scheduleElementClick(delayMs, beatInBar === 0, beatIndex, tAbs);
      this.nextBeatIndex += 1;
      if (this.nextBeatIndex > 1e7) break;
    }

    // Bound set growth during long plays.
    if (this.scheduledBeats.size > 64) {
      const keepFrom = want - 2;
      for (const b of [...this.scheduledBeats]) {
        if (b < keepFrom) this.scheduledBeats.delete(b);
      }
    }
  }

  private scheduleElementClick(
    delayMs: number,
    downbeat: boolean,
    beatIndex: number,
    tAbs: number,
  ): void {
    this.scheduledBeats.add(beatIndex);
    const level = downbeat ? 1 : 0.7;
    const vol = this.volume * level;
    if (delayMs <= 4) {
      this.fireForBeat(downbeat, vol, tAbs);
      return;
    }
    const epoch = this.schedulerEpoch;
    const id = window.setTimeout(() => {
      const i = this.pendingTimeouts.indexOf(id);
      if (i >= 0) this.pendingTimeouts.splice(i, 1);
      if (epoch !== this.schedulerEpoch) return;
      if (!this.enabled || !this.playing) return;
      this.fireForBeat(downbeat, vol, tAbs);
    }, delayMs);
    this.pendingTimeouts.push(id);
  }

  /**
   * At timeout: re-read media clock. If still early, wait; if too late, skip.
   * Then start HTMLAudio so latency lands near tAbs.
   */
  private fireForBeat(downbeat: boolean, vol: number, tAbs: number): void {
    if (!this.enabled || !this.playing) return;
    const mediaNow = this.getMediaTime();
    if (!Number.isFinite(mediaNow)) return;
    const lead = this.netLeadSec();
    const fireAt = tAbs - lead;
    // Missed the window — don't stack late ticks behind the playhead.
    if (mediaNow > tAbs + 0.045) return;
    if (mediaNow < fireAt - 0.01) {
      const waitMs = Math.max(4, (fireAt - mediaNow) * 1000);
      const epoch = this.schedulerEpoch;
      const id = window.setTimeout(() => {
        const i = this.pendingTimeouts.indexOf(id);
        if (i >= 0) this.pendingTimeouts.splice(i, 1);
        if (epoch !== this.schedulerEpoch) return;
        this.fireForBeat(downbeat, vol, tAbs);
      }, waitMs);
      this.pendingTimeouts.push(id);
      return;
    }
    this.fireClick(downbeat, vol);
  }

  /**
   * Thrash-free fire: never pause() a pool element on the beat path.
   * Only reuse free (paused/ended) slots; skip the beat if all busy.
   */
  private fireClick(downbeat: boolean, vol: number): void {
    this.ensurePool();
    const v = Math.max(0, Math.min(1, vol));
    if (v <= 0.001) return;
    const pool = downbeat ? this.poolHigh : this.poolLow;
    if (pool.length === 0) return;

    let el: HTMLAudioElement | null = null;
    const start = downbeat ? this.cursorHigh : this.cursorLow;
    for (let i = 0; i < pool.length; i++) {
      const cand = pool[(start + i) % pool.length]!;
      // Free = not currently playing. Never interrupt a playing slot.
      if (cand.paused || cand.ended) {
        el = cand;
        if (downbeat) this.cursorHigh = (start + i + 1) % pool.length;
        else this.cursorLow = (start + i + 1) % pool.length;
        break;
      }
    }
    if (!el) return; // prefer smooth over forcing a seek/pause

    try {
      el.muted = false;
      el.volume = v;
      // Seek only when needed — avoid pause()+seek thrash that hitching transport.
      if (!el.ended && el.currentTime > 0.0005) {
        try {
          el.currentTime = 0;
        } catch {
          // ignore seek errors
        }
      }
      const p = el.play();
      this.clicksStarted += 1;
      if (p && typeof p.then === "function") {
        void p.catch(() => {
          this.clicksStarted -= 1;
        });
      }
    } catch {
      // play failed — keep transport smooth
    }
  }
}
