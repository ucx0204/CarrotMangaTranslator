import { BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { MangaPage } from "../shared/libraryTypes";
import {
  pageExportRasterSizesEqual,
  type PageExportRasterSize,
} from "../shared/pageExportLimits";
import { createLibraryImageUrl } from "./imageProtocol";
import { tMain } from "./i18n";
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
import {
  assertPageExportRasterBudget,
  buildBoundedPageExportDataUrl,
  decodeBoundedPageExportScreenshot,
  probePageExportSourceImage,
} from "./pageExportRasterSafety";
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

export type PageExportImageProbe = (
  imagePath: string,
  signal: AbortSignal,
) => Promise<PageExportRasterSize>;

type PageExportRenderOptions = {
  dataRoot: string;
  decodeFallback: ImageDecodeFallback;
  htmlSource?: PageExportHtmlSource;
  resolveImageUrl?: (path: string) => string;
  probeImageSize?: PageExportImageProbe;
};

type ResolvedPageExportImage = {
  src: string;
  size: PageExportRasterSize;
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
  const image = await withAbortableTimeout(
    (signal) => resolveExportImageSource(page, options, signal),
    IMAGE_SOURCE_TIMEOUT_MS,
    "PNG export image preflight timeout",
  );
  assertPageExportRasterBudget(image.size, page.name);
  const html = options.htmlSource
    ? options.htmlSource.buildHtml(page, image.src, image.size)
    : buildPageExportHtml(page, image.src, image.size);
  const htmlPath = join(renderDir, `${page.id}-${randomUUID()}.html`);
  const htmlUrl = pathToFileURL(htmlPath).toString();
  const viewport = resolveExportViewportSize(
    image.size.width,
    image.size.height,
  );
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
    assertPageExportRasterBudget(outputSize, page.name);
    if (!pageExportRasterSizesEqual(outputSize, image.size)) {
      throw new Error(
        tMain("export.errors.imageDimensionsChanged", {
          name: page.name,
        }),
      );
    }
    await ensureExportDebugger(windowState.win);
    return await captureExportPagePng(windowState.win, image.size, page.name);
  } finally {
    windowState.setAllowedHtmlUrl(null);
    await rm(htmlPath, { force: true });
  }
}

async function resolveExportImageSource(
  page: MangaPage,
  options: PageExportRenderOptions,
  signal: AbortSignal,
): Promise<ResolvedPageExportImage> {
  const paths = [page.inpaintedImagePath, page.imagePath].filter(
    (path, index, candidates): path is string =>
      Boolean(path) && candidates.indexOf(path) === index,
  );
  const failures: unknown[] = [];
  for (const imagePath of paths) {
    throwIfAborted(signal);
    let size: PageExportRasterSize;
    try {
      size = await resolvePageExportSourceSize(imagePath, options, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      failures.push(error);
      if (imagePath === paths.at(-1)) throw error;
      continue;
    }
    try {
      const src = (options.resolveImageUrl ?? createLibraryImageUrl)(imagePath);
      return { src, size };
    } catch (error) {
      failures.push(error);
    }
    try {
      const fallback = await options.decodeFallback(imagePath, signal);
      throwIfAborted(signal);
      if (fallback) {
        return {
          src: buildBoundedPageExportDataUrl(
            fallback,
            size,
            basename(imagePath),
          ),
          size,
        };
      }
    } catch (error) {
      if (signal.aborted) throw error;
      failures.push(error);
    }
  }
  throw new AggregateError(
    failures,
    `출력할 이미지를 읽지 못했습니다: ${basename(paths.at(-1) ?? "")}`,
  );
}

async function resolvePageExportSourceSize(
  imagePath: string,
  options: PageExportRenderOptions,
  signal: AbortSignal,
): Promise<PageExportRasterSize> {
  const probe =
    options.probeImageSize ??
    ((path: string, probeSignal: AbortSignal) =>
      probePageExportSourceImage(path, probeSignal));
  const size = await probe(imagePath, signal);
  throwIfAborted(signal);
  assertPageExportRasterBudget(size, basename(imagePath));
  return size;
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
  expected: PageExportRasterSize,
  pageName: string,
): Promise<Buffer> {
  assertPageExportRasterBudget(expected, pageName);
  const result = (await withTimeout(
    win.webContents.debugger.sendCommand("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip: {
        x: 0,
        y: 0,
        width: expected.width,
        height: expected.height,
        scale: 1,
      },
    }),
    SCREENSHOT_CAPTURE_TIMEOUT_MS,
    "PNG export screenshot capture timeout",
  )) as DevToolsScreenshotResult;
  if (typeof result.data !== "string") {
    throw new Error("DevTools returned an invalid page export screenshot.");
  }
  return decodeBoundedPageExportScreenshot(result.data, expected, pageName);
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
  if (!isPageExportRasterSizeShape(value)) {
    throw new Error("PNG export renderer returned an invalid output size.");
  }
  return value;
}

function isPageExportRasterSizeShape(
  value: unknown,
): value is PageExportRasterSize {
  return (
    typeof value === "object" &&
    value !== null &&
    "width" in value &&
    typeof value.width === "number" &&
    "height" in value &&
    typeof value.height === "number"
  );
}
