import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CustomFont, MangaPage } from "../shared/types";
import { getAppPaths } from "./appPaths";
import { listCustomFonts, resolveCustomFontFilePath } from "./customFonts";
import { buildPageExportBlocks } from "./pageExportBlocks";

export function buildPageExportHtml(page: MangaPage, imageDataUrl: string, width: number, height: number): string {
  const rendererCssHref = findRendererCssHref();
  const customFonts = listCustomFonts();
  const customFamilyById = new Map(customFonts.map((font) => [font.id, font.family]));
  const customFontFaces = buildCustomFontFaces(customFonts);
  const blocks = buildPageExportBlocks(page, width, height, customFamilyById);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: file:; font-src data: file:; style-src 'unsafe-inline' file:; script-src 'unsafe-inline';" />
${rendererCssHref ? `<link rel="stylesheet" href="${escapeHtml(rendererCssHref)}" />` : ""}
<style>
${customFontFaces}
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

function buildFont(size, family, weight, italic) {
  return (italic ? "italic " : "") + (weight || 600) + " " + size + "px " + family;
}

function blockFontWeight(block) {
  return block.bold ? 800 : 400;
}

function wrapTextToWidth(text, maxWidth, fontSize, fontFamily, weight, italic) {
  context.font = buildFont(fontSize, fontFamily, weight, italic);
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
  const weight = blockFontWeight(block);
  const lines = wrapTextToWidth(block.text, innerWidth, fontSize, block.fontFamily, weight, block.italic);
  context.font = buildFont(fontSize, block.fontFamily, weight, block.italic);
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

function resolveOutlineWidth(fontSize) {
  return Math.round(Math.min(4, Math.max(0.35, fontSize * 0.055)) * 2 * 10) / 10;
}

function drawOutlinedText(ctx, text, x, y, block, fontSize) {
  const outlineScale = block.outlineWidthScale == null ? 1 : block.outlineWidthScale;
  ctx.fillStyle = block.textColor;
  if (outlineScale > 0) {
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.lineWidth = resolveOutlineWidth(fontSize) * outlineScale;
    ctx.strokeStyle = block.outlineColor;
    ctx.strokeText(text, x, y);
  }
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
  ctx.font = buildFont(fontSize, block.fontFamily, blockFontWeight(block), block.italic);
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
  ctx.font = buildFont(fontSize, block.fontFamily, blockFontWeight(block), block.italic);
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

async function preloadExportFonts() {
  if (!document.fonts) {
    return;
  }
  const loads = [];
  for (const block of EXPORT_BLOCKS) {
    const size = Math.max(MIN_FONT_SIZE, Math.floor(block.fontSizePx || 20));
    loads.push(document.fonts.load("400 " + size + "px " + block.fontFamily));
    loads.push(document.fonts.load("600 " + size + "px " + block.fontFamily));
    loads.push(document.fonts.load("700 " + size + "px " + block.fontFamily));
    loads.push(document.fonts.load("800 " + size + "px " + block.fontFamily));
    loads.push(document.fonts.load("italic 400 " + size + "px " + block.fontFamily));
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

function buildCustomFontFaces(fonts: CustomFont[]): string {
  return fonts
    .flatMap((font) => {
      const fontPath = resolveCustomFontFilePath(font.id);
      if (!fontPath) {
        return [];
      }
      const fileUrl = pathToFileURL(fontPath).toString();
      return `@font-face { font-family: "${font.family}"; src: url("${fileUrl}"); font-display: swap; }`;
    })
    .join("\n");
}

function findRendererCssHref(): string | null {
  const appPaths = getAppPaths();
  const rendererDir = join(__dirname, "../renderer");
  const rendererIndexPath = join(rendererDir, "index.html");
  if (existsSync(rendererIndexPath)) {
    const html = readFileSync(rendererIndexPath, "utf8");
    const match = html.match(/<link[^>]+href=["']([^"']+index-[^"']+\.css)["']/i);
    if (match?.[1]) {
      const cssHref = resolveExistingFileUrlInside(rendererDir, resolveRendererAssetPath(rendererDir, match[1]));
      if (cssHref) {
        return cssHref;
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
      const cssHref = resolveExistingFileUrlInside(assetDir, join(assetDir, cssFile));
      if (cssHref) {
        return cssHref;
      }
    }
  }

  if (!appPaths.isPackaged) {
    return resolveExistingFileUrlInside(appPaths.repoRoot, join(appPaths.repoRoot, "src", "renderer", "src", "styles.css"));
  }
  return null;
}

function resolveRendererAssetPath(rendererDir: string, href: string): string {
  const rendererRelativePath = href.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  return resolve(rendererDir, rendererRelativePath);
}

function resolveExistingFileUrlInside(rootPath: string, targetPath: string): string | null {
  const resolvedRoot = resolve(rootPath);
  const resolvedTarget = resolve(targetPath);
  if (!isPathInside(resolvedRoot, resolvedTarget) || !existsSync(resolvedTarget)) {
    return null;
  }
  return pathToFileURL(resolvedTarget).toString();
}

function isPathInside(rootPath: string, targetPath: string): boolean {
  const child = relative(rootPath, targetPath);
  return child === "" || (!!child && !child.startsWith("..") && !isAbsolute(child));
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
