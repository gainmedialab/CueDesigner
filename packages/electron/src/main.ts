import { app, BrowserWindow, shell } from "electron";
import * as path from "node:path";
import * as fs from "node:fs";

const isDev = !app.isPackaged;

function webDistIndex(): string {
  // Prefer built web package (workspace sibling)
  const candidates = [
    path.join(__dirname, "..", "..", "web", "dist", "index.html"),
    path.join(__dirname, "..", "renderer", "index.html"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0]!;
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: "CueDesigner",
    backgroundColor: "#0e1218",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    show: false,
  });

  win.once("ready-to-show", () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev && process.env.CUEDESIGNER_DEV_URL) {
    void win.loadURL(process.env.CUEDESIGNER_DEV_URL);
  } else {
    void win.loadFile(webDistIndex());
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
