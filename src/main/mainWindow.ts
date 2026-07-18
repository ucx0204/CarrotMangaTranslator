import { app, BrowserWindow } from "electron";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { logError, writeLog } from "./logger";
import { tMainCommon } from "./i18n";
import type { ErrorReportContext } from "../shared/errorReportTypes";

export const UNRESPONSIVE_REPORT_DELAY_MS = 5_000;

export type RendererLoadFailure = {
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
};

export type MainWindowIncidentHandlers = {
  onRendererIncident?: (context: ErrorReportContext) => void;
  onRendererLoadFailure?: (failure: RendererLoadFailure) => void;
};

export type RendererLoadTarget = {
  devRendererUrl: string | null;
  productionRendererPath: string;
  allowedRendererUrl: string;
  windowIconPath: string | null;
};

export function resolveRendererLoadTarget(): RendererLoadTarget {
  const devRendererUrl = resolveAllowedDevRendererUrl(
    process.env.ELECTRON_RENDERER_URL,
  );
  const productionRendererPath = join(__dirname, "../renderer/index.html");
  const allowedRendererUrl =
    devRendererUrl ?? pathToFileURL(productionRendererPath).toString();
  return {
    devRendererUrl,
    productionRendererPath,
    allowedRendererUrl,
    windowIconPath: resolveWindowIconPath(),
  };
}

/** Shared web preferences for any renderer window (main or popped-out panel). */
export function rendererWebPreferences(): Electron.WebPreferences {
  return {
    preload: join(__dirname, "../preload/index.js"),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
  };
}

/** Applies the logging + navigation guards shared by all renderer windows. */
export function applyRendererWindowGuards(
  window: BrowserWindow,
  allowedRendererUrl: string,
): void {
  window.webContents.on("console-message", (details) => {
    const level =
      details.level === "warning"
        ? "warn"
        : details.level === "error"
          ? "error"
          : details.level === "debug"
            ? "debug"
            : "info";
    writeLog(level, "renderer console", {
      message: details.message,
      line: details.lineNumber,
      sourceId: details.sourceId,
    });
  });

  window.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL) => {
      logError("Renderer failed to load", {
        errorCode,
        errorDescription,
        validatedURL,
      });
    },
  );

  window.webContents.setWindowOpenHandler((details) => {
    writeLog("warn", "Blocked renderer window open", { url: details.url });
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (isAllowedMainWindowNavigation(url, allowedRendererUrl)) {
      return;
    }
    event.preventDefault();
    writeLog("warn", "Blocked renderer navigation", { url });
  });
}

/** Loads the renderer HTML into a window, optionally at a route hash. */
export function loadRendererIntoWindow(
  window: BrowserWindow,
  target: RendererLoadTarget,
  hash?: string,
): void {
  if (target.devRendererUrl) {
    void window.loadURL(
      hash ? `${target.devRendererUrl}#${hash}` : target.devRendererUrl,
    );
  } else {
    void window.loadFile(
      target.productionRendererPath,
      hash ? { hash } : undefined,
    );
  }
}

export function createMainWindow(
  incidentHandlers: MainWindowIncidentHandlers = {},
): BrowserWindow {
  const target = resolveRendererLoadTarget();
  const window = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1240,
    minHeight: 760,
    title: tMainCommon("app.title"),
    ...(target.windowIconPath ? { icon: target.windowIconPath } : {}),
    backgroundColor: "#101114",
    autoHideMenuBar: process.platform !== "darwin",
    webPreferences: rendererWebPreferences(),
  });

  applyRendererWindowGuards(window, target.allowedRendererUrl);
  applyMainWindowIncidentHandlers(window, incidentHandlers);
  if (process.platform !== "darwin") {
    window.setMenuBarVisibility(false);
  }
  loadRendererIntoWindow(window, target);
  return window;
}

function applyMainWindowIncidentHandlers(
  window: BrowserWindow,
  { onRendererIncident, onRendererLoadFailure }: MainWindowIncidentHandlers,
): void {
  let unresponsiveTimer: ReturnType<typeof setTimeout> | null = null;

  window.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") {
      return;
    }
    const message = `Renderer process terminated: ${details.reason} (exit ${details.exitCode})`;
    logError("Renderer process gone", details);
    onRendererIncident?.({
      source: "renderer-process",
      summary: "Renderer process stopped unexpectedly",
      message,
    });
  });

  window.on("unresponsive", () => {
    if (unresponsiveTimer) {
      return;
    }
    writeLog("warn", "Renderer window became unresponsive");
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null;
      if (window.isDestroyed()) {
        return;
      }
      onRendererIncident?.({
        source: "renderer-process",
        summary: "Renderer window is not responding",
        message: `The renderer stayed unresponsive for at least ${UNRESPONSIVE_REPORT_DELAY_MS / 1000} seconds.`,
      });
    }, UNRESPONSIVE_REPORT_DELAY_MS);
  });

  window.on("responsive", () => {
    if (unresponsiveTimer) {
      clearTimeout(unresponsiveTimer);
      unresponsiveTimer = null;
    }
    writeLog("info", "Renderer window became responsive");
  });

  window.on("closed", () => {
    if (unresponsiveTimer) {
      clearTimeout(unresponsiveTimer);
      unresponsiveTimer = null;
    }
  });

  window.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame === false || errorCode === -3) {
        return;
      }
      onRendererLoadFailure?.({
        errorCode,
        errorDescription,
        validatedURL,
      });
    },
  );
}

function resolveWindowIconPath(): string | null {
  if (process.platform === "darwin") {
    return null;
  }
  const candidates = [
    join(process.cwd(), "build", "icon.ico"),
    join(__dirname, "../../build/icon.ico"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function resolveAllowedDevRendererUrl(
  value: string | undefined,
): string | null {
  if (app.isPackaged || !value) {
    return null;
  }
  try {
    const url = new URL(value);
    const allowedHost =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1";
    return url.protocol === "http:" && allowedHost ? url.toString() : null;
  } catch (_error) {
    return null;
  }
}

export function isAllowedMainWindowNavigation(
  targetUrl: string,
  allowedRendererUrl: string,
): boolean {
  try {
    const target = new URL(targetUrl);
    const allowed = new URL(allowedRendererUrl);
    if (allowed.protocol === "http:") {
      return target.protocol === "http:" && target.origin === allowed.origin;
    }
    if (allowed.protocol !== "file:" || target.protocol !== "file:") {
      return false;
    }
    const rendererRoot = resolve(dirname(fileURLToPath(allowed)));
    const targetPath = resolve(fileURLToPath(target));
    return isPathInside(rendererRoot, targetPath);
  } catch (_error) {
    return false;
  }
}

function isPathInside(rootPath: string, targetPath: string): boolean {
  const child = relative(rootPath, targetPath);
  return (
    child === "" || (!!child && !child.startsWith("..") && !isAbsolute(child))
  );
}
