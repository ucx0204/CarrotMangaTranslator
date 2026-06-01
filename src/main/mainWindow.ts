import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { logError, writeLog } from "./logger";

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1240,
    minHeight: 760,
    backgroundColor: "#101114",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  window.webContents.on("console-message", (details) => {
    const level =
      details.level === "warning" ? "warn" : details.level === "error" ? "error" : details.level === "debug" ? "debug" : "info";
    writeLog(level, "renderer console", {
      message: details.message,
      line: details.lineNumber,
      sourceId: details.sourceId
    });
  });

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    logError("Renderer failed to load", { errorCode, errorDescription, validatedURL });
  });

  window.setMenuBarVisibility(false);

  const devRendererUrl = resolveAllowedDevRendererUrl(process.env.ELECTRON_RENDERER_URL);
  if (devRendererUrl) {
    void window.loadURL(devRendererUrl);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return window;
}

function resolveAllowedDevRendererUrl(value: string | undefined): string | null {
  if (app.isPackaged || !value) {
    return null;
  }
  try {
    const url = new URL(value);
    const allowedHost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
    return url.protocol === "http:" && allowedHost ? url.toString() : null;
  } catch {
    return null;
  }
}
