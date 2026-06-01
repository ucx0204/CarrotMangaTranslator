import { BrowserWindow, nativeImage } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { bboxToPixels, clamp, resolveEffectiveRenderBbox } from "../shared/geometry";
import type { MangaPage, TranslationBlock } from "../shared/types";
import type { ImageDecodeFallback } from "./regionCrop";

export async function renderPageWithTranslationBlocksForExport(
  page: MangaPage,
  options: {
    dataRoot: string;
    decodeFallback: ImageDecodeFallback;
  }
): Promise<Buffer> {
  const sourcePath = page.inpaintedImagePath || page.imagePath;
  const image = await loadImageForPngExport(sourcePath, options.decodeFallback);
  const size = image.getSize();
  const width = Math.max(1, size.width || page.width);
  const height = Math.max(1, size.height || page.height);
  const imageDataUrl = `data:image/png;base64,${image.toPNG().toString("base64")}`;
  const html = buildPageExportHtml(page, imageDataUrl, width, height);
  const renderDir = join(options.dataRoot, "tmp", "png-export-render");
  await mkdir(renderDir, { recursive: true });
  const htmlPath = join(renderDir, `${page.id}-${randomUUID()}.html`);
  const win = new BrowserWindow({
    width: Math.min(1200, width),
    height: Math.min(1000, height),
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
    const pngDataUrl = await win.webContents.executeJavaScript("window.__exportPngDataUrl", true);
    if (typeof pngDataUrl !== "string" || !pngDataUrl.startsWith("data:image/png;base64,")) {
      throw new Error(`출력 PNG 데이터를 만들지 못했습니다: ${page.name}`);
    }
    const png = Buffer.from(pngDataUrl.slice("data:image/png;base64,".length), "base64");
    if (!png.length) {
      throw new Error(`출력 PNG를 만들지 못했습니다: ${page.name}`);
    }
    return png;
  } finally {
    win.destroy();
    await rm(htmlPath, { force: true }).catch(() => {});
  }
}

export function sanitizeOutputBaseName(value: string): string {
  const raw = basename(value, extname(value)) || "page";
  const cleaned = raw.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return (cleaned || "page").slice(0, 80);
}

async function loadImageForPngExport(imagePath: string, decodeFallback: ImageDecodeFallback): Promise<Electron.NativeImage> {
  const direct = nativeImage.createFromPath(imagePath);
  if (!direct.isEmpty()) {
    return direct;
  }

  const pngBuffer = await decodeFallback(imagePath);
  if (pngBuffer) {
    const converted = nativeImage.createFromBuffer(pngBuffer);
    if (!converted.isEmpty()) {
      return converted;
    }
  }

  throw new Error(`출력할 이미지를 읽지 못했습니다: ${imagePath}`);
}

function buildPageExportHtml(page: MangaPage, imageDataUrl: string, width: number, height: number): string {
  const rendererCssHref = findRendererCssHref();
  const blocks = buildPageExportBlocks(page, width, height);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: file:; font-src data: file:; style-src 'unsafe-inline' file:; script-src 'unsafe-inline';" />
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
  <canvas id="exportCanvas" width="${width}" height="${height}" style="display:block;width:${width}px;height:${height}px"></canvas>
</div>
<script>
const EXPORT_BLOCKS = ${safeScriptJson(blocks)};
const EXPORT_IMAGE_DATA_URL = ${safeScriptJson(imageDataUrl)};
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

function resolveOutlineWidth(fontSize) {
  return Math.round(Math.min(4, Math.max(0.35, fontSize * 0.055)) * 2 * 10) / 10;
}

function drawOutlinedText(ctx, text, x, y, block, fontSize) {
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  ctx.lineWidth = resolveOutlineWidth(fontSize);
  ctx.strokeStyle = block.outlineColor;
  ctx.fillStyle = block.textColor;
  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
}

function drawHorizontalText(ctx, block, rect, fontSize) {
  const innerWidth = Math.max(1, rect.width - 2);
  const measured = measureHorizontal(block, fontSize, innerWidth);
  const lineHeightPx = fontSize * block.lineHeight;
  const totalHeight = measured.lines.length * lineHeightPx;
  const startY = rect.top + Math.max(0, (rect.height - totalHeight) / 2);
  const align = block.textAlign || "center";
  const x = align === "left" ? rect.left + 1 : align === "right" ? rect.left + rect.width - 1 : rect.left + rect.width / 2;
  ctx.font = buildFont(fontSize, block.fontFamily);
  ctx.textAlign = align;
  ctx.textBaseline = "top";
  for (const [index, line] of measured.lines.entries()) {
    drawOutlinedText(ctx, line, x, startY + index * lineHeightPx, block, fontSize);
  }
}

function drawVerticalText(ctx, block, rect, fontSize) {
  const compact = block.text.replace(/\\r/g, "").replace(/\\s+/g, "");
  if (!compact) {
    return;
  }
  const chars = Array.from(compact);
  const lineHeightPx = fontSize * block.lineHeight;
  const charsPerColumn = Math.max(1, Math.floor(Math.max(1, rect.height - 2) / lineHeightPx));
  const columns = [];
  for (let index = 0; index < chars.length; index += charsPerColumn) {
    columns.push(chars.slice(index, index + charsPerColumn));
  }
  const columnGap = fontSize * 1.15;
  const totalWidth = Math.max(columnGap, columns.length * columnGap);
  const firstX = rect.left + rect.width / 2 + totalWidth / 2 - columnGap / 2;
  ctx.font = buildFont(fontSize, block.fontFamily);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const [columnIndex, column] of columns.entries()) {
    const x = firstX - columnIndex * columnGap;
    const columnHeight = column.length * lineHeightPx;
    const startY = rect.top + Math.max(0, (rect.height - columnHeight) / 2);
    for (const [rowIndex, char] of column.entries()) {
      drawOutlinedText(ctx, char, x, startY + rowIndex * lineHeightPx, block, fontSize);
    }
  }
}

function drawExportBlock(ctx, block) {
  const rect = block.rect;
  const innerWidth = Math.max(1, rect.width - 2);
  const innerHeight = Math.max(1, rect.height - 2);
  const fontSize = resolveFontSize(block, innerWidth, innerHeight);
  ctx.save();
  let drawRect = rect;
  if (block.rotationDeg) {
    ctx.translate(rect.left + rect.width / 2, rect.top + rect.height / 2);
    ctx.rotate((block.rotationDeg * Math.PI) / 180);
    drawRect = { left: -rect.width / 2, top: -rect.height / 2, width: rect.width, height: rect.height };
  }
  if (block.renderDirection === "vertical") {
    drawVerticalText(ctx, block, drawRect, fontSize);
  } else {
    drawHorizontalText(ctx, block, drawRect, fontSize);
  }
  ctx.restore();
}

function loadExportImage() {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("export image load failed"));
    image.src = EXPORT_IMAGE_DATA_URL;
  });
}

async function renderCanvasPng() {
  const outputCanvas = document.getElementById("exportCanvas");
  const ctx = outputCanvas.getContext("2d");
  if (!ctx) {
    throw new Error("canvas context unavailable");
  }
  const image = await loadExportImage();
  ctx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
  ctx.drawImage(image, 0, 0, outputCanvas.width, outputCanvas.height);
  for (const block of EXPORT_BLOCKS) {
    drawExportBlock(ctx, block);
  }
  window.__exportPngDataUrl = outputCanvas.toDataURL("image/png");
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
  await renderCanvasPng();
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

function safeScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
