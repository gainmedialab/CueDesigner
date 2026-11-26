/**
 * Live show sync: chase incoming LTC (Web Audio mic/line) or MTC (Web MIDI).
 *
 * Internal mode is a no-op here — App keeps using HTMLMediaElement.currentTime.
 * When LTC/MTC is locked, App drives the playhead from `tAbs` and only seeks
 * media when drift exceeds a threshold (smooth Internal transport preserved).
 */

import {
  MtcAssembler,
  decodeLtcFrameBits,
  emptySyncStatus,
  formatSyncTimecode,
  fpsLabelsMatch,
  syncFrameToAbsolute,
  type FrameRateLabel,
  type SyncClockSource,
  type SyncLockState,
  type SyncStatusSnapshot,
  type SyncTimecodeFrame,
} from "@cuedesigner/core";

const LOCK_FRAMES_NEEDED = 3;
const FREEWHEEL_MS = 250;
const UNLOCK_MS = 800;
/** Seek HTMLMediaElement only when drift exceeds this (seconds). */
export const TC_SEEK_DRIFT_SEC = 0.05;

export type TimecodeSyncListener = (status: SyncStatusSnapshot) => void;

export interface TimecodeSyncOptions {
  getProjectFps: () => FrameRateLabel;
  getShowTcOffsetSec: () => number;
  /** Optional preferred MIDI input id (Web MIDI). */
  midiInputId?: string | null;
}

export interface TimecodeChaseSample {
  tAbs: number;
  status: SyncStatusSnapshot;
}

/**
 * Owns device I/O for LTC + MTC. Safe to construct in browser and Electron.
 */
export class TimecodeSync {
  private source: SyncClockSource = "internal";
  private listener: TimecodeSyncListener | null = null;
  private status: SyncStatusSnapshot = emptySyncStatus("internal");
  private opts: TimecodeSyncOptions;

  // Shared chase state
  private lockCount = 0;
  private lastFrame: SyncTimecodeFrame | null = null;
  private lastFrameAtMs: number | null = null;
  private lastTAbs = 0;
  private lastShowSec = 0;
  private freewheelRate = 1; // show-sec per wall-sec
  private raf: number | null = null;

  // MTC
  private midiInput: MIDIInput | null = null;
  private mtc = new MtcAssembler();
  private onMidiMessage = (ev: MIDIMessageEvent) => this.handleMidi(ev);

  // LTC
  private audioCtx: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private ltcDecoder: LtcAudioDecoder | null = null;

  constructor(opts: TimecodeSyncOptions) {
    this.opts = opts;
  }

  getStatus(): SyncStatusSnapshot {
    return this.status;
  }

  getSource(): SyncClockSource {
    return this.source;
  }

  onStatus(fn: TimecodeSyncListener | null): void {
    this.listener = fn;
  }

  /**
   * Latest chased file-relative time when external source is locked/freewheel.
   * Returns null for Internal or fully unlocked (caller uses file clock).
   */
  sampleChase(nowMs: number = performance.now()): TimecodeChaseSample | null {
    if (this.source === "internal") return null;
    const lock = this.status.lock;
    if (lock !== "locked" && lock !== "freewheel") return null;

    if (lock === "freewheel" && this.lastFrameAtMs != null) {
      const dt = (nowMs - this.lastFrameAtMs) / 1000;
      const showSec = this.lastShowSec + dt * this.freewheelRate;
      const tAbs = Math.max(
        0,
        showSec - (this.opts.getShowTcOffsetSec() || 0),
      );
      return { tAbs, status: this.status };
    }
    return { tAbs: this.lastTAbs, status: this.status };
  }

  async setSource(source: SyncClockSource): Promise<void> {
    if (source === this.source) return;
    await this.stopIo();
    this.source = source;
    this.resetLock();
    if (source === "internal") {
      this.emit({
        ...emptySyncStatus("internal"),
        detail: "Internal file clock",
      });
      return;
    }
    this.emit({
      ...emptySyncStatus(source),
      detail: source === "ltc" ? "Requesting audio input…" : "Opening MIDI…",
    });
    try {
      if (source === "mtc") await this.startMtc();
      else await this.startLtc();
      this.startWatchdog();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit({
        source,
        lock: "unlocked",
        tc: null,
        tcDisplay: null,
        fpsMatch: true,
        detail: msg,
        lastFrameAtMs: null,
      });
    }
  }

  /** Refresh FPS match when project FPS changes. */
  refreshProjectClock(): void {
    if (!this.lastFrame) return;
    this.emit({
      ...this.status,
      fpsMatch: fpsLabelsMatch(
        this.lastFrame.fpsLabel,
        this.opts.getProjectFps(),
      ),
    });
  }

  dispose(): void {
    void this.setSource("internal");
    this.listener = null;
  }

  // --- Internal helpers ------------------------------------------------------

  private resetLock(): void {
    this.lockCount = 0;
    this.lastFrame = null;
    this.lastFrameAtMs = null;
    this.lastTAbs = 0;
    this.lastShowSec = 0;
    this.mtc.reset();
    this.ltcDecoder?.reset();
  }

  private emit(next: SyncStatusSnapshot): void {
    this.status = next;
    this.listener?.(next);
  }

  private setLock(lock: SyncLockState, detail: string): void {
    this.emit({
      ...this.status,
      source: this.source,
      lock,
      detail,
      lastFrameAtMs: this.lastFrameAtMs,
    });
  }

  private acceptFrame(tc: SyncTimecodeFrame, nowMs: number): void {
    const fps = this.opts.getProjectFps();
    const offset = this.opts.getShowTcOffsetSec();
    const tAbs = syncFrameToAbsolute(tc, fps, offset);
    const showSec = tAbs + (offset || 0);

    if (this.lastFrameAtMs != null && nowMs > this.lastFrameAtMs) {
      const dShow = showSec - this.lastShowSec;
      const dWall = (nowMs - this.lastFrameAtMs) / 1000;
      if (dWall > 0.001 && dShow > -0.5 && dShow < 2) {
        this.freewheelRate = dShow / dWall;
      }
    }

    this.lastFrame = tc;
    this.lastFrameAtMs = nowMs;
    this.lastTAbs = tAbs;
    this.lastShowSec = showSec;
    this.lockCount += 1;

    const fpsMatch = fpsLabelsMatch(tc.fpsLabel, fps);
    let lock: SyncLockState = "locking";
    let detail = `Locking… (${this.lockCount}/${LOCK_FRAMES_NEEDED})`;
    if (this.lockCount >= LOCK_FRAMES_NEEDED) {
      lock = "locked";
      detail = fpsMatch
        ? `${this.source.toUpperCase()} locked`
        : `${this.source.toUpperCase()} locked — FPS mismatch (stream ${tc.fpsLabel ?? "?"} vs project ${fps})`;
    }

    this.emit({
      source: this.source,
      lock,
      tc,
      tcDisplay: formatSyncTimecode(tc),
      fpsMatch,
      detail,
      lastFrameAtMs: nowMs,
    });
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      if (this.source === "internal") return;
      if (this.lastFrameAtMs == null) return;
      const age = performance.now() - this.lastFrameAtMs;
      if (age > UNLOCK_MS) {
        if (this.status.lock !== "unlocked") {
          this.lockCount = 0;
          this.setLock("unlocked", "Signal lost — using internal clock");
        }
      } else if (age > FREEWHEEL_MS) {
        if (this.status.lock === "locked" || this.status.lock === "freewheel") {
          this.setLock("freewheel", "Freewheeling (dropout)");
        }
      }
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopWatchdog(): void {
    if (this.raf != null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
  }

  private async stopIo(): Promise<void> {
    this.stopWatchdog();

    if (this.midiInput) {
      this.midiInput.removeEventListener("midimessage", this.onMidiMessage);
      this.midiInput = null;
    }
    this.mtc.reset();

    if (this.processor) {
      this.processor.onaudioprocess = null;
      try {
        this.processor.disconnect();
      } catch {
        /* already disconnected */
      }
      this.processor = null;
    }
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        /* already disconnected */
      }
      this.sourceNode = null;
    }
    if (this.mediaStream) {
      for (const t of this.mediaStream.getTracks()) t.stop();
      this.mediaStream = null;
    }
    if (this.audioCtx) {
      void this.audioCtx.close();
      this.audioCtx = null;
    }
    this.ltcDecoder = null;
  }

  // --- MTC -------------------------------------------------------------------

  private async startMtc(): Promise<void> {
    if (!navigator.requestMIDIAccess) {
      throw new Error("Web MIDI unavailable in this browser");
    }
    const access = await navigator.requestMIDIAccess({ sysex: true });
    const inputs = [...access.inputs.values()];
    if (inputs.length === 0) {
      throw new Error("No MIDI inputs found");
    }
    const preferred = this.opts.midiInputId
      ? inputs.find((i) => i.id === this.opts.midiInputId)
      : null;
    const input = preferred ?? inputs[0]!;
    this.midiInput = input;
    input.addEventListener("midimessage", this.onMidiMessage);
    this.emit({
      source: "mtc",
      lock: "unlocked",
      tc: null,
      tcDisplay: null,
      fpsMatch: true,
      detail: `Listening: ${input.name || input.id}`,
      lastFrameAtMs: null,
    });

    access.onstatechange = () => {
      if (this.source !== "mtc") return;
      if (this.midiInput && this.midiInput.state === "disconnected") {
        this.lockCount = 0;
        this.setLock("unlocked", "MIDI input disconnected");
      }
    };
  }

  private handleMidi(ev: MIDIMessageEvent): void {
    const data = ev.data;
    if (!data || data.length < 1) return;
    const now = performance.now();

    if (data[0] === 0xf1 && data.length >= 2) {
      const frame = this.mtc.pushQuarterFrame(data[1]!);
      if (frame) this.acceptFrame(frame, now);
      return;
    }

    if (data[0] === 0xf0) {
      const frame = this.mtc.pushFullFrameSysEx(data);
      if (frame) this.acceptFrame(frame, now);
    }
  }

  /** Enumerate MIDI inputs for a future device picker. */
  static async listMidiInputs(): Promise<{ id: string; name: string }[]> {
    if (!navigator.requestMIDIAccess) return [];
    try {
      const access = await navigator.requestMIDIAccess({ sysex: true });
      return [...access.inputs.values()].map((i) => ({
        id: i.id,
        name: i.name || i.id,
      }));
    } catch {
      return [];
    }
  }

  // --- LTC -------------------------------------------------------------------

  private async startLtc(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Audio capture unavailable in this browser");
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
      video: false,
    });
    this.mediaStream = stream;

    const AC =
      window.AudioContext ||
      (
        window as unknown as {
          webkitAudioContext: typeof AudioContext;
        }
      ).webkitAudioContext;
    const ctx = new AC();
    this.audioCtx = ctx;
    if (ctx.state === "suspended") await ctx.resume();

    const src = ctx.createMediaStreamSource(stream);
    this.sourceNode = src;
    // ScriptProcessor is deprecated but widely available; AudioWorklet can replace later.
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    this.processor = processor;
    const fps = frameRateApprox(this.opts.getProjectFps());
    this.ltcDecoder = new LtcAudioDecoder(ctx.sampleRate, fps);
    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const frames = this.ltcDecoder!.pushSamples(input);
      const now = performance.now();
      for (const f of frames) this.acceptFrame(f, now);
      // Keep graph alive; mute output so LTC is never monitored to speakers.
      e.outputBuffer.getChannelData(0).fill(0);
    };
    src.connect(processor);
    processor.connect(ctx.destination);

    const trackLabel =
      stream.getAudioTracks()[0]?.label || "Default audio input";
    this.emit({
      source: "ltc",
      lock: "unlocked",
      tc: null,
      tcDisplay: null,
      fpsMatch: true,
      detail: `Listening: ${trackLabel}`,
      lastFrameAtMs: null,
    });
  }
}

function frameRateApprox(label: FrameRateLabel): number {
  switch (label) {
    case "23.976":
      return 24000 / 1001;
    case "24":
      return 24;
    case "25":
      return 25;
    case "29.97 DF":
    case "29.97 NDF":
      return 30000 / 1001;
    case "30":
      return 30;
    default:
      return 25;
  }
}

/**
 * Soft real-time LTC decoder: zero-crossing → bi-phase mark bits → 80-bit frames.
 * Tuned for line-level LTC into the selected mic/input device.
 *
 * Bi-phase mark: transition at every bit start; an extra mid-bit transition
 * means '1', absence means '0'. Intervals between crossings are ~T/2 or ~T.
 */
class LtcAudioDecoder {
  private sampleRate: number;
  private fps: number;
  private samplesPerBit: number;
  private prev = 0;
  private sinceCross = 0;
  private bits: number[] = [];
  private calibratedSpb: number | null = null;
  private pendingHalf = false;
  private started = false;

  constructor(sampleRate: number, fps: number) {
    this.sampleRate = sampleRate;
    this.fps = fps > 0 ? fps : 25;
    this.samplesPerBit = sampleRate / (this.fps * 80);
  }

  reset(): void {
    this.prev = 0;
    this.sinceCross = 0;
    this.bits = [];
    this.calibratedSpb = null;
    this.pendingHalf = false;
    this.started = false;
  }

  setFps(fps: number): void {
    if (!(fps > 0)) return;
    this.fps = fps;
    this.samplesPerBit = this.sampleRate / (this.fps * 80);
  }

  pushSamples(samples: Float32Array): SyncTimecodeFrame[] {
    const out: SyncTimecodeFrame[] = [];
    const spb = this.calibratedSpb ?? this.samplesPerBit;
    const halfLo = spb * 0.28;
    const halfHi = spb * 0.72;
    const bitLo = spb * 0.72;
    const bitHi = spb * 1.4;

    for (let i = 0; i < samples.length; i++) {
      const s = samples[i]!;
      this.sinceCross += 1;
      const crossed =
        (this.prev < 0 && s >= 0) || (this.prev >= 0 && s < 0);
      if (crossed) {
        const gap = this.sinceCross;
        this.sinceCross = 0;
        if (!this.started) {
          // First crossing after silence — start of a bit cell
          this.started = true;
          this.pendingHalf = false;
        } else if (gap >= halfLo && gap <= halfHi) {
          if (this.pendingHalf) {
            this.pushBit(1, out);
            this.pendingHalf = false;
            this.calibratedSpb = lerp(this.calibratedSpb ?? spb, gap * 2, 0.08);
          } else {
            this.pendingHalf = true;
          }
        } else if (gap >= bitLo && gap <= bitHi) {
          if (this.pendingHalf) {
            // Desync — drop pending half
            this.pendingHalf = false;
          }
          this.pushBit(0, out);
          this.calibratedSpb = lerp(this.calibratedSpb ?? spb, gap, 0.08);
        } else if (gap > bitHi * 1.6) {
          this.bits = [];
          this.pendingHalf = false;
          this.started = true; // this crossing restarts a cell
        }
      }
      this.prev = s;
    }
    return out;
  }

  private pushBit(bit: number, out: SyncTimecodeFrame[]): void {
    this.bits.push(bit & 1);
    if (this.bits.length > 160) {
      this.bits.splice(0, this.bits.length - 120);
    }
    if (this.bits.length < 80) return;

    for (
      let start = this.bits.length - 80;
      start >= Math.max(0, this.bits.length - 100);
      start--
    ) {
      const slice = this.bits.slice(start, start + 80);
      const frame = decodeLtcFrameBits(slice);
      if (frame) {
        // Infer fps from frames field when DF flag unset — leave null;
        // project FPS drives show seconds.
        out.push(frame);
        this.bits = this.bits.slice(start + 80);
        break;
      }
    }
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
