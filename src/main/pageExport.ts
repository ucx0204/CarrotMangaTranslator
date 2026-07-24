import { BrowserWindow, nativeImage } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { MangaPage } from "../shared/libraryTypes";
import { createLibraryImageUrl } from "./imageProtocol";
import {
  buildPageExportHtml,
  type PageExportHtmlSource,
} from "./pageExportHtml";
import {
  throwIfAborted,
  throwPageExportCleanupError,
  withAbortableTimeout,
  withTimeout,
} from "./pageExportLifecycle";
import type { ImageDecodeFallback } from "./regionCrop";

const MAX_EXPORT_VIEWPORT_SIDE_PX = 4096;
const PAGE_LOAD_TIMEOUT_MS = 15_000;
const RENDER_READY_TIMEOUT_MS = 20_000;
const DEBUGGER_SETUP_TIMEOUT_MS = 10_000;
const SCREENSHOT_CAPTURE_TIMEOUT_MS = 30_000;
const IMAGE_SOURCE_TIMEOUT_MS = 60_000;

type DevToolsScreenshotResult = {
  data?: unknown;
};

export type PageExportRenderSession = {
  renderPage: (page: MangaPage) => Promise<Buffer>;
  close: () => void;
};

type PageExportRenderOptions = {
  dataRoot: string;
  decodeFallback: ImageDecodeFallback;
  htmlSource?: PageExportHtmlSource;
  resolveImageUrl?: (path: string) => string;
};

export async function createPageExportRenderSession(
  options: PageExportRenderOptions,
): Promise<PageExportRenderSession> {
  const renderDir = join(options.dataRoot, "tmp", "png-export-render");
  await mkdir(renderDir, { recursive: true });
  const windowState = createExportWindow();
  let active = false;
  let closed = false;
  let lastRenderFailure: { error: unknown } | null = null;

  return {
    async renderPage(page) {
      if (closed) throw new Error("Page export session is closed.");
      if (active) throw new Error("Page export session is already rendering.");
      active = true;
      lastRenderFailure = null;
      try {
        return await renderPageInSession(page, options, renderDir, windowState);
      } catch (error) {
        lastRenderFailure = { error };
        throw error;
      } finally {
        active = false;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      const cleanupErrors: unknown[] = [];
      try {
        if (windowState.win.webContents.debugger.isAttached()) {
          windowState.win.webContents.debugger.detach();
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        windowState.win.destroy();
      } catch (error) {
        cleanupErrors.push(error);
      }
      throwPageExportCleanupError(lastRenderFailure, cleanupErrors);
    },
  };
}

export async function renderPageWithTranslationBlocksForExport(
  page: MangaPage,
  options: PageExportRenderOptions,
): Promise<Buffer> {
  const session = await createPageExportRenderSession(options);
  try {
    return await session.renderPage(page);
  } finally {
    session.close();
  }
}

function createExportWindow(): {
  win: BrowserWindow;
  setAllowedHtmlUrl: (url: string | null) => void;
} {
  let allowedHtmlUrl: string | null = null;
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    useContentSize: true,
    backgroundColor: "#ffffff",
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== allowedHtmlUrl) event.preventDefault();
  });
  return {
    win,
    setAllowedHtmlUrl: (url) => {
      allowedHtmlUrl = url;
    },
  };
}

async function ensureExportDebugger(win: BrowserWindow): Promise<void> {
  const debuggerApi = win.webContents.debugger;
  if (!debuggerApi.isAttached()) debuggerApi.attach("1.3");
  await withTimeout(
    debuggerApi.sendCommand("Page.enable"),
    DEBUGGER_SETUP_TIMEOUT_MS,
    "PNG export debugger setup timeout",
  );
}

async function renderPageInSession(
  page: MangaPage,
  options: PageExportRenderOptions,
  renderDir: string,
  windowState: ReturnType<typeof createExportWindow>,
): Promise<Buffer> {
  const imageSrc = await withAbortableTimeout(
    (signal) => resolveExportImageSource(page, options, signal),
    IMAGE_SOURCE_TIMEOUT_MS,
    "PNG export image decode timeout",
  );
  const html = options.htmlSource
    ? options.htmlSource.buildHtml(page, imageSrc)
    : buildPageExportHtml(page, imageSrc);
  const htmlPath = join(renderDir, `${page.id}-${randomUUID()}.html`);
  const htmlUrl = pathToFileURL(htmlPath).toString();
  const viewport = resolveExportViewportSize(page.width, page.height);
  windowState.win.setContentSize(viewport.width, viewport.height);
  windowState.setAllowedHtmlUrl(htmlUrl);
  try {
    await writeFile(htmlPath, html, "utf8");
    await withTimeout(
      windowState.win.loadFile(htmlPath),
      PAGE_LOAD_TIMEOUT_MS,
      "PNG export page load timeout",
    );
    const outputSize = await withTimeout(
      waitForExportRenderReady(windowState.win),
      RENDER_READY_TIMEOUT_MS,
      "PNG export renderer readiness timeout",
    );
    await ensureExportDebugger(windowState.win);
    const png = await captureExportPagePng(
      windowState.win,
      outputSize.width,
      outputSize.height,
    );
    assertPngDimensions(png, outputSize, page.name);
    return png;
  } finally {
    windowState.setAllowedHtmlUrl(null);
    await rm(htmlPath, { force: true });
  }
}

async function resolveExportImageSource(
  page: MangaPage,
  options: PageExportRenderOptions,
  signal: AbortSignal,
): Promise<string> {
  const paths = [page.inpaintedImagePath, page.imagePath].filter(
    (path, index, candidates): path is string =>
      Boolean(path) && candidates.indexOf(path) === index,
  );
  const failures: unknown[] = [];
  for (const imagePath of paths) {
    throwIfAborted(signal);
    try {
      return (options.resolveImageUrl ?? createLibraryImageUrl)(imagePath);
    } catch (error) {
      failures.push(error);
    }
    try {
      const fallbackUrl = await decodeExportImageFallback(
        imagePath,
        options.decodeFallback,
        signal,
      );
      if (fallbackUrl) return fallbackUrl;
    } catch (error) {
      if (signal.aborted) throw error;
      failures.push(error);
    }
  }
  throw new AggregateError(
    failures,
    `출력할 이미지를 읽지 못했습니다: ${paths.at(-1) ?? ""}`,
  );
}

async function decodeExportImageFallback(
  imagePath: string,
  decodeFallback: ImageDecodeFallback,
  signal: AbortSignal,
): Promise<string | null> {
  const fallback = await decodeFallback(imagePath, signal);
  if (!fallback) return null;
  const image = nativeImage.createFromBuffer(fallback);
  return image.isEmpty()
    ? null
    : `data:image/png;base64,${image.toPNG().toString("base64")}`;
}

function resolveExportViewportSize(
  width: number,
  height: number,
): { width: number; height: number } {
  return {
    width: Math.min(width, MAX_EXPORT_VIEWPORT_SIDE_PX),
    height: Math.min(height, MAX_EXPORT_VIEWPORT_SIDE_PX),
  };
}

async function captureExportPagePng(
  win: BrowserWindow,
  width: number,
  height: number,
): Promise<Buffer> {
  const result = (await withTimeout(
    win.webContents.debugger.sendCommand("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    }),
    SCREENSHOT_CAPTURE_TIMEOUT_MS,
    "PNG export screenshot capture timeout",
  )) as DevToolsScreenshotResult;
  if (typeof result.data !== "string" || result.data.length === 0) {
    throw new Error("DevTools returned an empty page export screenshot.");
  }
  return Buffer.from(result.data, "base64");
}

async function waitForExportRenderReady(
  win: BrowserWindow,
): Promise<{ width: number; height: number }> {
  const value: unknown = await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const tick = () => {
        const body = document.body;
        const renderError = body && body.dataset.error;
        if (renderError) {
          reject(new Error("PNG export render failed: " + renderError));
          return;
        }
        if (body && body.dataset.ready === "1") {
          resolve({
            width: Number(body.dataset.outputWidth),
            height: Number(body.dataset.outputHeight),
          });
          return;
        }
        if (Date.now() - startedAt > 15000) {
          reject(new Error("PNG export render timeout"));
          return;
        }
        setTimeout(tick, 40);
      };
      tick();
    })
  `);
  if (!isValidOutputSize(value)) {
    throw new Error("PNG export renderer returned an invalid output size.");
  }
  return value;
}

function isValidOutputSize(
  value: unknown,
): value is { width: number; height: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "width" in value &&
    typeof value.width === "number" &&
    Number.isInteger(value.width) &&
    value.width > 0 &&
    value.width <= 100000 &&
    "height" in value &&
    typeof value.height === "number" &&
    Number.isInteger(value.height) &&
    value.height > 0 &&
    value.height <= 100000
  );
}

function assertPngDimensions(
  png: Buffer,
  expected: { width: number; height: number },
  pageName: string,
): void {
  const actual = readPngDimensions(png);
  if (actual.width !== expected.width || actual.height !== expected.height) {
    throw new Error(
      `출력 PNG 크기가 일치하지 않습니다: ${pageName} (${actual.width}x${actual.height}, expected ${expected.width}x${expected.height})`,
    );
  }
}

function readPngDimensions(png: Buffer): {
  width: number;
  height: number;
} {
  if (
    png.length < 24 ||
    png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    png.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    throw new Error("Page export capture is not a valid PNG.");
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

export function sanitizeOutputBaseName(value: string): string {
  const raw = basename(value, extname(value)) || "page";
  return sanitizeOutputPathSegment(raw, "page");
}

export function sanitizeOutputPathSegment(
  value: string,
  fallback: string,
): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 80);
  const resolved =
    cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : fallback;
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(resolved)
    ? `_${resolved}`
    : resolved;
}
