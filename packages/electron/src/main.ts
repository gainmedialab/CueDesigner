import { app, BrowserWindow, session, shell } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

const isDev = !app.isPackaged;
const DEV_URL = process.env.CUEDESIGNER_DEV_URL?.trim() || "";

/** Offline show machines: keep chase / audio clocks alive when unfocused. */
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

function webDistIndex(): string {
  // Unpackaged (`electron .` after npm run build): ALWAYS prefer the workspace
  // web dist. A leftover packages/electron/renderer/ from package:mac /
  // prepare:renderer used to win here and silently served a stale UI — Follow
  // + zoom-to-playhead fixes looked like no-ops after rebuilding web only.
  const workspaceWeb = path.join(
    __dirname,
    "..",
    "..",
    "web",
    "dist",
    "index.html",
  );
  const packagedRenderer = path.join(__dirname, "..", "renderer", "index.html");

  if (!app.isPackaged) {
    const unpackaged = [workspaceWeb, packagedRenderer];
    for (const c of unpackaged) {
      if (fs.existsSync(c)) return c;
    }
    return workspaceWeb;
  }

  // Packaged .app: renderer is copied next to main by prepare-renderer.mjs
  if (fs.existsSync(packagedRenderer)) return packagedRenderer;
  if (fs.existsSync(workspaceWeb)) return workspaceWeb;
  return packagedRenderer;
}

function allowPermission(permission: string): boolean {
  // LTC uses getUserMedia; MTC uses Web MIDI (incl. sysex full-frame).
  switch (permission) {
    case "media":
    case "audioCapture":
    case "midi":
    case "midiSysex":
    case "clipboard-read":
    case "clipboard-sanitized-write":
      return true;
    default:
      return false;
  }
}

function createWindow(): void {
  const preload = path.join(__dirname, "preload.js");
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: "CueDesigner",
    backgroundColor: "#0e1218",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: fs.existsSync(preload) ? preload : undefined,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  win.once("ready-to-show", () => win.show());
  win.webContents.setBackgroundThrottling(false);

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // Stay on the local UI — no surprise navigations on a show machine.
  win.webContents.on("will-navigate", (event, url) => {
    const allowed =
      (DEV_URL && url.startsWith(DEV_URL)) ||
      url.startsWith("file://") ||
      url.startsWith("devtools://");
    if (!allowed) event.preventDefault();
  });

  if (isDev && DEV_URL) {
    console.log(`[CueDesigner] loading DEV_URL ${DEV_URL}`);
    void win.loadURL(DEV_URL);
  } else {
    const index = webDistIndex();
    if (!fs.existsSync(index)) {
      void win.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(
          `<h1>CueDesigner</h1><p>Missing renderer at <code>${index}</code>. ` +
            `Build the web UI (<code>npm run build -w @cuedesigner/web</code>) ` +
            `or set <code>CUEDESIGNER_DEV_URL</code>.</p>`,
        )}`,
      );
      return;
    }
    console.log(
      `[CueDesigner] loading ${app.isPackaged ? "packaged" : "unpackaged"} UI from ${index}`,
    );
    void win.loadFile(index);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    app.setName("CueDesigner");

    if (process.platform === "darwin") {
      app.setAboutPanelOptions({
        applicationName: "CueDesigner",
        applicationVersion: app.getVersion(),
        version: app.getVersion(),
        copyright: "Copyright © gainmedialab",
      });
    }

    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(allowPermission(permission));
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
      allowPermission(permission),
    );

    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
