import { app, BrowserWindow, Menu, session, shell } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

const isDev = !app.isPackaged;
const DEV_URL = process.env.CUEDESIGNER_DEV_URL?.trim() || "";

/** Offline show machines: keep chase / audio clocks alive when unfocused. */
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

/** Standard macOS/Win menu — Copy stays ⌘/Ctrl+C (never bare C). */
function installApplicationMenu(): void {
  const isMac = process.platform === "darwin";
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [isMac ? { role: "close" } : { role: "quit" }],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" }, // CommandOrControl+C — not bare C
        { role: "paste" },
        ...(isMac
          ? [
              { role: "pasteAndMatchStyle" as const },
              { role: "delete" as const },
              { role: "selectAll" as const },
            ]
          : [
              { role: "delete" as const },
              { type: "separator" as const },
              { role: "selectAll" as const },
            ]),
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? [
              { type: "separator" as const },
              { role: "front" as const },
            ]
          : [{ role: "close" as const }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

type BridgedDesktopAction =
  | "toggle-click"
  | "place-cue"
  | "place-cue-free";

/**
 * Bare letter keys must reach the page (Click = C, cue = N). While ⌘/Ctrl is
 * held, keep menu accelerators (Copy etc.). IPC-nudge claimed keys so macOS
 * menu handling cannot silently drop renderer keydown.
 */
function bridgedDesktopAction(input: {
  code: string;
  key: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
}): BridgedDesktopAction | null {
  if (input.control || input.meta) return null;
  const code = input.code || "";
  const key = (input.key || "").toLowerCase();
  // N allows Alt (free / unsnapped cue).
  if (code === "KeyN" || key === "n") {
    return input.alt ? "place-cue-free" : "place-cue";
  }
  if (input.alt) return null;
  if (code === "KeyC" || key === "c") return "toggle-click";
  return null;
}

function wireShortcutBridge(win: BrowserWindow): void {
  win.webContents.on("before-input-event", (event, input) => {
    const cmdCtrl = input.control || input.meta;
    // Electron docs: ignore menu shortcuts when typing without ⌘/Ctrl.
    win.webContents.setIgnoreMenuShortcuts(!cmdCtrl);

    if (input.type !== "keyDown" || input.isAutoRepeat) return;

    const action = bridgedDesktopAction(input);
    if (!action) return;

    // Claim the key — blocks menu from swallowing it. Renderer listens on
    // cue:shortcut (preload) and cuedesigner-shortcut (JS fallback); DOM
    // keydown may not fire after preventDefault.
    event.preventDefault();
    win.webContents.send("cue:shortcut", action);
    void win.webContents
      .executeJavaScript(
        `window.dispatchEvent(new CustomEvent('cuedesigner-shortcut',{detail:{action:${JSON.stringify(action)}}}))`,
      )
      .catch(() => undefined);
  });
}

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
  // LTC chase: getUserMedia. LTC generate: Web Audio output (setSinkId).
  // MTC chase: Web MIDI (incl. sysex full-frame). MTC generate: stubbed.
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
  wireShortcutBridge(win);

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
    console.log(
      "[CueDesigner] shortcut bridge: bare C → Click, N → cue at playhead (⌘C stays Copy)",
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
    installApplicationMenu();

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
