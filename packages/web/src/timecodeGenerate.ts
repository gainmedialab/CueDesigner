/**
 * Outgoing timecode generate — LTC (Web Audio) + MTC (Web MIDI).
 *
 * Transport-locked: emits only while Internal transport is playing and Generate
 * is armed. LTC uses a dedicated AudioContext (never the show-media element path)
 * with optional setSinkId + ChannelMerger for device/channel. MTC sends
 * quarter-frame messages (0xF1) on a selected MIDIOutput.
 *
 * Independent of Sync chase — arm/disarm does not tear down LTC/MTC input.
 */

import {
  absoluteToSyncFrame,
  encodeLtcFrameBits,
  encodeMtcQuarterFrameData,
  formatSyncTimecode,
  frameRateInfo,
  ltcBitsToBiphasePcm,
  type FrameRateLabel,
  type SyncTimecodeFrame,
} from "@cuedesigner/core";

/** Peak amplitude for bipolar LTC PCM (±1 encoded → scaled). */
const LTC_PEAK = 0.65;
/** Look-ahead schedule window (seconds of media time). */
const SCHEDULE_HORIZON_SEC = 0.32;
/** Scheduler poll interval (ms). */
const TICK_MS = 25;
/** MTC quarter-frame status byte. */
const MTC_QF_STATUS = 0xf1;

export type GenerateFlavour = "ltc" | "mtc";

export const GENERATE_FLAVOURS: readonly GenerateFlavour[] = [
  "ltc",
  "mtc",
] as const;

/** Audio output for LTC generate. */
export interface LtcOutputDeviceInfo {
  deviceId: string;
  label: string;
  /** Max output channels (probed via AudioContext destination / sink). */
  channelCount: number;
}

export type GenerateStatusListener = (status: GenerateStatusSnapshot) => void;

export interface GenerateStatusSnapshot {
  flavour: GenerateFlavour;
  armed: boolean;
  emitting: boolean;
  /** Last scheduled outgoing TC, or null. */
  tc: SyncTimecodeFrame | null;
  tcDisplay: string | null;
  detail: string;
}

export function emptyGenerateStatus(
  flavour: GenerateFlavour = "ltc",
): GenerateStatusSnapshot {
  return {
    flavour,
    armed: false,
    emitting: false,
    tc: null,
    tcDisplay: null,
    detail:
      flavour === "ltc"
        ? "LTC out disarmed — not routed to FOH"
        : "MTC out disarmed",
  };
}

/** MIDI output port for MTC generate. */
export interface MidiOutputInfo {
  id: string;
  name: string;
  manufacturer: string;
}

/** Shared control surface for LTC / MTC generate backends. */
export interface TimecodeOutControls {
  getStatus(): GenerateStatusSnapshot;
  onStatus(fn: GenerateStatusListener | null): void;
  isArmed(): boolean;
  setArmed(armed: boolean): Promise<void>;
  setPlaying(playing: boolean): void;
  resync(): void;
  applyRoute(): Promise<void>;
  primeFromGesture(): void;
  dispose(): void;
}

export interface LtcGeneratorOptions {
  getProjectFps: () => FrameRateLabel;
  getShowTcOffsetSec: () => number;
  getMediaTime: () => number;
  getOutputDeviceId?: () => string | null;
  /** 0-based output channel index for LTC. */
  getOutputChannelIndex?: () => number;
}

type AudioContextWithSink = AudioContext & {
  setSinkId?: (sinkId: string) => Promise<void>;
  sinkId?: string;
};

/**
 * Schedules continuous LTC frames locked to Internal media time + TC offset.
 * Safe in Chromium / Electron (macOS first). Does not touch TimecodeSync chase.
 */
export class LtcGenerator implements TimecodeOutControls {
  private opts: LtcGeneratorOptions;
  private listener: GenerateStatusListener | null = null;
  private status: GenerateStatusSnapshot = emptyGenerateStatus("ltc");
  private armed = false;
  private playing = false;
  private ctx: AudioContextWithSink | null = null;
  private merger: ChannelMergerNode | null = null;
  private timer: number | null = null;
  private pending: AudioBufferSourceNode[] = [];
  private nextFrameIndex: number | null = null;
  private boundDeviceId: string | null = null;
  private boundChannelCount = 2;
  private boundChannelIndex = 0;
  private lastTc: SyncTimecodeFrame | null = null;

  constructor(opts: LtcGeneratorOptions) {
    this.opts = opts;
  }

  getStatus(): GenerateStatusSnapshot {
    return this.status;
  }

  onStatus(fn: GenerateStatusListener | null): void {
    this.listener = fn;
  }

  isArmed(): boolean {
    return this.armed;
  }

  /**
   * Arm/disarm generate. Does not affect Sync chase I/O.
   * Audio graph is only opened while armed (keeps LTC off default speakers).
   */
  async setArmed(armed: boolean): Promise<void> {
    if (armed === this.armed) return;
    this.armed = armed;
    if (!armed) {
      this.stopScheduler();
      await this.teardownGraph();
      this.emitStatus({
        ...emptyGenerateStatus("ltc"),
        armed: false,
        detail: "LTC out disarmed — not routed to FOH",
      });
      return;
    }
    try {
      await this.ensureGraph();
      this.emitStatus({
        flavour: "ltc",
        armed: true,
        emitting: false,
        tc: null,
        tcDisplay: null,
        detail: this.routeDetail("Armed — waiting for Play"),
      });
      if (this.playing) this.startScheduler();
    } catch (err) {
      this.armed = false;
      const msg = err instanceof Error ? err.message : String(err);
      await this.teardownGraph();
      this.emitStatus({
        flavour: "ltc",
        armed: false,
        emitting: false,
        tc: null,
        tcDisplay: null,
        detail: msg,
      });
      throw err;
    }
  }

  /** Call when Internal transport play/pause changes. */
  setPlaying(playing: boolean): void {
    this.playing = playing;
    if (playing) {
      if (this.armed) {
        void this.ensureGraph()
          .then(() => this.startScheduler())
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            this.emitStatus({
              ...this.status,
              armed: this.armed,
              emitting: false,
              detail: msg,
            });
          });
      }
    } else {
      this.stopScheduler();
      if (this.armed) {
        this.emitStatus({
          flavour: "ltc",
          armed: true,
          emitting: false,
          tc: this.lastTc,
          tcDisplay: this.lastTc ? formatSyncTimecode(this.lastTc) : null,
          detail: this.routeDetail("Armed — paused (transport-locked)"),
        });
      }
    }
  }

  /** After seek / scrub — drop pending frames and re-lock to media time. */
  resync(): void {
    this.clearPending();
    this.nextFrameIndex = null;
    if (this.armed && this.playing) this.tick();
  }

  /** Re-open output after device/channel change (only while armed). */
  async applyRoute(): Promise<void> {
    if (!this.armed) return;
    this.stopScheduler();
    await this.teardownGraph();
    await this.ensureGraph();
    this.emitStatus({
      flavour: "ltc",
      armed: true,
      emitting: false,
      tc: null,
      tcDisplay: null,
      detail: this.playing
        ? this.routeDetail("Route updated — generating")
        : this.routeDetail("Armed — waiting for Play"),
    });
    if (this.playing) this.startScheduler();
  }

  /** Under Play gesture: create/resume generate AudioContext (non-blocking). */
  primeFromGesture(): void {
    if (!this.armed) return;
    void this.ensureGraph().catch(() => undefined);
  }

  dispose(): void {
    this.armed = false;
    this.playing = false;
    this.stopScheduler();
    void this.teardownGraph();
    this.listener = null;
  }

  /**
   * Enumerate audiooutput devices and probe maxChannelCount via a temporary
   * AudioContext + setSinkId (Chromium / Electron).
   */
  static async listLtcOutputDevices(): Promise<LtcOutputDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    // Labels usually need a prior permission grant.
    try {
      const warm = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      for (const t of warm.getTracks()) t.stop();
    } catch {
      // May still get truncated ids without labels.
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter((d) => d.kind === "audiooutput");
    const out: LtcOutputDeviceInfo[] = [];

    for (const d of outputs) {
      const channelCount = await probeOutputChannelCount(d.deviceId);
      out.push({
        deviceId: d.deviceId,
        label: d.label || `Audio output (${d.deviceId.slice(0, 8)}…)`,
        channelCount,
      });
    }
    return out;
  }

  /** Prefer virtual/dedicated TC feeds over built-in speakers when picking a default. */
  static pickDefaultOutputId(devices: LtcOutputDeviceInfo[]): string {
    if (devices.length === 0) return "";
    const preferred = devices.find((d) => looksLikeDedicatedTcOutput(d.label));
    if (preferred) return preferred.deviceId;
    const nonBuiltin = devices.find((d) => !looksLikeBuiltinSpeakers(d.label));
    return (nonBuiltin ?? devices[0]!).deviceId;
  }

  // --- internals -------------------------------------------------------------

  private emitStatus(next: GenerateStatusSnapshot): void {
    this.status = next;
    this.listener?.(next);
  }

  private routeDetail(suffix: string): string {
    const ch = this.boundChannelIndex + 1;
    const n = this.boundChannelCount;
    const id = this.boundDeviceId;
    const short = id ? id.slice(0, 8) : "?";
    return `LTC OUT Ch ${ch}/${n} (${short}…) — ${suffix}`;
  }

  private startScheduler(): void {
    this.stopScheduler();
    if (!this.armed || !this.playing) return;
    this.nextFrameIndex = null;
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  private stopScheduler(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.clearPending();
    this.nextFrameIndex = null;
  }

  private clearPending(): void {
    for (const src of this.pending) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      try {
        src.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.pending = [];
  }

  private tick(): void {
    const ctx = this.ctx;
    const merger = this.merger;
    if (!ctx || !merger || !this.armed || !this.playing) return;
    if (ctx.state !== "running") {
      void ctx.resume().catch(() => undefined);
      return;
    }

    const fpsLabel = this.opts.getProjectFps();
    const info = frameRateInfo(fpsLabel);
    const fps = info.fps;
    if (!(fps > 0)) return;
    const frameDur = 1 / fps;
    const offset = this.opts.getShowTcOffsetSec() || 0;
    const mediaNow = this.opts.getMediaTime();
    if (!Number.isFinite(mediaNow)) return;

    const showNow = Math.max(0, mediaNow) + offset;
    const want = Math.floor(showNow * fps + 1e-9);
    if (this.nextFrameIndex == null) {
      this.nextFrameIndex = want;
    } else if (
      this.nextFrameIndex < want - 2 ||
      this.nextFrameIndex > want + 16
    ) {
      this.nextFrameIndex = want;
    }

    const untilShow = showNow + SCHEDULE_HORIZON_SEC;
    const untilFrame = Math.floor(untilShow * fps + 1e-9);
    const ctxNow = ctx.currentTime;
    let scheduled = 0;
    let frameIndex = this.nextFrameIndex ?? want;

    while (frameIndex <= untilFrame) {
      const frameShowSec = frameIndex / fps;
      const frameMediaSec = frameShowSec - offset;
      const when = ctxNow + (frameMediaSec - mediaNow);
      if (when + frameDur < ctxNow - 0.002) {
        frameIndex += 1;
        this.nextFrameIndex = frameIndex;
        continue;
      }
      if (when > ctxNow + SCHEDULE_HORIZON_SEC + 0.1) break;

      const tc = absoluteToSyncFrame(frameMediaSec, fpsLabel, offset);
      // Keep DF flag from project FPS (absoluteToSyncFrame already does).
      const bits = encodeLtcFrameBits(tc);
      const spb = ctx.sampleRate / (fps * 80);
      const pcm = ltcBitsToBiphasePcm(bits, spb);
      const buf = ctx.createBuffer(1, pcm.length, ctx.sampleRate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) {
        ch[i] = pcm[i]! * LTC_PEAK;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const t0 = Math.max(when, ctxNow);
      src.connect(merger, 0, this.boundChannelIndex);
      try {
        src.start(t0);
      } catch {
        try {
          src.disconnect();
        } catch {
          /* ignore */
        }
        frameIndex += 1;
        this.nextFrameIndex = frameIndex;
        continue;
      }
      this.pending.push(src);
      src.onended = () => {
        const i = this.pending.indexOf(src);
        if (i >= 0) this.pending.splice(i, 1);
        try {
          src.disconnect();
        } catch {
          /* ignore */
        }
      };
      // Cap pending queue so seek storms cannot accumulate nodes.
      while (this.pending.length > 48) {
        const old = this.pending.shift();
        if (!old) break;
        try {
          old.stop();
        } catch {
          /* ignore */
        }
        try {
          old.disconnect();
        } catch {
          /* ignore */
        }
      }

      this.lastTc = tc;
      scheduled += 1;
      frameIndex += 1;
      this.nextFrameIndex = frameIndex;
      if (scheduled > 24) break;
    }

    if (scheduled > 0 && this.lastTc) {
      this.emitStatus({
        flavour: "ltc",
        armed: true,
        emitting: true,
        tc: this.lastTc,
        tcDisplay: formatSyncTimecode(this.lastTc),
        detail: this.routeDetail("Generating (transport-locked)"),
      });
    }
  }

  private async ensureGraph(): Promise<void> {
    const deviceId = this.opts.getOutputDeviceId?.() || null;
    const wantCh = Math.max(
      0,
      Math.floor(this.opts.getOutputChannelIndex?.() ?? 0),
    );

    if (
      this.ctx &&
      this.merger &&
      this.boundDeviceId === (deviceId || "") &&
      this.boundChannelIndex ===
        Math.min(wantCh, Math.max(0, this.boundChannelCount - 1))
    ) {
      if (this.ctx.state === "suspended") {
        await this.ctx.resume().catch(() => undefined);
      }
      return;
    }

    await this.teardownGraph();

    const Ctx =
      window.AudioContext ||
      (
        window as unknown as {
          webkitAudioContext: typeof AudioContext;
        }
      ).webkitAudioContext;

    let ctx: AudioContextWithSink;
    try {
      // Chromium: construct with sinkId when available.
      ctx = deviceId
        ? new (Ctx as unknown as {
            new (opts?: AudioContextOptions & { sinkId?: string }): AudioContextWithSink;
          })({ sinkId: deviceId })
        : new Ctx();
    } catch {
      ctx = new Ctx();
    }
    this.ctx = ctx;

    if (deviceId && typeof ctx.setSinkId === "function") {
      try {
        await ctx.setSinkId(deviceId);
      } catch (err) {
        await ctx.close().catch(() => undefined);
        this.ctx = null;
        throw new Error(
          `Cannot bind LTC output device: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (ctx.state === "suspended") {
      await ctx.resume().catch(() => undefined);
    }

    const maxCh = Math.max(1, ctx.destination.maxChannelCount || 2);
    const channelCount = Math.min(Math.max(wantCh + 1, 1), maxCh);
    this.boundChannelCount = channelCount;
    this.boundChannelIndex = Math.min(wantCh, channelCount - 1);
    this.boundDeviceId = deviceId || "";

    try {
      ctx.destination.channelCount = channelCount;
      ctx.destination.channelCountMode = "explicit";
      ctx.destination.channelInterpretation = "discrete";
    } catch {
      // Some sinks reject explicit channelCount — merger still helps.
    }

    const merger = ctx.createChannelMerger(channelCount);
    try {
      merger.channelCount = 1;
      merger.channelCountMode = "explicit";
      merger.channelInterpretation = "discrete";
    } catch {
      /* ignore */
    }
    merger.connect(ctx.destination);
    this.merger = merger;
  }

  private async teardownGraph(): Promise<void> {
    this.clearPending();
    if (this.merger) {
      try {
        this.merger.disconnect();
      } catch {
        /* ignore */
      }
      this.merger = null;
    }
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      await ctx.close().catch(() => undefined);
    }
    this.boundDeviceId = null;
    this.boundChannelCount = 2;
    this.boundChannelIndex = 0;
  }
}

function looksLikeDedicatedTcOutput(label: string): boolean {
  const s = label.toLowerCase();
  return (
    s.includes("blackhole") ||
    s.includes("loopback") ||
    s.includes("soundflower") ||
    s.includes("dante") ||
    s.includes("soundgrid") ||
    s.includes("vb-audio") ||
    s.includes("cable") ||
    s.includes("aggregate") ||
    /\bltc\b/.test(s)
  );
}

function looksLikeBuiltinSpeakers(label: string): boolean {
  const s = label.toLowerCase();
  return (
    s.includes("macbook") ||
    s.includes("built-in") ||
    s.includes("builtin") ||
    s.includes("speakers") ||
    s.includes("headphones") ||
    s.includes("airpods") ||
    s.includes("display audio")
  );
}

async function probeOutputChannelCount(deviceId: string): Promise<number> {
  const Ctx =
    window.AudioContext ||
    (
      window as unknown as {
        webkitAudioContext: typeof AudioContext;
      }
    ).webkitAudioContext;
  let ctx: AudioContextWithSink | null = null;
  try {
    try {
      ctx = new (Ctx as unknown as {
        new (opts?: AudioContextOptions & { sinkId?: string }): AudioContextWithSink;
      })({ sinkId: deviceId });
    } catch {
      ctx = new Ctx();
      if (typeof ctx.setSinkId === "function") {
        await ctx.setSinkId(deviceId);
      }
    }
    const max = ctx.destination.maxChannelCount || 2;
    return Math.max(1, max);
  } catch {
    return 2;
  } finally {
    if (ctx) await ctx.close().catch(() => undefined);
  }
}

// --- MTC out (Web MIDI quarter-frames) ----------------------------------------

export interface MtcGeneratorOptions {
  getProjectFps: () => FrameRateLabel;
  getShowTcOffsetSec: () => number;
  getMediaTime: () => number;
  getMidiOutputId?: () => string | null;
}

/**
 * Sends continuous MTC quarter-frames locked to Internal media time + TC offset.
 * Safe in Chromium / Electron (macOS first). Does not touch TimecodeSync chase.
 *
 * Spec: 8 QF messages (0xF1) span two video frames at 4× frame rate. Each
 * 8-message group encodes the TC at the start of that two-frame window.
 */
export class MtcGenerator implements TimecodeOutControls {
  private opts: MtcGeneratorOptions;
  private listener: GenerateStatusListener | null = null;
  private status: GenerateStatusSnapshot = emptyGenerateStatus("mtc");
  private armed = false;
  private playing = false;
  private midiAccess: MIDIAccess | null = null;
  private output: MIDIOutput | null = null;
  private timer: number | null = null;
  /** Next absolute quarter-frame index (show-timebase: showSec * 4 * fps). */
  private nextQfIndex: number | null = null;
  private lastTc: SyncTimecodeFrame | null = null;
  private boundOutputId: string | null = null;
  private boundOutputName = "";

  constructor(opts: MtcGeneratorOptions) {
    this.opts = opts;
  }

  getStatus(): GenerateStatusSnapshot {
    return this.status;
  }

  onStatus(fn: GenerateStatusListener | null): void {
    this.listener = fn;
  }

  isArmed(): boolean {
    return this.armed;
  }

  async setArmed(armed: boolean): Promise<void> {
    if (armed === this.armed) return;
    this.armed = armed;
    if (!armed) {
      this.stopScheduler();
      this.releaseOutput();
      this.emitStatus({
        ...emptyGenerateStatus("mtc"),
        armed: false,
        detail: "MTC out disarmed",
      });
      return;
    }
    try {
      await this.ensureOutput();
      this.emitStatus({
        flavour: "mtc",
        armed: true,
        emitting: false,
        tc: null,
        tcDisplay: null,
        detail: this.routeDetail("Armed — waiting for Play"),
      });
      if (this.playing) this.startScheduler();
    } catch (err) {
      this.armed = false;
      const msg = err instanceof Error ? err.message : String(err);
      this.releaseOutput();
      this.emitStatus({
        flavour: "mtc",
        armed: false,
        emitting: false,
        tc: null,
        tcDisplay: null,
        detail: msg,
      });
      throw err;
    }
  }

  setPlaying(playing: boolean): void {
    this.playing = playing;
    if (playing) {
      if (this.armed) {
        void this.ensureOutput()
          .then(() => this.startScheduler())
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            this.emitStatus({
              ...this.status,
              armed: this.armed,
              emitting: false,
              detail: msg,
            });
          });
      }
    } else {
      this.stopScheduler();
      if (this.armed) {
        this.emitStatus({
          flavour: "mtc",
          armed: true,
          emitting: false,
          tc: this.lastTc,
          tcDisplay: this.lastTc ? formatSyncTimecode(this.lastTc) : null,
          detail: this.routeDetail("Armed — paused (transport-locked)"),
        });
      }
    }
  }

  resync(): void {
    this.nextQfIndex = null;
    if (this.armed && this.playing) this.tick();
  }

  async applyRoute(): Promise<void> {
    if (!this.armed) return;
    this.stopScheduler();
    this.releaseOutput();
    await this.ensureOutput();
    this.emitStatus({
      flavour: "mtc",
      armed: true,
      emitting: false,
      tc: null,
      tcDisplay: null,
      detail: this.playing
        ? this.routeDetail("Route updated — generating")
        : this.routeDetail("Armed — waiting for Play"),
    });
    if (this.playing) this.startScheduler();
  }

  /** Under Play gesture: request MIDI access early (non-blocking). */
  primeFromGesture(): void {
    if (!this.armed) return;
    void this.ensureOutput().catch(() => undefined);
  }

  dispose(): void {
    this.armed = false;
    this.playing = false;
    this.stopScheduler();
    this.releaseOutput();
    this.listener = null;
  }

  /** Enumerate Web MIDI output ports for the MTC out picker. */
  static async listMidiOutputs(): Promise<MidiOutputInfo[]> {
    if (!navigator.requestMIDIAccess) return [];
    try {
      const access = await navigator.requestMIDIAccess({ sysex: false });
      return [...access.outputs.values()].map((o) => ({
        id: o.id,
        name: o.name || o.id,
        manufacturer: o.manufacturer || "",
      }));
    } catch {
      return [];
    }
  }

  /** Prefer IAC / virtual MIDI cables when picking a default Out. */
  static pickDefaultOutputId(outputs: MidiOutputInfo[]): string {
    if (outputs.length === 0) return "";
    const preferred = outputs.find((o) => looksLikeDedicatedMidiOut(o.name));
    return (preferred ?? outputs[0]!).id;
  }

  // --- internals -------------------------------------------------------------

  private emitStatus(next: GenerateStatusSnapshot): void {
    this.status = next;
    this.listener?.(next);
  }

  private routeDetail(suffix: string): string {
    const name = this.boundOutputName || this.boundOutputId || "?";
    const short =
      name.length > 28 ? `${name.slice(0, 26)}…` : name;
    return `MTC OUT ${short} — ${suffix}`;
  }

  private startScheduler(): void {
    this.stopScheduler();
    if (!this.armed || !this.playing) return;
    this.nextQfIndex = null;
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  private stopScheduler(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.nextQfIndex = null;
  }

  private tick(): void {
    const output = this.output;
    if (!output || !this.armed || !this.playing) return;
    if (output.state === "disconnected") {
      this.emitStatus({
        flavour: "mtc",
        armed: true,
        emitting: false,
        tc: this.lastTc,
        tcDisplay: this.lastTc ? formatSyncTimecode(this.lastTc) : null,
        detail: "MIDI output disconnected",
      });
      return;
    }

    const fpsLabel = this.opts.getProjectFps();
    const info = frameRateInfo(fpsLabel);
    const fps = info.fps;
    if (!(fps > 0)) return;
    const offset = this.opts.getShowTcOffsetSec() || 0;
    const mediaNow = this.opts.getMediaTime();
    if (!Number.isFinite(mediaNow)) return;

    const showNow = Math.max(0, mediaNow) + offset;
    // Quarter-frame index on the show timebase (4 QFs per frame period).
    const qfNow = Math.floor(showNow * 4 * fps + 1e-9);
    if (this.nextQfIndex == null) {
      // Align to the start of an 8-QF group so receivers get a clean sequence.
      this.nextQfIndex = Math.floor(qfNow / 8) * 8;
      if (this.nextQfIndex < qfNow - 2) this.nextQfIndex += 8;
    } else if (
      this.nextQfIndex < qfNow - 8 ||
      this.nextQfIndex > qfNow + 64
    ) {
      this.nextQfIndex = Math.floor(qfNow / 8) * 8;
    }

    const untilShow = showNow + SCHEDULE_HORIZON_SEC;
    const untilQf = Math.floor(untilShow * 4 * fps + 1e-9);
    const wallNow = performance.now();
    let scheduled = 0;
    let qfIndex = this.nextQfIndex ?? qfNow;

    // Cache encode for the current 8-QF group.
    let cachedGroup = -1;
    let cachedBytes: number[] = [];

    while (qfIndex <= untilQf) {
      const type = qfIndex & 0x7;
      const group = Math.floor(qfIndex / 8);
      const groupShowSec = (group * 8) / (4 * fps);
      const sendShowSec = qfIndex / (4 * fps);
      const sendMediaSec = sendShowSec - offset;
      const whenMs = wallNow + (sendMediaSec - mediaNow) * 1000;

      if (whenMs < wallNow - 40) {
        qfIndex += 1;
        this.nextQfIndex = qfIndex;
        continue;
      }
      if (whenMs > wallNow + (SCHEDULE_HORIZON_SEC + 0.1) * 1000) break;

      if (group !== cachedGroup) {
        const frameMediaSec = groupShowSec - offset;
        const tc = absoluteToSyncFrame(frameMediaSec, fpsLabel, offset);
        cachedBytes = encodeMtcQuarterFrameData(tc);
        cachedGroup = group;
        this.lastTc = tc;
      }

      const dataByte = cachedBytes[type];
      if (dataByte == null) {
        qfIndex += 1;
        this.nextQfIndex = qfIndex;
        continue;
      }

      try {
        // Web MIDI timestamp shares the performance.now() timebase.
        output.send([MTC_QF_STATUS, dataByte], Math.max(whenMs, wallNow));
      } catch {
        qfIndex += 1;
        this.nextQfIndex = qfIndex;
        continue;
      }

      scheduled += 1;
      qfIndex += 1;
      this.nextQfIndex = qfIndex;
      if (scheduled > 48) break;
    }

    if (scheduled > 0 && this.lastTc) {
      this.emitStatus({
        flavour: "mtc",
        armed: true,
        emitting: true,
        tc: this.lastTc,
        tcDisplay: formatSyncTimecode(this.lastTc),
        detail: this.routeDetail("Generating (transport-locked)"),
      });
    }
  }

  private async ensureOutput(): Promise<void> {
    const wantId = this.opts.getMidiOutputId?.() || null;
    if (
      this.output &&
      this.midiAccess &&
      this.boundOutputId === (wantId || "") &&
      this.output.state === "connected"
    ) {
      return;
    }

    this.releaseOutput();

    if (!navigator.requestMIDIAccess) {
      throw new Error("Web MIDI unavailable in this browser");
    }
    const access = await navigator.requestMIDIAccess({ sysex: false });
    this.midiAccess = access;
    const outputs = [...access.outputs.values()];
    if (outputs.length === 0) {
      throw new Error("No MIDI outputs found");
    }
    const preferred = wantId
      ? outputs.find((o) => o.id === wantId)
      : null;
    const output = preferred ?? outputs[0]!;
    this.output = output;
    this.boundOutputId = output.id;
    this.boundOutputName = output.name || output.id;

    access.onstatechange = () => {
      if (!this.armed) return;
      if (this.output && this.output.state === "disconnected") {
        this.emitStatus({
          flavour: "mtc",
          armed: true,
          emitting: false,
          tc: this.lastTc,
          tcDisplay: this.lastTc ? formatSyncTimecode(this.lastTc) : null,
          detail: "MIDI output disconnected",
        });
      }
    };
  }

  private releaseOutput(): void {
    // Do not close MIDIAccess — Sync chase may share the browser MIDI stack.
    if (this.midiAccess) {
      this.midiAccess.onstatechange = null;
    }
    this.output = null;
    this.midiAccess = null;
    this.boundOutputId = null;
    this.boundOutputName = "";
  }
}

function looksLikeDedicatedMidiOut(name: string): boolean {
  const s = name.toLowerCase();
  return (
    s.includes("iac") ||
    s.includes("loopback") ||
    s.includes("bus") ||
    s.includes("virtual") ||
    s.includes("loop") ||
    /\bmtc\b/.test(s)
  );
}

/**
 * Facade over LTC + MTC generate. App keeps one ref; flavour switches disarm
 * the previous backend so only one outgoing clock is live.
 */
export class GenerateController implements TimecodeOutControls {
  private ltc: LtcGenerator;
  private mtc: MtcGenerator;
  private flavour: GenerateFlavour = "ltc";
  private listener: GenerateStatusListener | null = null;
  private playing = false;

  constructor(opts: {
    ltc: LtcGeneratorOptions;
    mtc: MtcGeneratorOptions;
  }) {
    this.ltc = new LtcGenerator(opts.ltc);
    this.mtc = new MtcGenerator(opts.mtc);
    this.ltc.onStatus((s) => {
      if (this.flavour === "ltc") this.listener?.(s);
    });
    this.mtc.onStatus((s) => {
      if (this.flavour === "mtc") this.listener?.(s);
    });
  }

  getFlavour(): GenerateFlavour {
    return this.flavour;
  }

  /**
   * Switch outgoing flavour. Disarms the previous backend first so LTC audio
   * and MTC MIDI never emit at the same time from Generate.
   */
  async setFlavour(flavour: GenerateFlavour): Promise<void> {
    if (flavour === this.flavour) return;
    const prev = this.active();
    if (prev.isArmed()) {
      await prev.setArmed(false);
    }
    this.flavour = flavour;
    const next = this.active();
    next.setPlaying(this.playing);
    const snap = emptyGenerateStatus(flavour);
    this.listener?.(snap);
  }

  getStatus(): GenerateStatusSnapshot {
    return this.active().getStatus();
  }

  onStatus(fn: GenerateStatusListener | null): void {
    this.listener = fn;
  }

  isArmed(): boolean {
    return this.active().isArmed();
  }

  async setArmed(armed: boolean): Promise<void> {
    await this.active().setArmed(armed);
  }

  setPlaying(playing: boolean): void {
    this.playing = playing;
    // Keep both backends aware so a flavour switch mid-play resumes correctly.
    this.ltc.setPlaying(playing);
    this.mtc.setPlaying(playing);
  }

  resync(): void {
    this.ltc.resync();
    this.mtc.resync();
  }

  async applyRoute(): Promise<void> {
    await this.active().applyRoute();
  }

  primeFromGesture(): void {
    this.active().primeFromGesture();
  }

  dispose(): void {
    this.ltc.dispose();
    this.mtc.dispose();
    this.listener = null;
  }

  private active(): TimecodeOutControls {
    return this.flavour === "mtc" ? this.mtc : this.ltc;
  }
}
