import { app, BrowserWindow } from "electron";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { logError, writeLog } from "./logger";
import { tMainCommon } from "./i18n";

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

export function createMainWindow(): BrowserWindow {
  const target = resolveRendererLoadTarget();
  const window = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1240,
    minHeight: 760,
    title: tMainCommon("app.title"),
    ...(target.windowIconPath ? { icon: target.windowIconPath } : {}),
    backgroundColor: "#101114",
    autoHideMenuBar: true,
    webPreferences: rendererWebPreferences(),
  });

  applyRendererWindowGuards(window, target.allowedRendererUrl);
  window.setMenuBarVisibility(false);
  loadRendererIntoWindow(window, target);
  return window;
}

function resolveWindowIconPath(): string | null {
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
