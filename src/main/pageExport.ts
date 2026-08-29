/* eslint-disable max-lines -- the hidden production renderer lifecycle and capture protocol are intentionally colocated */
import { BrowserWindow } from "electron";
import { constants as osPriority, setPriority } from "node:os";
import { rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { MangaPage } from "../shared/libraryTypes";
import {
  ORIGINAL_PAGE_EXPORT_RASTER_LIMITS,
  PAGE_EXPORT_SOURCE_RASTER_LIMITS,
  SAFE_PAGE_EXPORT_RASTER_LIMITS,
  fitPageExportRasterSize,
  pageExportRasterSizesEqual,
  type PageExportRasterLimits,
  type PageExportRasterSize,
} from "../shared/pageExportLimits";
import { createLibraryImageUrl } from "./imageProtocol";
import { tMain } from "./i18n";
import {
  captureExportPageImage,
  type PageExportCaptureOptions,
} from "./pageExportCapture";
import type { PageExportTileStitcher } from "./pageExportTileStitch";
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
  probePageExportSourceImage,
} from "./pageExportRasterSafety";
import {
  createPageExportTempOwner,
  type PageExportTempOwner,
} from "./pageExportTemp";
import type { ImageDecodeFallback } from "./regionCrop";

const MAX_EXPORT_VIEWPORT_SIDE_PX = 4096;
const PAGE_LOAD_TIMEOUT_MS = 15_000;
const ORIGINAL_PAGE_LOAD_TIMEOUT_MS = 60_000;
const RENDER_READY_TIMEOUT_MS = 20_000;
const ORIGINAL_RENDER_READY_TIMEOUT_MS = 120_000;
const DEBUGGER_SETUP_TIMEOUT_MS = 10_000;
const IMAGE_SOURCE_TIMEOUT_MS = 60_000;
const STRICT_SAFE_PNG_CAPTURE_OPTIONS = {
  format: "png",
  resolutionMode: "strict-safe",
} as const satisfies PageExportCaptureOptions;

export type PageExportRenderSession = {
  renderPage: (
    page: MangaPage,
    captureOptions?: PageExportCaptureOptions,
  ) => Promise<Buffer>;
  renderTransparentPage?: (page: MangaPage) => Promise<Buffer>;
  cancel?: () => void;
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
  stitchTiles?: PageExportTileStitcher;
  lowPriority?: boolean;
};

type ResolvedPageExportImage = {
  src: string;
  size: PageExportRasterSize;
};

export async function createPageExportRenderSession(
  options: PageExportRenderOptions,
): Promise<PageExportRenderSession> {
  const tempOwner = await createPageExportTempOwner(() =>
    createExportWindow(options.lowPriority === true),
  );
  return new ManagedPageExportRenderSession(options, tempOwner);
}

type ExportWindowState = ReturnType<typeof createExportWindow>;

class ManagedPageExportRenderSession implements PageExportRenderSession {
  private active = false;
  private closed = false;
  private lastRenderFailure: { error: unknown } | null = null;

  constructor(
    private readonly options: PageExportRenderOptions,
    private readonly tempOwner: PageExportTempOwner<ExportWindowState>,
  ) {}

  renderPage(
    page: MangaPage,
    captureOptions: PageExportCaptureOptions = STRICT_SAFE_PNG_CAPTURE_OPTIONS,
  ): Promise<Buffer> {
    return this.render(page, false, captureOptions);
  }

  renderTransparentPage(page: MangaPage): Promise<Buffer> {
    return this.render(page, true, STRICT_SAFE_PNG_CAPTURE_OPTIONS);
  }

  cancel(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.tempOwner.owner.win.destroy();
    } finally {
      this.tempOwner.release();
    }
  }

  close(): void {
    if (this.closed) return;
    if (this.active) {
      throw new Error("Page export session cannot close while rendering.");
    }
    this.closed = true;
    closeExportResources(this.tempOwner, this.lastRenderFailure);
  }

  private async render(
    page: MangaPage,
    transparentBackground: boolean,
    captureOptions: PageExportCaptureOptions,
  ): Promise<Buffer> {
    if (this.closed) throw new Error("Page export session is closed.");
    if (this.active)
      throw new Error("Page export session is already rendering.");
    this.active = true;
    this.lastRenderFailure = null;
    try {
      return await renderPageInSession(
        page,
        this.options,
        this.tempOwner.directory,
        this.tempOwner.owner,
        transparentBackground,
        captureOptions,
      );
    } catch (error) {
      this.lastRenderFailure = { error };
      throw error;
    } finally {
      this.active = false;
    }
  }
}

function closeExportResources(
  tempOwner: PageExportTempOwner<ExportWindowState>,
  lastRenderFailure: { error: unknown } | null,
): void {
  const cleanupErrors: unknown[] = [];
  try {
    if (tempOwner.owner.win.webContents.debugger.isAttached()) {
      tempOwner.owner.win.webContents.debugger.detach();
    }
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    tempOwner.owner.win.destroy();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    tempOwner.release();
  } catch (error) {
    cleanupErrors.push(error);
  }
  throwPageExportCleanupError(lastRenderFailure, cleanupErrors);
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

function createExportWindow(lowPriority = false): {
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
    transparent: true,
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
  if (lowPriority) {
    win.webContents.once("did-start-loading", () => {
      try {
        const processId = win.webContents.getOSProcessId();
        if (processId > 0) {
          setPriority(processId, osPriority.priority.PRIORITY_BELOW_NORMAL);
        }
      } catch (error) {
        void error;
        // Priority is a best-effort optimization; isolation still holds because
        // page rendering runs in this dedicated Chromium renderer process.
      }
    });
  }
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
  transparentBackground = false,
  captureOptions: PageExportCaptureOptions = STRICT_SAFE_PNG_CAPTURE_OPTIONS,
): Promise<Buffer> {
  const resolutionMode = captureOptions.resolutionMode ?? "strict-safe";
  const sourceLimits = resolvePageExportSourceLimits(resolutionMode);
  const image = await withAbortableTimeout(
    (signal) => resolveExportImageSource(page, options, signal, sourceLimits),
    IMAGE_SOURCE_TIMEOUT_MS,
    "PNG export image preflight timeout",
  );
  const plannedOutputSize = resolvePageExportOutputSize(
    image.size,
    page.name,
    resolutionMode,
  );
  const outputLimits = resolvePageExportOutputLimits(resolutionMode);
  const html = buildRenderSessionHtml({
    image,
    options,
    outputSize: plannedOutputSize,
    page,
    resolutionMode,
    transparentBackground,
  });
  // A session serializes renders, so its private directory needs only one
  // fixed, maximally short file name.
  const htmlPath = join(renderDir, "page.html");
  const htmlUrl = pathToFileURL(htmlPath).toString();
  const viewport = resolveExportViewportSize(
    plannedOutputSize.width,
    plannedOutputSize.height,
  );
  windowState.win.setContentSize(viewport.width, viewport.height);
  windowState.setAllowedHtmlUrl(htmlUrl);
  try {
    await writeFile(htmlPath, html, "utf8");
    await withTimeout(
      windowState.win.loadFile(htmlPath),
      resolutionMode === "original"
        ? ORIGINAL_PAGE_LOAD_TIMEOUT_MS
        : PAGE_LOAD_TIMEOUT_MS,
      "PNG export page load timeout",
    );
    const renderedOutputSize = await withTimeout(
      waitForExportRenderReady(windowState.win),
      resolutionMode === "original"
        ? ORIGINAL_RENDER_READY_TIMEOUT_MS
        : RENDER_READY_TIMEOUT_MS,
      "PNG export renderer readiness timeout",
    );
    assertPageExportRasterBudget(renderedOutputSize, page.name, outputLimits);
    if (!pageExportRasterSizesEqual(renderedOutputSize, plannedOutputSize)) {
      throw new Error(
        tMain("export.errors.imageDimensionsChanged", {
          name: page.name,
        }),
      );
    }
    await ensureExportDebugger(windowState.win);
    return await captureExportPageImage(
      windowState.win,
      plannedOutputSize,
      page.name,
      captureOptions,
      transparentBackground,
      {
        temporaryDirectory: renderDir,
        stitchTiles: options.stitchTiles,
      },
    );
  } finally {
    windowState.setAllowedHtmlUrl(null);
    await rm(htmlPath, { force: true });
  }
}

function buildRenderSessionHtml({
  image,
  options,
  outputSize,
  page,
  resolutionMode,
  transparentBackground,
}: {
  image: ResolvedPageExportImage;
  options: PageExportRenderOptions;
  outputSize: PageExportRasterSize;
  page: MangaPage;
  resolutionMode: NonNullable<PageExportCaptureOptions["resolutionMode"]>;
  transparentBackground: boolean;
}): string {
  const htmlOptions = {
    resolutionMode:
      resolutionMode === "original"
        ? ("original" as const)
        : ("safe-downscale" as const),
    sourceSize: image.size,
    transparentBackground,
  };
  return options.htmlSource
    ? options.htmlSource.buildHtml(page, image.src, outputSize, htmlOptions)
    : buildPageExportHtml(page, image.src, outputSize, htmlOptions);
}

async function resolveExportImageSource(
  page: MangaPage,
  options: PageExportRenderOptions,
  signal: AbortSignal,
  sourceLimits: PageExportRasterLimits,
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
      size = await resolvePageExportSourceSize(
        imagePath,
        options,
        signal,
        sourceLimits,
      );
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
            sourceLimits,
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
  sourceLimits: PageExportRasterLimits,
): Promise<PageExportRasterSize> {
  const probe =
    options.probeImageSize ??
    ((path: string, probeSignal: AbortSignal) =>
      probePageExportSourceImage(path, probeSignal, sourceLimits));
  const size = await probe(imagePath, signal);
  throwIfAborted(signal);
  assertPageExportRasterBudget(size, basename(imagePath), sourceLimits);
  return size;
}

function resolvePageExportSourceLimits(
  mode: NonNullable<PageExportCaptureOptions["resolutionMode"]>,
): PageExportRasterLimits {
  if (mode === "strict-safe") return SAFE_PAGE_EXPORT_RASTER_LIMITS;
  return mode === "original"
    ? ORIGINAL_PAGE_EXPORT_RASTER_LIMITS
    : PAGE_EXPORT_SOURCE_RASTER_LIMITS;
}

function resolvePageExportOutputLimits(
  mode: NonNullable<PageExportCaptureOptions["resolutionMode"]>,
): PageExportRasterLimits {
  return mode === "original"
    ? ORIGINAL_PAGE_EXPORT_RASTER_LIMITS
    : SAFE_PAGE_EXPORT_RASTER_LIMITS;
}

function resolvePageExportOutputSize(
  sourceSize: PageExportRasterSize,
  label: string,
  mode: NonNullable<PageExportCaptureOptions["resolutionMode"]>,
): PageExportRasterSize {
  assertPageExportRasterBudget(
    sourceSize,
    label,
    resolvePageExportSourceLimits(mode),
  );
  return mode === "safe-downscale"
    ? fitPageExportRasterSize(sourceSize)
    : { ...sourceSize };
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
