import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { bboxToPixels, clamp, resolveEffectiveRenderBbox } from "../shared/geometry";
import { ensureWritableAppDirectories } from "./appPaths";
import { buildBaseTranslationOptions } from "./appSettings";
import {
  cleanupLegacyLogs,
  deleteChapter,
  deleteWork,
  createImport,
  deletePage,
  exportWorkShareToFile,
  finalizeRunningPages,
  getLibraryRoot,
  getRunPaths,
  importWorkShare,
  listLibrary,
  markChapterPagesRunning,
  openChapter,
  previewFolder,
  previewImages,
  previewWorkShareImport,
  previewZip,
  previewZipFolder,
  readLibraryPageImageDataUrl,
  renameChapter,
  renameWork,
  reorderChapters,
  reorderPages,
  resolvePagesForRun,
  saveChapterSnapshot,
  updatePageAfterAnalysis,
  updatePagesAfterInpainting
} from "./library";
import {
  applyInpaintingRetouch,
  inpaintDrawnPatternPage,
  inpaintPatternPage,
  prepareFluxInpaintingEngine,
  sampleImageColor,
  type FluxInpaintingEngine
} from "./inpainting";
import { getLogPath, logError, logInfo, resetAppLog, writeLog } from "./logger";
import { startOpenAIOAuthEndpoint, stopOpenAIOAuthEndpoint, type OpenAIOAuthEndpoint } from "./openaiOauthEndpoint";
import { getAppSettings, resetAppSettings, saveAppSettings } from "./settingsStore";
import { runWholePagePipeline } from "./wholePagePipeline";
import type {
  AppSettings,
  CreateImportRequest,
  InpaintingColorSampleRequest,
  InpaintingColorSampleResult,
  InpaintingRetouchRequest,
  InpaintingRetouchResult,
  InpaintingRevertRequest,
  InpaintingRevertResult,
  ImportPreviewResult,
  InpaintingExportRequest,
  InpaintingExportResult,
  JobEvent,
  LocalModelPickResult,
  MangaPage,
  ModelTestProgressEvent,
  ModelTestResult,
  RegionAnalysisRequest,
  RegionAnalysisResult,
  StartInpaintingRequest,
  StartInpaintingResult,
  StartAnalysisRequest,
  StartAnalysisResult,
  TranslationBlock,
  WorkShareExportRequest,
  WorkShareExportResult,
  WorkShareImportRequest,
  WorkShareImportResult,
  WorkShareImportPreview
} from "../shared/types";
import { isUsableRegionBbox, mapCropNormalizedBboxToPageBbox, normalizedRegionToPixelRect, type PixelRect } from "../shared/region";

const appPaths = ensureWritableAppDirectories();
resetAppLog();

logInfo("Application process starting", {
  cwd: process.cwd(),
  isPackaged: app.isPackaged,
  processExecPath: process.execPath,
  logPath: getLogPath(),
  libraryPath: getLibraryRoot(),
  settingsPath: appPaths.settingsPath,
  dataRoot: appPaths.dataRoot,
  runtimeDir: appPaths.runtimeDir,
  llamaServerPath: appPaths.llamaServerPath,
  hfHomeDir: appPaths.hfHomeDir ?? null,
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null
});

process.on("uncaughtException", (error) => {
  logError("Uncaught exception", error);
});

process.on("unhandledRejection", (reason) => {
  logError("Unhandled rejection", reason);
});

let mainWindow: BrowserWindow | null = null;
type ActiveJob = {
  id: string;
  kind: JobEvent["kind"];
  abortController: AbortController;
  cleanup?: () => Promise<void>;
  lastEvent?: JobEvent;
};

let activeJob: ActiveJob | null = null;

type SimplePageRuntime = {
  startServer: (options: Record<string, unknown>) => Promise<{ baseUrl: string; child: unknown; startedByScript: boolean }>;
  stopServer: (server: { child: unknown } | null | undefined) => Promise<void>;
  isModelCached: (options: Record<string, unknown>) => boolean;
  convertImageToPngBufferWithFfmpeg?: (filePath: string) => Promise<Buffer>;
  testModelReply: (server: { baseUrl: string }, options: Record<string, unknown>) => Promise<{
    outputText: string;
    launchTarget: { launchMode: "huggingface" | "cached-hf" | "local" | "openai-codex"; modelPath?: string | null; mmprojPath?: string | null };
  }>;
};

let cachedSimplePageRuntime: SimplePageRuntime | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
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

  mainWindow.webContents.on("console-message", (details) => {
    const level =
      details.level === "warning" ? "warn" : details.level === "error" ? "error" : details.level === "debug" ? "debug" : "info";
    writeLog(level, "renderer console", {
      message: details.message,
      line: details.lineNumber,
      sourceId: details.sourceId
    });
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    logError("Renderer failed to load", { errorCode, errorDescription, validatedURL });
  });

  mainWindow.setMenuBarVisibility(false);

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  await cleanupLegacyLogs();
  Menu.setApplicationMenu(null);
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (activeJob) {
    activeJob.abortController.abort();
    void runJobCleanup(activeJob, "before-quit");
  }
});

async function runJobCleanup(job: ActiveJob, reason: string): Promise<void> {
  const cleanup = job.cleanup;
  if (!cleanup) {
    return;
  }
  job.cleanup = undefined;
  try {
    await cleanup();
    logInfo("Analysis runtime cleanup completed", { jobId: job.id, reason });
  } catch (error) {
    logError("Analysis runtime cleanup failed", { jobId: job.id, reason, error });
  }
}

async function createRegionCropPage(page: MangaPage, bbox: RegionAnalysisRequest["bbox"], jobId: string, runDir: string): Promise<{
  cropPage: MangaPage;
  cropRect: PixelRect;
}> {
  if (!isUsableRegionBbox(bbox)) {
    throw new Error("번역할 영역이 너무 작습니다.");
  }

  const source = await loadImageForRegionCrop(page.imagePath);

  const cropRect = normalizedRegionToPixelRect(bbox, { width: page.width, height: page.height }, 8);
  const crop = source.crop({
    x: cropRect.x,
    y: cropRect.y,
    width: cropRect.w,
    height: cropRect.h
  });
  if (crop.isEmpty()) {
    throw new Error("선택 영역 이미지를 만들지 못했습니다.");
  }

  const cropDir = join(runDir, "region-crops");
  await mkdir(cropDir, { recursive: true });
  const cropPath = join(cropDir, `${page.id}-${jobId}.png`);
  await writeFile(cropPath, crop.toPNG());

  return {
    cropRect,
    cropPage: {
      ...page,
      id: `${page.id}-region-${jobId}`,
      name: `${page.name} 선택 영역`,
      imagePath: cropPath,
      dataUrl: "",
      width: cropRect.w,
      height: cropRect.h,
      blocks: [],
      analysisStatus: "idle",
      lastError: undefined
    }
  };
}

async function loadImageForRegionCrop(imagePath: string): Promise<Electron.NativeImage> {
  if (extname(imagePath).toLowerCase() === ".webp") {
    const runtime = loadSimplePageRuntime();
    if (runtime.convertImageToPngBufferWithFfmpeg) {
      const pngBuffer = await runtime.convertImageToPngBufferWithFfmpeg(imagePath);
      const converted = nativeImage.createFromBuffer(pngBuffer);
      if (!converted.isEmpty()) {
        logInfo("Region crop decoded webp through png conversion", { imagePath });
        return converted;
      }
    }
    throw new Error("WEBP 이미지를 PNG로 변환하지 못했습니다.");
  }

  const direct = nativeImage.createFromPath(imagePath);
  if (!direct.isEmpty()) {
    return direct;
  }

  throw new Error("선택한 페이지 이미지를 읽지 못했습니다.");
}

async function loadImageForPngExport(imagePath: string): Promise<Electron.NativeImage> {
  const direct = nativeImage.createFromPath(imagePath);
  if (!direct.isEmpty()) {
    return direct;
  }

  const pngBuffer = await decodeImageThroughRuntime(imagePath);
  if (pngBuffer) {
    const converted = nativeImage.createFromBuffer(pngBuffer);
    if (!converted.isEmpty()) {
      return converted;
    }
  }

  throw new Error(`출력할 이미지를 읽지 못했습니다: ${imagePath}`);
}

function sanitizeOutputBaseName(value: string): string {
  const raw = basename(value, extname(value)) || "page";
  const cleaned = raw.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return (cleaned || "page").slice(0, 80);
}

async function renderPageWithTranslationBlocksForExport(page: MangaPage): Promise<Buffer> {
  const sourcePath = page.inpaintedImagePath || page.imagePath;
  const image = await loadImageForPngExport(sourcePath);
  const size = image.getSize();
  const width = Math.max(1, size.width || page.width);
  const height = Math.max(1, size.height || page.height);
  const imageDataUrl = `data:image/png;base64,${image.toPNG().toString("base64")}`;
  const html = buildPageExportHtml(page, imageDataUrl, width, height);
  const renderDir = join(appPaths.dataRoot, "tmp", "png-export-render");
  await mkdir(renderDir, { recursive: true });
  const htmlPath = join(renderDir, `${page.id}-${randomUUID()}.html`);
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    useContentSize: true,
    backgroundColor: "#ffffff",
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false
    }
  });

  try {
    await writeFile(htmlPath, html, "utf8");
    await win.loadFile(htmlPath);
    await waitForExportRenderReady(win);
    const rendered = await win.webContents.capturePage({ x: 0, y: 0, width, height });
    const png = rendered.toPNG();
    if (!png.length) {
      throw new Error(`출력 PNG를 만들지 못했습니다: ${page.name}`);
    }
    return png;
  } finally {
    win.destroy();
    await rm(htmlPath, { force: true }).catch(() => {});
  }
}

function buildPageExportHtml(page: MangaPage, imageDataUrl: string, width: number, height: number): string {
  const rendererCssHref = findRendererCssHref();
  const blocks = buildPageExportBlocks(page, width, height);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
${rendererCssHref ? `<link rel="stylesheet" href="${escapeHtml(rendererCssHref)}" />` : ""}
<style>
html, body {
  margin: 0;
  width: ${width}px;
  height: ${height}px;
  overflow: hidden;
  background: #fff;
}
body {
  font-family: "Malgun Gothic", "Apple SD Gothic Neo", "Segoe UI", sans-serif;
}
.page-export-stage {
  position: relative;
  width: ${width}px;
  height: ${height}px;
  overflow: hidden;
  background: #fff;
}
.page-export-image {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.page-export-block {
  position: absolute;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: visible;
  white-space: normal;
  font-weight: 600;
  transform-origin: center center;
}
.page-export-content {
  display: inline-block;
  box-sizing: border-box;
  overflow: visible;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  word-break: keep-all;
}
.page-export-content.vertical {
  writing-mode: vertical-rl;
  text-orientation: upright;
  white-space: normal;
  word-break: normal;
}
</style>
</head>
<body>
<div class="page-export-stage" id="stage">
  <img class="page-export-image" src="${imageDataUrl}" />
</div>
<script>
const EXPORT_BLOCKS = ${JSON.stringify(blocks)};
const MIN_FONT_SIZE = 10;
const MAX_AUTOFIT_FONT_SIZE = 256;
const canvas = document.createElement("canvas");
const context = canvas.getContext("2d");

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function escapeText(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}

function buildFont(size, family) {
  return "600 " + size + "px " + family;
}

function wrapTextToWidth(text, maxWidth, fontSize, fontFamily) {
  context.font = buildFont(fontSize, fontFamily);
  const paragraphs = String(text).replace(/\\r/g, "").split("\\n");
  const lines = [];
  for (const paragraph of paragraphs) {
    const normalized = paragraph.replace(/\\s+/g, " ").trim();
    if (!normalized) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const char of Array.from(normalized)) {
      const candidate = current + char;
      if (!current || context.measureText(candidate).width <= maxWidth) {
        current = candidate;
        continue;
      }
      lines.push(current.trimEnd());
      current = /\\s/u.test(char) ? "" : char;
    }
    if (current) {
      lines.push(current.trimEnd());
    }
  }
  return lines.length ? lines : [String(text)];
}

function measureHorizontal(block, fontSize, innerWidth) {
  const lines = wrapTextToWidth(block.text, innerWidth, fontSize, block.fontFamily);
  context.font = buildFont(fontSize, block.fontFamily);
  return {
    lines,
    totalHeight: lines.length * fontSize * block.lineHeight,
    maxLineWidth: lines.reduce((widest, line) => Math.max(widest, context.measureText(line).width), 0)
  };
}

function fits(block, fontSize, innerWidth, innerHeight) {
  if (block.renderDirection === "vertical") {
    const compact = block.text.replace(/\\r/g, "").replace(/\\s+/g, "");
    if (!compact) return true;
    const charsPerColumn = Math.max(1, Math.floor(innerHeight / Math.max(fontSize, fontSize * block.lineHeight)));
    const columnCount = Math.max(1, Math.ceil(Array.from(compact).length / charsPerColumn));
    return columnCount <= 2 && columnCount * fontSize * 1.15 <= innerWidth;
  }
  const measured = measureHorizontal(block, fontSize, innerWidth);
  return measured.totalHeight <= innerHeight && measured.maxLineWidth <= innerWidth;
}

function resolveFontSize(block, innerWidth, innerHeight) {
  const preferred = Math.max(MIN_FONT_SIZE, Math.floor(block.fontSizePx));
  if (!block.autoFitText || !block.text.trim()) {
    return preferred;
  }
  const heightBound = Math.floor(innerHeight / Math.max(1, block.lineHeight || 1));
  const widthBound = block.renderDirection === "vertical" ? Math.floor(innerWidth / 1.15) : MAX_AUTOFIT_FONT_SIZE;
  const capped = clamp(Math.max(MIN_FONT_SIZE, heightBound, widthBound), MIN_FONT_SIZE, MAX_AUTOFIT_FONT_SIZE);
  let low = MIN_FONT_SIZE;
  let high = Math.floor(capped);
  let best = MIN_FONT_SIZE;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (fits(block, mid, innerWidth, innerHeight)) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return Math.min(best, capped);
}

function resolveOutlineShadow(fontSize, color) {
  const radius = Math.round(Math.min(4, Math.max(0.35, fontSize * 0.055)) * 10) / 10;
  const half = Math.round(radius * 0.55 * 10) / 10;
  return [[0, -radius], [radius, 0], [0, radius], [-radius, 0], [radius, -radius], [radius, radius], [-radius, radius], [-radius, -radius], [half, -half], [half, half], [-half, half], [-half, -half]]
    .map(([x, y]) => x + "px " + y + "px 0 " + color)
    .join(", ");
}

function renderBlocks() {
  const stage = document.getElementById("stage");
  for (const block of EXPORT_BLOCKS) {
    const root = document.createElement("div");
    root.className = "page-export-block";
    root.style.left = block.rect.left + "px";
    root.style.top = block.rect.top + "px";
    root.style.width = block.rect.width + "px";
    root.style.height = block.rect.height + "px";
    root.style.color = block.textColor;
    root.style.fontFamily = block.fontFamily;
    root.style.lineHeight = String(block.lineHeight);
    root.style.textAlign = block.textAlign;
    if (block.rotationDeg) {
      root.style.transform = "rotate(" + block.rotationDeg + "deg)";
    }

    const innerWidth = Math.max(1, block.rect.width - 2);
    const innerHeight = Math.max(1, block.rect.height - 2);
    const fontSize = resolveFontSize(block, innerWidth, innerHeight);
    root.style.fontSize = fontSize + "px";

    const content = document.createElement("span");
    content.className = "page-export-content" + (block.renderDirection === "vertical" ? " vertical" : "");
    content.style.textShadow = resolveOutlineShadow(fontSize, block.outlineColor);
    if (block.renderDirection === "vertical") {
      content.textContent = block.text.replace(/\\r/g, "").replace(/\\s+/g, "");
      content.style.height = Math.min(innerHeight, Math.max(1, Array.from(content.textContent).length * fontSize * block.lineHeight)) + "px";
      content.style.maxHeight = "100%";
    } else {
      const lines = measureHorizontal(block, fontSize, innerWidth).lines;
      content.innerHTML = lines.map(escapeText).join("<br>");
      content.style.width = innerWidth + "px";
      content.style.maxWidth = "100%";
    }
    root.appendChild(content);
    stage.appendChild(root);
  }
}

async function preloadExportFonts() {
  if (!document.fonts) {
    return;
  }
  const loads = [];
  for (const block of EXPORT_BLOCKS) {
    const size = Math.max(MIN_FONT_SIZE, Math.floor(block.fontSizePx || 20));
    loads.push(document.fonts.load("600 " + size + "px " + block.fontFamily));
    loads.push(document.fonts.load("700 " + size + "px " + block.fontFamily));
    loads.push(document.fonts.load("400 " + size + "px " + block.fontFamily));
  }
  await Promise.all(loads.map((load) => load.catch(() => [])));
  await document.fonts.ready;
}

window.addEventListener("load", async () => {
  await preloadExportFonts();
  renderBlocks();
  if (document.fonts && document.fonts.ready) {
    await document.fonts.ready;
  }
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.body.dataset.ready = "1";
  }));
});
</script>
</body>
</html>`;
}

function buildPageExportBlocks(page: MangaPage, outputWidth: number, outputHeight: number): PageExportBlock[] {
  const pageWidth = Math.max(1, page.width || outputWidth);
  const pageHeight = Math.max(1, page.height || outputHeight);
  const scaleX = outputWidth / pageWidth;
  const scaleY = outputHeight / pageHeight;
  const fontScale = Math.min(scaleX, scaleY);
  return page.blocks
    .map((block) => buildPageExportBlock(block, { width: pageWidth, height: pageHeight }, scaleX, scaleY, fontScale))
    .filter((block): block is PageExportBlock => Boolean(block));
}

type PageExportBlock = {
  text: string;
  rect: { left: number; top: number; width: number; height: number };
  renderDirection: "horizontal" | "vertical" | "rotated";
  rotationDeg: number;
  fontFamily: string;
  fontSizePx: number;
  lineHeight: number;
  textAlign: "left" | "center" | "right";
  textColor: string;
  outlineColor: string;
  autoFitText: boolean;
};

function buildPageExportBlock(
  block: TranslationBlock,
  pageSize: { width: number; height: number },
  scaleX: number,
  scaleY: number,
  fontScale: number
): PageExportBlock | null {
  if (block.renderDirection === "hidden") {
    return null;
  }
  const text = block.translatedText || block.sourceText || "";
  if (!text.trim()) {
    return null;
  }
  const renderBbox = resolveEffectiveRenderBbox(block, pageSize, text);
  const rect = bboxToPixels(renderBbox, pageSize.width, pageSize.height);
  return {
    text,
    rect: {
      left: rect.x * scaleX,
      top: rect.y * scaleY,
      width: Math.max(1, rect.w * scaleX),
      height: Math.max(1, rect.h * scaleY)
    },
    renderDirection: block.renderDirection === "vertical" ? "vertical" : block.renderDirection === "rotated" ? "rotated" : "horizontal",
    rotationDeg: block.rotationDeg ? clamp(Math.round(block.rotationDeg), -30, 30) : 0,
    fontFamily: resolveExportBlockFontFamily(block.fontFamily),
    fontSizePx: Math.max(10, Math.round((block.fontSizePx || 20) * fontScale)),
    lineHeight: Math.max(1, block.lineHeight || 1.18),
    textAlign: block.textAlign || "center",
    textColor: normalizeExportColor(block.textColor, "#000000"),
    outlineColor: normalizeExportColor(block.outlineColor, "#ffffff"),
    autoFitText: block.autoFitText ?? true
  };
}

function resolveExportBlockFontFamily(value: string | undefined): string {
  switch (value) {
    case "mongtori":
      return '"MGT Mongtori", "Malgun Gothic", sans-serif';
    case "chosun-gungseo":
      return '"MGT Chosun Gungseo", "Malgun Gothic", serif';
    case "griun-pol-sensibility":
      return '"MGT Griun Pol Sensibility", "Malgun Gothic", sans-serif';
    case "nanum-gothic":
      return '"MGT Nanum Gothic", "Malgun Gothic", sans-serif';
    case "nanum-myeongjo":
      return '"MGT Nanum Myeongjo", "Malgun Gothic", serif';
    case "nanum-barun-gothic":
      return '"MGT Nanum Barun Gothic", "Malgun Gothic", sans-serif';
    case "seoul-namsan":
      return '"MGT Seoul Namsan", "Malgun Gothic", sans-serif';
    case "seoul-namsan-vertical":
      return '"MGT Seoul Namsan Vertical", "Malgun Gothic", sans-serif';
    case "seoul-hangang":
      return '"MGT Seoul Hangang", "Malgun Gothic", serif';
    default:
      return '"Malgun Gothic", "Apple SD Gothic Neo", "Segoe UI", sans-serif';
  }
}

function normalizeExportColor(value: string | undefined, fallback: string): string {
  const text = String(value ?? "").trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback;
}

function findRendererCssHref(): string | null {
  const rendererDir = join(__dirname, "../renderer");
  const rendererIndexPath = join(rendererDir, "index.html");
  if (existsSync(rendererIndexPath)) {
    const html = readFileSync(rendererIndexPath, "utf8");
    const match = html.match(/<link[^>]+href=["']([^"']+index-[^"']+\.css)["']/i);
    if (match?.[1]) {
      const cssPath = join(rendererDir, match[1].replace(/^\.\//, ""));
      if (existsSync(cssPath)) {
        return pathToFileURL(cssPath).toString();
      }
    }
  }

  const assetDir = join(__dirname, "../renderer/assets");
  if (existsSync(assetDir)) {
    const cssFile = readdirSync(assetDir)
      .filter((file) => /^index-.*\.css$/i.test(file))
      .sort()
      .at(-1);
    if (cssFile) {
      return pathToFileURL(join(assetDir, cssFile)).toString();
    }
  }

  const sourceCssPath = join(process.cwd(), "src", "renderer", "src", "styles.css");
  return existsSync(sourceCssPath) ? pathToFileURL(sourceCssPath).toString() : null;
}

async function waitForExportRenderReady(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const tick = () => {
        if (document.body && document.body.dataset.ready === "1") {
          resolve(true);
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
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return char;
    }
  });
}

function mapRegionBlocksToPageBlocks(blocks: TranslationBlock[], page: MangaPage, cropRect: PixelRect): TranslationBlock[] {
  const pageSize = { width: page.width, height: page.height };
  return blocks.map((block) => {
    const id = `${page.id}-region-block-${randomUUID()}`;
    return {
      ...block,
      id,
      bbox: mapCropNormalizedBboxToPageBbox(cropRect, pageSize, block.bbox),
      renderBbox: block.renderBbox ? mapCropNormalizedBboxToPageBbox(cropRect, pageSize, block.renderBbox) : undefined,
      bboxSpace: "normalized_1000",
      renderBboxSpace: block.renderBbox ? "normalized_1000" : undefined
    };
  });
}

function registerIpc(): void {
  ipcMain.handle("logs:get-path", () => getLogPath());

  ipcMain.handle("logs:open-folder", async () => {
    await shell.showItemInFolder(getLogPath());
    return { opened: true, logPath: getLogPath() };
  });

  ipcMain.handle("logs:write", async (_event, level: "debug" | "info" | "warn" | "error", message: string, detail?: unknown) => {
    writeLog(level, `renderer: ${message}`, detail);
    return { logged: true };
  });

  ipcMain.handle("settings:get", async () => getAppSettings());
  ipcMain.handle("settings:save", async (_event, settings: AppSettings) => saveAppSettings(settings));
  ipcMain.handle("settings:reset", async () => resetAppSettings());
  ipcMain.handle("settings:pick-local-model", async (): Promise<LocalModelPickResult | null> => {
    const options = {
      title: "로컬 GGUF 모델 선택",
      properties: ["openFile"],
      filters: [{ name: "GGUF Model", extensions: ["gguf"] }]
    } satisfies Electron.OpenDialogOptions;
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }

    const modelPath = result.filePaths[0];
    const detectedMmprojPath = detectSiblingMmprojPath(modelPath);
    return {
      modelPath,
      ...(detectedMmprojPath ? { detectedMmprojPath } : {})
    };
  });
  ipcMain.handle("settings:pick-local-mmproj", async (): Promise<string | null> => {
    const options = {
      title: "mmproj 파일 선택",
      properties: ["openFile"],
      filters: [{ name: "GGUF Model", extensions: ["gguf"] }]
    } satisfies Electron.OpenDialogOptions;
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    return result.filePaths[0];
  });
  ipcMain.handle("settings:test-model", async (event, settings: AppSettings, providedTestId?: string): Promise<ModelTestResult> => {
    if (activeJob) {
      return {
        ok: false,
        message: "번역 작업 중에는 모델 테스트를 실행할 수 없습니다.",
        launchMode: resolveSettingsLaunchMode(settings)
      };
    }

    const runtime = loadSimplePageRuntime();
    const testId = typeof providedTestId === "string" && providedTestId.trim() ? providedTestId.trim() : randomUUID();
    const sendProgress = (progress: Omit<ModelTestProgressEvent, "id">) => {
      event.sender.send("settings:model-test-progress", {
        id: testId,
        ...progress
      } satisfies ModelTestProgressEvent);
    };
    const port = await reserveFreePort();
    const options = {
      ...buildBaseTranslationOptions({
        jobId: `settings-test-${testId}`,
        runDir: join(appPaths.dataRoot, "model-tests", testId),
        paths: appPaths,
        settings
      }),
      onProgress: (progress: Omit<ModelTestProgressEvent, "id">) => {
        sendProgress(progress);
      },
      reuseServer: false,
      port,
      label: `settings-test-${testId}`
    };

    let server: Awaited<ReturnType<SimplePageRuntime["startServer"]>> | OpenAIOAuthEndpoint | null = null;
    try {
      sendProgress({
        phase: "booting",
        progressText: "모델 테스트 준비 중",
        installLogLine: "모델 테스트를 시작합니다."
      });
      if (options.modelProvider === "openai-codex") {
        sendProgress({
          phase: "booting",
          progressText: "OpenAI Codex 엔드포인트 준비 중",
          detail: `${options.codexModel}, port ${options.codexOauthPort}`,
          installLogLine: "openai-oauth 엔드포인트를 시작합니다."
        });
      } else if (runtime.isModelCached(options)) {
        sendProgress({
          phase: "booting",
          progressText: "캐시된 Gemma 모델 확인됨",
          detail: options.modelFile,
          installLogLine: "캐시된 모델 파일을 사용합니다."
        });
      } else {
        sendProgress({
          phase: "model_downloading",
          progressText: "Gemma 모델 다운로드/서버 준비 중",
          detail: `${options.modelRepo} / ${options.modelFile}`,
          progressMode: "log-only",
          installLogLine: "캐시된 모델이 없어서 다운로드 또는 갱신을 시작합니다."
        });
      }
      server = options.modelProvider === "openai-codex" ? await startOpenAIOAuthEndpoint(options) : await runtime.startServer(options);
      sendProgress({
        phase: "ready",
        progressText: "서버 준비 완료",
        detail: server.baseUrl,
        installLogLine: `서버가 준비되었습니다: ${server.baseUrl}`
      });
      const result = await runtime.testModelReply(server, options);
      sendProgress({
        phase: "done",
        progressText: "모델 테스트 완료",
        detail: result.outputText,
        installLogLine: `응답 확인 완료: ${result.outputText}`
      });
      return {
        ok: true,
        message: `모델 로드 및 텍스트 응답 확인 완료: ${result.outputText}`,
        launchMode: options.modelProvider === "openai-codex" ? "openai-codex" : result.launchTarget.launchMode,
        resolvedModelPath: result.launchTarget.modelPath ?? null,
        resolvedMmprojPath: result.launchTarget.mmprojPath ?? null,
        resolvedEndpoint: options.modelProvider === "openai-codex" ? server.baseUrl : null
      };
    } catch (error) {
      sendProgress({
        phase: "failed",
        progressText: "모델 테스트 실패",
        detail: formatModelTestError(error),
        installLogLine: "모델 테스트가 실패했습니다."
      });
      return {
        ok: false,
        message: formatModelTestError(error),
        launchMode: resolveSettingsLaunchMode(settings)
      };
    } finally {
      if (isOpenAIOAuthEndpoint(server)) {
        await stopOpenAIOAuthEndpoint(server);
      } else {
        await runtime.stopServer(server);
      }
    }
  });

  ipcMain.handle("library:get-index", async () => listLibrary());
  ipcMain.handle("library:open-folder", async () => {
    await shell.openPath(getLibraryRoot());
    return { opened: true, libraryPath: getLibraryRoot() };
  });
  ipcMain.handle("library:open-chapter", async (_event, chapterId: string) => openChapter(chapterId));
  ipcMain.handle("library:get-page-image-data-url", async (_event, imagePath: string) => readLibraryPageImageDataUrl(imagePath));
  ipcMain.handle("library:save-chapter", async (_event, chapter) => saveChapterSnapshot(chapter));
  ipcMain.handle("library:rename-work", async (_event, workId: string, title: string) => renameWork(workId, title));
  ipcMain.handle("library:rename-chapter", async (_event, chapterId: string, title: string) => renameChapter(chapterId, title));
  ipcMain.handle("library:delete-work", async (_event, workId: string) => deleteWork(workId));
  ipcMain.handle("library:delete-chapter", async (_event, chapterId: string) => deleteChapter(chapterId));
  ipcMain.handle("library:reorder-chapters", async (_event, workId: string, chapterIds: string[]) => reorderChapters(workId, chapterIds));
  ipcMain.handle("library:reorder-pages", async (_event, chapterId: string, pageIds: string[]) => reorderPages(chapterId, pageIds));
  ipcMain.handle("library:delete-page", async (_event, chapterId: string, pageId: string) => deletePage(chapterId, pageId));

  ipcMain.handle("import:preview-images", async () => {
    const options = {
      title: "이미지 열기",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }]
    } satisfies Electron.OpenDialogOptions;
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const preview = await previewImages(result.filePaths);
    return preview.chapters[0]?.pages.length ? preview : null;
  });

  ipcMain.handle("import:preview-folder", async () => {
    const options = {
      title: "이미지 폴더 열기",
      properties: ["openDirectory"]
    } satisfies Electron.OpenDialogOptions;
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    const preview = await previewFolder(result.filePaths[0]);
    return preview.chapters[0]?.pages.length ? preview : null;
  });

  ipcMain.handle("import:preview-zip", async () => {
    const options = {
      title: "압축파일 열기",
      properties: ["openFile"],
      filters: [{ name: "ZIP Archive", extensions: ["zip"] }]
    } satisfies Electron.OpenDialogOptions;
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    const preview = await previewZip(result.filePaths[0]);
    return preview.chapters[0]?.pages.length ? preview : null;
  });

  ipcMain.handle("import:preview-zip-folder", async () => {
    const options = {
      title: "작품 일괄 번역",
      properties: ["openDirectory"]
    } satisfies Electron.OpenDialogOptions;
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    const preview = await previewZipFolder(result.filePaths[0]);
    return preview.chapters.length ? preview : null;
  });

  ipcMain.handle("import:create", async (_event, request: CreateImportRequest) => createImport(request));

  ipcMain.handle("share:export-work", async (_event, request: WorkShareExportRequest): Promise<WorkShareExportResult | null> => {
    const library = await listLibrary();
    const work = library.works.find((candidate) => candidate.id === request.workId);
    const defaultName = `${sanitizeShareFileName(work?.title ?? "manga-share")}.mgtshare`;
    const options = {
      title: "공유 파일 저장",
      defaultPath: defaultName,
      filters: [{ name: "Manga Gemma Share", extensions: ["mgtshare"] }]
    } satisfies Electron.SaveDialogOptions;
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      return null;
    }
    return exportWorkShareToFile({
      ...request,
      outputPath: result.filePath.toLowerCase().endsWith(".mgtshare") ? result.filePath : `${result.filePath}.mgtshare`
    });
  });

  ipcMain.handle("share:preview-import", async (): Promise<WorkShareImportPreview | null> => {
    const options = {
      title: "공유 파일 가져오기",
      properties: ["openFile"],
      filters: [{ name: "Manga Gemma Share", extensions: ["mgtshare"] }]
    } satisfies Electron.OpenDialogOptions;
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    return previewWorkShareImport(result.filePaths[0]);
  });

  ipcMain.handle("share:import", async (_event, request: WorkShareImportRequest): Promise<WorkShareImportResult> => importWorkShare(request));

  ipcMain.handle("job:start-analysis", async (_event, request: StartAnalysisRequest): Promise<StartAnalysisResult> => {
    if (activeJob) {
      return { status: "failed", error: "이미 실행 중인 작업이 있습니다." };
    }

    const resolved = await resolvePagesForRun(request.chapterId, request.runMode, request.pageId);
    if (resolved.pages.length === 0) {
      return {
        status: "completed",
        chapter: resolved.chapter,
        warnings: []
      };
    }

    const id = randomUUID();
    const abortController = new AbortController();
    const pageIds = resolved.pages.map((page) => page.id);
    let runPaths: Awaited<ReturnType<typeof getRunPaths>> | null = null;
    await markChapterPagesRunning(request.chapterId, pageIds);
    activeJob = { id, kind: "gemma-analysis", abortController };

    const emit = (event: JobEvent) => {
      if (activeJob?.id === id) {
        activeJob.lastEvent = event;
      }
      writeLog(event.status === "failed" ? "error" : event.status === "cancelled" ? "warn" : "info", `job:${event.kind}:${event.status}`, {
        id: event.id,
        progressText: event.progressText,
        phase: event.phase,
        progressCurrent: event.progressCurrent,
        progressTotal: event.progressTotal,
        progressMode: event.progressMode,
        progressPercent: event.progressPercent,
        progressBytes: event.progressBytes,
        progressTotalBytes: event.progressTotalBytes,
        progressBytesPerSecond: event.progressBytesPerSecond,
        installLogLine: event.installLogLine,
        pageIndex: event.pageIndex,
        pageTotal: event.pageTotal,
        attempt: event.attempt,
        attemptTotal: event.attemptTotal,
        detail: event.detail
      });
      mainWindow?.webContents.send("job:event", event);
    };

    try {
      runPaths = await getRunPaths(request.chapterId, id);
      const result = await runWholePagePipeline({
        jobId: id,
        emit,
        onCleanupReady: (cleanup) => {
          if (activeJob?.id === id) {
            activeJob.cleanup = cleanup;
          }
        },
        onPageComplete: async (page) => {
          await updatePageAfterAnalysis(request.chapterId, page, [], "completed");
        },
        onPageFailed: async (page, errorMessage) => {
          await updatePageAfterAnalysis(request.chapterId, page, [errorMessage], "failed");
        },
        pages: resolved.pages,
        runPaths,
        signal: abortController.signal
      });

      if (abortController.signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      emit({
        id,
        kind: "gemma-analysis",
        status: "completed",
        progressText: "번역 작업 완료",
        phase: "done",
        progressCurrent: resolved.pages.length,
        progressTotal: resolved.pages.length,
        pageTotal: resolved.pages.length
      });

      return {
        status: "completed",
        chapter: await openChapter(request.chapterId),
        warnings: result.warnings
      };
    } catch (error) {
      const lastEvent = activeJob?.id === id ? activeJob.lastEvent : undefined;
      if (isAbortError(error) || abortController.signal.aborted) {
        await finalizeRunningPages(request.chapterId, pageIds, "idle");
        emit({
          id,
          kind: "gemma-analysis",
          status: "cancelled",
          progressText: "작업이 취소되었습니다.",
          phase: "cancelled",
          progressCurrent: lastEvent?.progressCurrent,
          progressTotal: lastEvent?.progressTotal,
          pageIndex: lastEvent?.pageIndex,
          pageTotal: lastEvent?.pageTotal,
          attempt: lastEvent?.attempt,
          attemptTotal: lastEvent?.attemptTotal
        });
        return { status: "cancelled", chapter: await openChapter(request.chapterId) };
      }

      const message = error instanceof Error ? error.message : String(error);
      await finalizeRunningPages(request.chapterId, pageIds, "failed", message);
      logError("Analysis job failed", {
        jobId: id,
        request,
        chapterId: request.chapterId,
        runMode: request.runMode,
        pageIds,
        resolvedPageCount: resolved.pages.length,
        resolvedPageNames: resolved.pages.map((page) => page.name),
        runPaths,
        lastEvent,
        error
      });
      emit({
        id,
        kind: "gemma-analysis",
        status: "failed",
        progressText: "작업 실패",
        phase: "failed",
        progressCurrent: lastEvent?.progressCurrent,
        progressTotal: lastEvent?.progressTotal,
        pageIndex: lastEvent?.pageIndex,
        pageTotal: lastEvent?.pageTotal,
        attempt: lastEvent?.attempt,
        attemptTotal: lastEvent?.attemptTotal,
        detail: message
      });
      return {
        status: "failed",
        error: message,
        chapter: await openChapter(request.chapterId)
      };
    } finally {
      if (activeJob?.id === id) {
        await runJobCleanup(activeJob, "job-finished");
        activeJob = null;
      }
    }
  });

  ipcMain.handle("job:translate-region", async (_event, request: RegionAnalysisRequest): Promise<RegionAnalysisResult> => {
    if (activeJob) {
      return { status: "failed", error: "이미 실행 중인 작업이 있습니다." };
    }

    const chapter = await openChapter(request.chapterId);
    const page = chapter.pages.find((candidate) => candidate.id === request.pageId);
    if (!page) {
      return { status: "failed", chapter, error: "선택한 페이지를 찾지 못했습니다." };
    }

    const id = randomUUID();
    const abortController = new AbortController();
    let runPaths: Awaited<ReturnType<typeof getRunPaths>> | null = null;
    activeJob = { id, kind: "gemma-analysis", abortController };

    const emit = (event: JobEvent) => {
      if (activeJob?.id === id) {
        activeJob.lastEvent = event;
      }
      writeLog(event.status === "failed" ? "error" : event.status === "cancelled" ? "warn" : "info", `job:${event.kind}:${event.status}`, {
        id: event.id,
        progressText: event.progressText,
        phase: event.phase,
        progressCurrent: event.progressCurrent,
        progressTotal: event.progressTotal,
        progressMode: event.progressMode,
        progressPercent: event.progressPercent,
        progressBytes: event.progressBytes,
        progressTotalBytes: event.progressTotalBytes,
        progressBytesPerSecond: event.progressBytesPerSecond,
        installLogLine: event.installLogLine,
        pageIndex: event.pageIndex,
        pageTotal: event.pageTotal,
        attempt: event.attempt,
        attemptTotal: event.attemptTotal,
        detail: event.detail
      });
      mainWindow?.webContents.send("job:event", event);
    };

    try {
      runPaths = await getRunPaths(request.chapterId, id);
      const { cropPage, cropRect } = await createRegionCropPage(page, request.bbox, id, runPaths.runDir);
      emit({
        id,
        kind: "gemma-analysis",
        status: "starting",
        progressText: "선택 영역 번역 준비 중",
        phase: "booting",
        progressCurrent: 0,
        progressTotal: 1,
        pageTotal: 1,
        detail: `${Math.round(cropRect.w)} x ${Math.round(cropRect.h)} px`
      });

      const result = await runWholePagePipeline({
        jobId: id,
        emit,
        onCleanupReady: (cleanup) => {
          if (activeJob?.id === id) {
            activeJob.cleanup = cleanup;
          }
        },
        pages: [cropPage],
        runPaths,
        signal: abortController.signal,
        skipOcrPrepass: true
      });

      if (abortController.signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      const analyzedCrop = result.pages[0];
      const mappedBlocks = analyzedCrop ? mapRegionBlocksToPageBlocks(analyzedCrop.blocks, page, cropRect) : [];
      const latest = await openChapter(request.chapterId);
      const now = new Date().toISOString();
      const nextChapter: typeof latest = {
        ...latest,
        pages: latest.pages.map((candidate) =>
          candidate.id === request.pageId
            ? {
                ...candidate,
                blocks: [...candidate.blocks, ...mappedBlocks],
                analysisStatus: "completed",
                lastError: undefined,
                updatedAt: now
              }
            : candidate
        ),
        updatedAt: now
      };
      const saved = await saveChapterSnapshot(nextChapter);

      emit({
        id,
        kind: "gemma-analysis",
        status: "completed",
        progressText: "선택 영역 번역 완료",
        phase: "done",
        progressCurrent: 1,
        progressTotal: 1,
        pageTotal: 1,
        detail: `${mappedBlocks.length}개 블록`
      });

      return {
        status: "completed",
        chapter: saved,
        warnings: result.warnings,
        pageId: request.pageId,
        blockIds: mappedBlocks.map((block) => block.id)
      };
    } catch (error) {
      const lastEvent = activeJob?.id === id ? activeJob.lastEvent : undefined;
      if (isAbortError(error) || abortController.signal.aborted) {
        emit({
          id,
          kind: "gemma-analysis",
          status: "cancelled",
          progressText: "작업이 취소되었습니다.",
          phase: "cancelled",
          progressCurrent: lastEvent?.progressCurrent,
          progressTotal: lastEvent?.progressTotal,
          pageIndex: lastEvent?.pageIndex,
          pageTotal: lastEvent?.pageTotal,
          attempt: lastEvent?.attempt,
          attemptTotal: lastEvent?.attemptTotal
        });
        return { status: "cancelled", chapter: await openChapter(request.chapterId), pageId: request.pageId };
      }

      const message = error instanceof Error ? error.message : String(error);
      logError("Region translation job failed", {
        jobId: id,
        request,
        runPaths,
        lastEvent,
        error
      });
      emit({
        id,
        kind: "gemma-analysis",
        status: "failed",
        progressText: "작업 실패",
        phase: "failed",
        progressCurrent: lastEvent?.progressCurrent,
        progressTotal: lastEvent?.progressTotal,
        pageIndex: lastEvent?.pageIndex,
        pageTotal: lastEvent?.pageTotal,
        attempt: lastEvent?.attempt,
        attemptTotal: lastEvent?.attemptTotal,
        detail: message
      });
      return {
        status: "failed",
        error: message,
        chapter: await openChapter(request.chapterId),
        pageId: request.pageId
      };
    } finally {
      if (activeJob?.id === id) {
        await runJobCleanup(activeJob, "region-job-finished");
        activeJob = null;
      }
    }
  });

  ipcMain.handle("job:start-inpainting", async (_event, request: StartInpaintingRequest): Promise<StartInpaintingResult> => {
    if (activeJob) {
      return { status: "failed", error: "이미 실행 중인 작업이 있습니다." };
    }

    const chapter = await openChapter(request.chapterId);
    const drawnPatternMode = request.mode === "page-pattern-drawn";
    const drawnStrokes = request.mode === "page-pattern-drawn" ? request.strokes : [];
    const drawnFeatherPx = request.mode === "page-pattern-drawn" ? request.featherPx : undefined;
    const targetLabel = drawnPatternMode ? "그린 영역" : "무늬 배경";
    const pages =
      "pageId" in request
        ? chapter.pages.filter((page) => page.id === request.pageId)
        : chapter.pages;

    if (pages.length === 0) {
      return { status: "failed", chapter, error: "인페인팅할 페이지를 찾지 못했습니다." };
    }

    const id = randomUUID();
    const abortController = new AbortController();
    activeJob = { id, kind: "inpainting", abortController };
    let fluxEngine: FluxInpaintingEngine | null = null;

    const emit = (event: JobEvent) => {
      if (activeJob?.id === id) {
        activeJob.lastEvent = event;
      }
      writeLog(event.status === "failed" ? "error" : event.status === "cancelled" ? "warn" : "info", `job:${event.kind}:${event.status}`, {
        id: event.id,
        progressText: event.progressText,
        phase: event.phase,
        progressCurrent: event.progressCurrent,
        progressTotal: event.progressTotal,
        pageIndex: event.pageIndex,
        pageTotal: event.pageTotal,
        detail: event.detail
      });
      mainWindow?.webContents.send("job:event", event);
    };

    try {
      const totalTargetBlocks = drawnPatternMode
        ? drawnStrokes.length
        : pages.reduce((count, page) => count + page.blocks.length, 0);
      emit({
        id,
        kind: "inpainting",
        status: "starting",
        progressText: `${targetLabel} 지우기 준비 중`,
        phase: "inpainting_preparing",
        progressCurrent: 0,
        progressTotal: pages.length,
        pageTotal: pages.length,
        detail: `${pages.length}페이지, ${totalTargetBlocks}개 블록`
      });

      let blocksErased = 0;
      const changedPages: MangaPage[] = [];
      if (totalTargetBlocks > 0) {
        fluxEngine = await prepareFluxInpaintingEngine({
          runtimeDir: join(appPaths.dataRoot, "models", "inpainting", "mgt-flux-klein-runtime"),
          modelDir: join(appPaths.dataRoot, "models", "inpainting", "flux-klein-4b"),
          signal: abortController.signal,
          onProgress: (progress) =>
            emit({
              id,
              kind: "inpainting",
              status: "starting",
              progressText: progress.progressText,
              phase: "model_downloading",
              progressCurrent: 0,
              progressTotal: pages.length,
              pageTotal: pages.length,
              detail: progress.detail,
              progressMode: progress.progressMode,
              progressPercent: progress.progressPercent,
              progressBytes: progress.progressBytes,
              progressTotalBytes: progress.progressTotalBytes,
              installLogLine: progress.installLogLine
            })
        });
      }
      for (const [pageIndex, page] of pages.entries()) {
        if (abortController.signal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }

        const pageTargetCount = drawnPatternMode ? drawnStrokes.length : page.blocks.length;
        emit({
          id,
          kind: "inpainting",
          status: "running",
          progressText: `${pageIndex + 1} / ${pages.length} 페이지 ${targetLabel} 지우는 중`,
          phase: "inpainting_running",
          progressCurrent: pageIndex + 1,
          progressTotal: pages.length,
          pageIndex: pageIndex + 1,
          pageTotal: pages.length,
          detail: `${page.name} · ${pageTargetCount}${drawnPatternMode ? "개 그린 영역" : "개 블록"}`
        });

        const result = drawnPatternMode
          ? await inpaintDrawnPatternPage(page, {
              signal: abortController.signal,
              decodeFallback: decodeImageThroughRuntime,
              fluxEngine: fluxEngine ?? undefined,
              strokes: drawnStrokes,
              featherPx: drawnFeatherPx
            })
          : await inpaintPatternPage(page, {
              signal: abortController.signal,
              decodeFallback: decodeImageThroughRuntime,
              fluxEngine: fluxEngine ?? undefined
            });
        if (result.blocksErased > 0) {
          changedPages.push(result.page);
          blocksErased += result.blocksErased;
        }

        emit({
          id,
          kind: "inpainting",
          status: "running",
          progressText: `${pageIndex + 1} / ${pages.length} 페이지 ${targetLabel} 완료`,
          phase: "inpainting_done",
          progressCurrent: pageIndex + 1,
          progressTotal: pages.length,
          pageIndex: pageIndex + 1,
          pageTotal: pages.length,
          detail: `${result.blocksErased}개 블록`
        });
      }

      const saved = changedPages.length > 0 ? await updatePagesAfterInpainting(request.chapterId, changedPages) : await openChapter(request.chapterId);
      emit({
        id,
        kind: "inpainting",
        status: "completed",
        progressText: `${targetLabel} 지우기 완료`,
        phase: "done",
        progressCurrent: pages.length,
        progressTotal: pages.length,
        pageTotal: pages.length,
        detail: `${pages.length}페이지, ${blocksErased}개 블록`
      });

      return {
        status: "completed",
        chapter: saved,
        pagesChanged: changedPages.length,
        blocksErased
      };
    } catch (error) {
      const lastEvent = activeJob?.id === id ? activeJob.lastEvent : undefined;
      if (isAbortError(error) || abortController.signal.aborted) {
        emit({
          id,
          kind: "inpainting",
          status: "cancelled",
          progressText: "인페인팅 작업이 취소되었습니다.",
          phase: "cancelled",
          progressCurrent: lastEvent?.progressCurrent,
          progressTotal: lastEvent?.progressTotal,
          pageIndex: lastEvent?.pageIndex,
          pageTotal: lastEvent?.pageTotal
        });
        return { status: "cancelled", chapter: await openChapter(request.chapterId) };
      }

      const message = error instanceof Error ? error.message : String(error);
      logError("Inpainting job failed", { jobId: id, request, lastEvent, error });
      emit({
        id,
        kind: "inpainting",
        status: "failed",
        progressText: "인페인팅 작업 실패",
        phase: "failed",
        progressCurrent: lastEvent?.progressCurrent,
        progressTotal: lastEvent?.progressTotal,
        pageIndex: lastEvent?.pageIndex,
        pageTotal: lastEvent?.pageTotal,
        detail: message
      });
      return {
        status: "failed",
        error: message,
        chapter: await openChapter(request.chapterId)
      };
    } finally {
      if (fluxEngine) {
        await fluxEngine.dispose().catch((error) => logError("Failed to dispose Flux inpainting session", { error }));
      }
      if (activeJob?.id === id) {
        activeJob = null;
      }
    }
  });

  ipcMain.handle("inpainting:apply-retouch", async (_event, request: InpaintingRetouchRequest): Promise<InpaintingRetouchResult> => {
    const chapter = await openChapter(request.chapterId);
    const page = chapter.pages.find((candidate) => candidate.id === request.pageId);
    if (!page) {
      throw new Error("리터치할 페이지를 찾지 못했습니다.");
    }
    const nextPage = await applyInpaintingRetouch(page, {
      mode: request.mode,
      points: request.points,
      radiusPx: request.radiusPx,
      color: request.color,
      decodeFallback: decodeImageThroughRuntime
    });
    const saved = await updatePagesAfterInpainting(request.chapterId, [nextPage]);
    return {
      chapter: saved,
      pageId: request.pageId
    };
  });

  ipcMain.handle("inpainting:revert", async (_event, request: InpaintingRevertRequest): Promise<InpaintingRevertResult> => {
    const chapter = await openChapter(request.chapterId);
    const pages =
      request.scope === "page"
        ? chapter.pages.filter((page) => page.id === request.pageId && page.inpaintedImagePath)
        : chapter.pages.filter((page) => page.inpaintedImagePath);
    if (pages.length === 0) {
      return {
        chapter,
        pagesChanged: 0
      };
    }
    const reverted = pages.map((page) => ({
      ...page,
      inpaintedImagePath: undefined,
      updatedAt: new Date().toISOString()
    }));
    const saved = await updatePagesAfterInpainting(request.chapterId, reverted);
    return {
      chapter: saved,
      pagesChanged: reverted.length
    };
  });

  ipcMain.handle("inpainting:sample-color", async (_event, request: InpaintingColorSampleRequest): Promise<InpaintingColorSampleResult> => {
    return {
      color: await sampleImageColor(request.imagePath, request.x, request.y, decodeImageThroughRuntime)
    };
  });

  ipcMain.handle("inpainting:export-results", async (_event, request: InpaintingExportRequest): Promise<InpaintingExportResult> => {
    const chapter = await openChapter(request.chapterId);
    if (chapter.pages.length === 0) {
      throw new Error("출력할 페이지가 없습니다.");
    }

    const firstPageDir = dirname(chapter.pages[0].imagePath);
    const chapterDir = dirname(firstPageDir);
    const outputDir = join(chapterDir, "processed", new Date().toISOString().replace(/[:.]/g, "-"));
    await mkdir(outputDir, { recursive: true });

    for (const [index, page] of chapter.pages.entries()) {
      const outputName = `${String(index + 1).padStart(3, "0")}-${sanitizeOutputBaseName(page.name)}.png`;
      const png = await renderPageWithTranslationBlocksForExport(page);
      await writeFile(join(outputDir, outputName), png);
    }

    await shell.openPath(outputDir);
    return {
      outputDir,
      pageCount: chapter.pages.length
    };
  });

  ipcMain.handle("job:cancel", async () => {
    if (!activeJob) {
      return { cancelled: false };
    }

    const job = activeJob;
    mainWindow?.webContents.send("job:event", {
      id: job.id,
      kind: job.kind,
      status: "cancelling",
      progressText: "작업 취소 중",
      progressCurrent: job.lastEvent?.progressCurrent,
      progressTotal: job.lastEvent?.progressTotal,
      pageIndex: job.lastEvent?.pageIndex,
      pageTotal: job.lastEvent?.pageTotal,
      attempt: job.lastEvent?.attempt,
      attemptTotal: job.lastEvent?.attemptTotal
    } satisfies JobEvent);
    job.abortController.abort();
    await runJobCleanup(job, "cancel");
    return { cancelled: true };
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function isZipPath(path: string): boolean {
  return extname(path).toLowerCase() === ".zip";
}

function loadSimplePageRuntime(): SimplePageRuntime {
  if (cachedSimplePageRuntime) {
    return cachedSimplePageRuntime;
  }

  cachedSimplePageRuntime = require(join(appPaths.runtimeDir, "simple-page-translate.cjs")) as SimplePageRuntime;
  return cachedSimplePageRuntime;
}

async function decodeImageThroughRuntime(filePath: string): Promise<Buffer | null> {
  const runtime = loadSimplePageRuntime();
  if (!runtime.convertImageToPngBufferWithFfmpeg) {
    return null;
  }
  return runtime.convertImageToPngBufferWithFfmpeg(filePath);
}

function detectSiblingMmprojPath(modelPath: string): string | null {
  const folder = dirname(modelPath);
  if (!existsSync(folder)) {
    return null;
  }

  const preferredNames = ["mmproj-BF16.gguf", "mmproj-F16.gguf", "mmproj-F32.gguf", "mmproj.gguf"];
  for (const name of preferredNames) {
    const candidate = join(folder, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const match = readdirSync(folder, { withFileTypes: true }).find(
    (entry) => entry.isFile() && /^mmproj.*\.gguf$/i.test(entry.name)
  );
  return match ? join(folder, match.name) : null;
}

function resolveSettingsLaunchMode(settings: AppSettings): ModelTestResult["launchMode"] {
  if (settings.modelProvider === "openai-codex") {
    return "openai-codex";
  }
  return settings.gemma.modelSource === "local" ? "local" : "huggingface";
}

function sanitizeShareFileName(value: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return cleaned || "manga-share";
}

function isOpenAIOAuthEndpoint(server: Awaited<ReturnType<SimplePageRuntime["startServer"]>> | OpenAIOAuthEndpoint | null): server is OpenAIOAuthEndpoint {
  return Boolean(server && "provider" in server && server.provider === "openai-codex");
}

async function reserveFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("모델 테스트용 포트를 확보하지 못했습니다."));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function formatModelTestError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const details = [
    error.message,
    "recentStderr" in error && typeof error.recentStderr === "string" && error.recentStderr.trim()
      ? error.recentStderr.trim()
      : null,
    "rawTextPreview" in error && typeof error.rawTextPreview === "string" && error.rawTextPreview.trim()
      ? error.rawTextPreview.trim()
      : null
  ].filter(Boolean);

  return details.join("\n\n");
}
