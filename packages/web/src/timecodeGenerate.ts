/**
 * Outgoing timecode generate (MVP: LTC out via Web Audio).
 *
 * Transport-locked: emits only while Internal transport is playing and Generate
 * is armed. Uses a dedicated AudioContext (never the show-media element path)
 * with optional setSinkId + ChannelMerger so LTC can target a specific
 * output device/channel — not the default FOH/monitor mix.
 *
 * MTC out is stubbed in the UI/docs; encode helpers live in @cuedesigner/core.
 */

import {
  absoluteToSyncFrame,
  encodeLtcFrameBits,
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
        : "MTC out not shipped yet (use LTC)",
  };
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
export class LtcGenerator {
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
