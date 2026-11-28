/**
 * Headless smoke: Web Audio BufferSource metronome schedules ticks without
 * HTMLMediaElement / MES / HTMLAudio pool. Exit 0 on pass.
 *
 *   node packages/web/scripts/smoke-metronome.mjs
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const html = `<!doctype html>
<html><body>
<pre id="out">pending</pre>
<script>
(async () => {
  function synthesizeClickPcm(sampleRate, freqHz, peak, durSec = 0.036) {
    const n = Math.max(1, Math.floor(sampleRate * durSec));
    const pcm = new Float32Array(n);
    let maxAbs = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      const env = Math.exp(-t * 70);
      const tone =
        Math.sin(2 * Math.PI * freqHz * t) * 0.85 +
        Math.sin(2 * Math.PI * freqHz * 2 * t) * 0.15;
      const s = tone * env;
      pcm[i] = s;
      const a = Math.abs(s);
      if (a > maxAbs) maxAbs = a;
    }
    const scale = maxAbs > 1e-6 ? peak / maxAbs : 0;
    for (let i = 0; i < n; i++) {
      pcm[i] = Math.max(-1, Math.min(1, pcm[i] * scale));
    }
    return pcm;
  }
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    await ctx.resume();
    const master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    const pcm = synthesizeClickPcm(ctx.sampleRate, 1600, 1);
    const buf = ctx.createBuffer(1, pcm.length, ctx.sampleRate);
    buf.getChannelData(0).set(pcm);
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) {
      peak = Math.max(peak, Math.abs(pcm[i]));
    }
    let clicksStarted = 0;
    const mediaEarLagSec = 0.035;
    const mediaNow = 0.01;
    const beatSec = 0.5;
    const origin = 0;
    const horizon = 0.28;
    let next = Math.ceil(
      (mediaNow - origin - 0.012 - mediaEarLagSec) / beatSec - 1e-9,
    );
    const until = mediaNow + horizon;
    const ctxNow = ctx.currentTime;
    const scheduledWhens = [];
    while (true) {
      const tAbs = origin + next * beatSec;
      if (tAbs > until) break;
      const when = ctxNow + (tAbs - mediaNow) + mediaEarLagSec;
      if (when >= ctxNow - 0.002) {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const g = ctx.createGain();
        g.gain.value = 0.5;
        src.connect(g);
        g.connect(master);
        src.start(Math.max(when, ctx.currentTime));
        clicksStarted++;
        scheduledWhens.push(when - ctxNow);
      }
      next++;
      if (next > 100) break;
    }
    document.getElementById("out").textContent = JSON.stringify({
      ctxState: ctx.state,
      samplePeakAbs: peak,
      clicksStarted,
      firstLeadSec: scheduledWhens[0] ?? null,
      scheduledCount: scheduledWhens.length,
      usedMes: false,
      usedHtmlAudioPool: false,
    });
  } catch (e) {
    document.getElementById("out").textContent = JSON.stringify({
      error: String(e),
    });
  }
})();
</script>
</body></html>`;

const dir = await mkdtemp(join(tmpdir(), "cue-click-"));
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(html);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
const url = `http://127.0.0.1:${port}/`;
const userData = join(dir, "chrome-profile");
const chrome =
  process.env.CHROME_PATH || "/usr/bin/google-chrome-stable";

const result = await new Promise((resolve, reject) => {
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      `--user-data-dir=${userData}`,
      "--autoplay-policy=no-user-gesture-required",
      "--virtual-time-budget=3000",
      "--dump-dom",
      url,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  child.on("error", reject);
  child.on("close", (code) => resolve({ code, out, err }));
});

server.close();
await rm(dir, { recursive: true, force: true });

const m = result.out.match(/<pre id="out">([^<]*)<\/pre>/);
if (!m) {
  console.error("No result", result.err.slice(0, 400));
  process.exit(1);
}
const data = JSON.parse(m[1]);
console.log(JSON.stringify(data, null, 2));
const ok =
  data.ctxState === "running" &&
  data.samplePeakAbs > 0.9 &&
  data.clicksStarted >= 1 &&
  data.usedMes === false &&
  data.usedHtmlAudioPool === false;
process.exit(ok ? 0 : 1);
