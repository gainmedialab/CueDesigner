import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  session,
  shell,
} from "electron";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

const isDev = !app.isPackaged;
const DEV_URL = process.env.CUEDESIGNER_DEV_URL?.trim() || "";

/** Offline show machines: keep chase / audio clocks alive when unfocused. */
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

type BridgedFileAction =
  | "new"
  | "open"
  | "open-shared"
  | "save"
  | "share"
  | "export";

/** Payload for Open / Open Shared (native dialog + file bytes). */
type FileOpenPayload = {
  action: "open" | "open-shared";
  name: string;
  /** Base64 file bytes — structured-clone safe across contextBridge. */
  base64: string;
};

type FileBridgePayload = BridgedFileAction | FileOpenPayload;

function asBrowserWindow(
  win: BrowserWindow | Electron.BaseWindow | null | undefined,
): BrowserWindow | null {
  if (!win || win.isDestroyed()) return null;
  // Menu click typings use BaseWindow; CueDesigner only creates BrowserWindows.
  if (win instanceof BrowserWindow) return win;
  return null;
}

function resolveTargetWindow(
  browserWindow?: BrowserWindow | Electron.BaseWindow | null,
): BrowserWindow | null {
  const fromMenu = asBrowserWindow(browserWindow ?? null);
  if (fromMenu) return fromMenu;
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  const [first] = BrowserWindow.getAllWindows();
  return first && !first.isDestroyed() ? first : null;
}

/**
 * Deliver File-menu payloads:
 * - Always IPC (`cue:file`) for preload listeners.
 * - String actions also get a `cuedesigner-file` CustomEvent (same dual-path
 *   as shortcut nudges) so a stale preload cannot silently drop New/Save/etc.
 * - Open payloads stay IPC-only (base64 can be large).
 */
function deliverFilePayload(
  win: BrowserWindow,
  payload: FileBridgePayload,
): void {
  win.webContents.send("cue:file", payload);
  if (typeof payload !== "string") return;
  void win.webContents
    .executeJavaScript(
      `window.dispatchEvent(new CustomEvent('cuedesigner-file',{detail:${JSON.stringify(payload)}}))`,
    )
    .catch((err) => {
      console.warn("[CueDesigner] cuedesigner-file dispatch failed:", err);
    });
}

function sendFileAction(
  action: BridgedFileAction,
  browserWindow?: BrowserWindow | Electron.BaseWindow | null,
): void {
  const win = resolveTargetWindow(browserWindow);
  if (!win) {
    console.warn(`[CueDesigner] File "${action}" — no BrowserWindow`);
    return;
  }
  console.log(`[CueDesigner] File menu → ${action}`);
  deliverFilePayload(win, action);
}

async function openWithNativeDialog(
  action: "open" | "open-shared",
  browserWindow?: BrowserWindow | Electron.BaseWindow | null,
): Promise<void> {
  const win = resolveTargetWindow(browserWindow);
  if (!win) {
    console.warn(`[CueDesigner] File "${action}" — no BrowserWindow`);
    return;
  }
  const result = await dialog.showOpenDialog(win, {
    title: action === "open" ? "Open Project" : "Open Shared Package",
    properties: ["openFile"],
    filters:
      action === "open"
        ? [
            { name: "CueDesigner Project", extensions: ["json"] },
            { name: "All Files", extensions: ["*"] },
          ]
        : [
            { name: "CueDesigner Share", extensions: ["zip"] },
            { name: "All Files", extensions: ["*"] },
          ],
  });
  if (result.canceled || result.filePaths.length === 0) return;
  const filePath = result.filePaths[0]!;
  try {
    const buf = await fsp.readFile(filePath);
    const payload: FileOpenPayload = {
      action,
      name: path.basename(filePath),
      base64: buf.toString("base64"),
    };
    console.log(
      `[CueDesigner] File menu → ${action} (${payload.name}, ${buf.length} bytes)`,
    );
    deliverFilePayload(win, payload);
  } catch (err) {
    console.error(`[CueDesigner] Failed to read ${filePath}:`, err);
    dialog.showErrorBox(
      "Open failed",
      err instanceof Error ? err.message : String(err),
    );
  }
}

function wireFileIpc(): void {
  ipcMain.handle(
    "cue:save-file",
    async (
      event,
      opts: { defaultPath?: string; data?: ArrayBuffer | Uint8Array },
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!opts?.data) return { ok: false as const, reason: "no-data" };
      const saveOpts: Electron.SaveDialogOptions = {
        defaultPath: opts.defaultPath || "show.cueproj.json",
      };
      const result =
        win && !win.isDestroyed()
          ? await dialog.showSaveDialog(win, saveOpts)
          : await dialog.showSaveDialog(saveOpts);
      if (result.canceled || !result.filePath) {
        return { ok: false as const, reason: "canceled" };
      }
      const bytes =
        opts.data instanceof ArrayBuffer
          ? Buffer.from(new Uint8Array(opts.data))
          : Buffer.from(opts.data);
      await fsp.writeFile(result.filePath, bytes);
      return { ok: true as const, filePath: result.filePath };
    },
  );
}

/**
 * Standard macOS/Win menu — File owns New/Open/Save/Share/Export (HIG).
 * Copy stays ⌘/Ctrl+C (never bare C).
 */
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
      submenu: [
        {
          label: "New",
          accelerator: "CmdOrControl+N",
          click: (_item, browserWindow) =>
            sendFileAction("new", browserWindow),
        },
        {
          label: "Open…",
          accelerator: "CmdOrControl+O",
          click: (_item, browserWindow) => {
            void openWithNativeDialog("open", browserWindow);
          },
        },
        {
          label: "Open Shared…",
          accelerator: "CmdOrControl+Shift+O",
          click: (_item, browserWindow) => {
            void openWithNativeDialog("open-shared", browserWindow);
          },
        },
        { type: "separator" },
        {
          label: "Save",
          accelerator: "CmdOrControl+S",
          click: (_item, browserWindow) =>
            sendFileAction("save", browserWindow),
        },
        {
          label: "Share…",
          accelerator: "CmdOrControl+Shift+S",
          click: (_item, browserWindow) =>
            sendFileAction("share", browserWindow),
        },
        { type: "separator" },
        {
          label: "Export…",
          accelerator: "CmdOrControl+E",
          click: (_item, browserWindow) =>
            sendFileAction("export", browserWindow),
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
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
    console.log(
      "[CueDesigner] File menu → cue:file IPC (+ cuedesigner-file for New/Save/Share/Export)",
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
    wireFileIpc();
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
