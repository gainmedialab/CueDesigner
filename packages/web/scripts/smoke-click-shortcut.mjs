/**
 * Headless: open built web UI, press C via CDP, assert Click checkbox toggles.
 *   node packages/web/scripts/smoke-click-shortcut.mjs
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, "../dist");
if (!existsSync(join(dist, "index.html"))) {
  console.error("Missing packages/web/dist — run npm run build -w @cuedesigner/web");
  process.exit(1);
}

const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const server = createServer(async (req, res) => {
  const u = new URL(req.url || "/", "http://127.0.0.1");
  let rel = decodeURIComponent(u.pathname);
  if (rel === "/") rel = "/index.html";
  const file = join(dist, rel.replace(/^\//, ""));
  if (!file.startsWith(dist) || !existsSync(file)) {
    res.writeHead(404);
    res.end("missing");
    return;
  }
  const ext = file.slice(file.lastIndexOf("."));
  res.writeHead(200, { "content-type": mime[ext] || "application/octet-stream" });
  res.end(await readFile(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const pageUrl = `http://127.0.0.1:${port}/`;

const dir = await mkdtemp(join(tmpdir(), "cue-c-cdp-"));
const userData = join(dir, "profile");
const chrome = process.env.CHROME_PATH || "/usr/bin/google-chrome-stable";
const debugPort = 9222 + Math.floor(Math.random() * 1000);

const chromeProc = spawn(
  chrome,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    `--user-data-dir=${userData}`,
    `--remote-debugging-port=${debugPort}`,
    "--autoplay-policy=no-user-gesture-required",
    pageUrl,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);

async function waitForDebugger(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page" && t.url?.startsWith("http"));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("CDP not ready");
}

function cdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", reject);
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  async function send(method, params = {}) {
    await ready;
    const id = nextId++;
    const p = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    ws.send(JSON.stringify({ id, method, params }));
    return p;
  }
  return {
    send,
    close: () => ws.close(),
  };
}

let result;
try {
  const wsUrl = await waitForDebugger();
  const cdp = cdpSession(wsUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  // Wait for React mount + Click checkbox.
  for (let i = 0; i < 40; i++) {
    const probe = await cdp.send("Runtime.evaluate", {
      expression:
        `!!document.querySelector('[data-testid="metronome-click"]')`,
      returnByValue: true,
    });
    if (probe.result?.value) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await cdp.send("Runtime.evaluate", {
    expression: `document.body.focus(); document.body.click();`,
    returnByValue: true,
  });

  const readChecked = async () => {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-testid="metronome-click"]').checked`,
      returnByValue: true,
    });
    return r.result?.value;
  };

  const pressC = async () => {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      windowsVirtualKeyCode: 67,
      code: "KeyC",
      key: "c",
      text: "c",
      unmodifiedText: "c",
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      windowsVirtualKeyCode: 67,
      code: "KeyC",
      key: "c",
    });
  };

  const before = await readChecked();
  await pressC();
  await new Promise((r) => setTimeout(r, 120));
  const afterOn = await readChecked();
  await pressC();
  await new Promise((r) => setTimeout(r, 120));
  const afterOff = await readChecked();

  // Also verify desktop bridge CustomEvent path (Electron uses this).
  await cdp.send("Runtime.evaluate", {
    expression: `window.dispatchEvent(new CustomEvent('cuedesigner-shortcut',{detail:{action:'toggle-click'}}))`,
    returnByValue: true,
  });
  await new Promise((r) => setTimeout(r, 120));
  const afterBridge = await readChecked();

  result = { before, afterOn, afterOff, afterBridge };
  cdp.close();
} catch (err) {
  console.error(err);
  result = { error: String(err) };
} finally {
  try {
    chromeProc.kill("SIGKILL");
  } catch {
    // ignore
  }
  server.close();
  await new Promise((r) => setTimeout(r, 200));
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

console.log(JSON.stringify(result, null, 2));
const ok =
  result &&
  result.before === false &&
  result.afterOn === true &&
  result.afterOff === false &&
  result.afterBridge === true;
process.exit(ok ? 0 : 1);
