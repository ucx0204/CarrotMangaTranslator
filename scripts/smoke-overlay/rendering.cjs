const { BrowserWindow } = require("electron");
const { readFile, rm, writeFile } = require("node:fs/promises");
const path = require("node:path");

/**
 * @typedef {import("../../src/shared/libraryTypes").MangaPage} MangaPage
 * @typedef {import("../../src/shared/textTypes").TranslationBlock} TranslationBlock
 * @typedef {TranslationBlock & { direction?: string; angle?: number; fontSize?: number; sourceDirection?: string; sourceType?: string }} GeometryBlock
 * @typedef {TranslationBlock & { rect: { left: number; top: number; width: number; height: number }; fontSize: number; text: string }} RenderBlock
 * @typedef {{ filePath: string; groupKey: string; hash: number }} SmokeSample
 * @typedef {{ pattern: number; other: number }} BlockTypeCounts
 * @typedef {{ index: number; sample: SmokeSample; geometryPath: string; overlayPath: string; blockCount: number; typeCounts: BlockTypeCounts; elapsedMs: number }} RenderedSmokeItem
 * @typedef {RenderedSmokeItem & { imageSrc: string }} ContactSheetItem
 * @typedef {{ resolveEffectiveRenderBbox?: (block: TranslationBlock, pageSize: { width: number; height: number }, text: string) => { x: number; y: number; w: number; h: number } }} GeometryModule
 */

/**
 * @param {{ maxCaptureLongSide: number; getSharedGeometry: () => GeometryModule | null }} dependencies
 */
function createSmokeRenderer({ maxCaptureLongSide, getSharedGeometry }) {
  return {
    /** @param {MangaPage} page @param {GeometryBlock[]} items @param {string} outputPath */
    renderGeometryPng: (page, items, outputPath) =>
      renderGeometryPng(page, items, outputPath, maxCaptureLongSide),
    /** @param {MangaPage} page @param {string} outputPath */
    renderOverlayPng: (page, outputPath) =>
      renderOverlayPng(
        page,
        outputPath,
        maxCaptureLongSide,
        getSharedGeometry(),
      ),
    renderContactSheet,
  };
}

/** @param {MangaPage} page @param {string} outputPath @param {number} maxLongSide @param {GeometryModule | null} geometry */
async function renderOverlayPng(page, outputPath, maxLongSide, geometry) {
  const view = await createPageView(page, maxLongSide);
  const html = buildOverlayHtml(page, view.scale, view.imageDataUrl, geometry);
  await captureHtml(html, outputPath, view.width, view.height);
}

/** @param {MangaPage} page @param {GeometryBlock[]} items @param {string} outputPath @param {number} maxLongSide */
async function renderGeometryPng(page, items, outputPath, maxLongSide) {
  const view = await createPageView(page, maxLongSide);
  const html = buildGeometryHtml(page, items, view.scale, view.imageDataUrl);
  await captureHtml(html, outputPath, view.width, view.height);
}

/** @param {MangaPage} page @param {number} maxLongSide */
async function createPageView(page, maxLongSide) {
  const scale = Math.min(1, maxLongSide / Math.max(page.width, page.height));
  return {
    scale,
    width: Math.max(1, Math.round(page.width * scale)),
    height: Math.max(1, Math.round(page.height * scale)),
    imageDataUrl: await readImageDataUrl(page.imagePath),
  };
}

/** @param {string} html @param {string} outputPath @param {number} width @param {number} height */
async function captureHtml(html, outputPath, width, height) {
  const htmlPath = `${outputPath}.html`;
  await writeFile(htmlPath, html, "utf8");
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    webPreferences: { offscreen: true },
  });
  try {
    await win.loadFile(htmlPath);
    await waitForReady(win);
    const image = await win.webContents.capturePage();
    await writeFile(outputPath, image.toPNG());
  } finally {
    win.destroy();
    await rm(htmlPath, { force: true });
  }
}

/** @param {MangaPage} page @param {GeometryBlock[]} items @param {number} scale @param {string} imageDataUrl */
function buildGeometryHtml(page, items, scale, imageDataUrl) {
  const rows = items.map((item, index) =>
    renderGeometryBox(page, item, index, scale),
  );
  return `<!doctype html>
<html><head><meta charset="utf-8" /><style>
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #111; }
.stage { position: relative; width: ${Math.round(page.width * scale)}px; height: ${Math.round(page.height * scale)}px; }
.page { position: absolute; inset: 0; width: 100%; height: 100%; }
.bbox { position: absolute; box-sizing: border-box; border: 3px solid; background: rgba(255,255,255,.12); }
.bbox span { position: absolute; left: 0; top: -22px; padding: 2px 5px; background: rgba(0,0,0,.78); font: 700 13px "Malgun Gothic", sans-serif; white-space: nowrap; }
</style></head><body><div class="stage">
<img class="page" src="${escapeHtml(imageDataUrl)}" />${rows.join("\n")}
</div><script>window.addEventListener("load", () => setTimeout(() => document.body.dataset.ready = "1", 120));</script>
</body></html>`;
}

/** @param {MangaPage} page @param {GeometryBlock} item @param {number} index @param {number} scale */
function renderGeometryBox(page, item, index, scale) {
  const left = (item.bbox.x / 1000) * page.width * scale;
  const top = (item.bbox.y / 1000) * page.height * scale;
  const width = (item.bbox.w / 1000) * page.width * scale;
  const height = (item.bbox.h / 1000) * page.height * scale;
  const direction = item.direction || item.sourceDirection || "horizontal";
  const angle = item.angle ?? item.rotationDeg ?? 0;
  const fontSize = item.fontSize ?? item.fontSizePx ?? "?";
  const label = `${index + 1} ${item.type || "dialogue"} ${direction} ${angle}deg ${fontSize}px`;
  return `<div class="bbox" style="left:${left}px;top:${top}px;width:${width}px;height:${height}px;border-color:#f59e0b;color:#f59e0b;"><span>${escapeHtml(label)}</span></div>`;
}

/** @param {MangaPage} page @param {number} scale @param {string} imageDataUrl @param {GeometryModule | null} geometry */
function buildOverlayHtml(page, scale, imageDataUrl, geometry) {
  const blocks = page.blocks.map((block) =>
    toRenderBlock(page, block, scale, geometry),
  );
  return `<!doctype html>
<html><head><meta charset="utf-8" /><style>
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #111; }
.stage { position: relative; width: ${Math.round(page.width * scale)}px; height: ${Math.round(page.height * scale)}px; }
.page { position: absolute; inset: 0; width: 100%; height: 100%; }
.block { position: absolute; display: grid; place-items: center; box-sizing: border-box; overflow: hidden; padding: 0; border: 1px solid rgba(50,50,50,.32); border-radius: 4px; font-family: "Malgun Gothic","Apple SD Gothic Neo",sans-serif; font-weight: 600; white-space: pre-wrap; text-align: center; }
.text { max-width: 100%; max-height: 100%; overflow-wrap: anywhere; word-break: break-word; }
</style></head><body><div class="stage">
<img class="page" src="${escapeHtml(imageDataUrl)}" />
${blocks.map(renderBlockHtml).join("\n")}
</div><script>
const MIN_FONT_SIZE = 10;
for (const block of document.querySelectorAll(".block")) {
  const text = block.querySelector(".text");
  let size = Number(block.dataset.fontSize || "10");
  text.style.fontSize = size + "px";
  text.style.lineHeight = block.dataset.lineHeight || "1.18";
  while (size > MIN_FONT_SIZE && (text.scrollWidth > block.clientWidth || text.scrollHeight > block.clientHeight)) {
    size -= 1;
    text.style.fontSize = size + "px";
  }
}
window.addEventListener("load", () => setTimeout(() => document.body.dataset.ready = "1", 120));
</script></body></html>`;
}

/** @param {MangaPage} page @param {TranslationBlock} block @param {number} scale @param {GeometryModule | null} geometry @returns {RenderBlock} */
function toRenderBlock(page, block, scale, geometry) {
  const text = block.translatedText || block.sourceText || "...";
  const box = geometry?.resolveEffectiveRenderBbox
    ? geometry.resolveEffectiveRenderBbox(
        block,
        { width: page.width, height: page.height },
        text,
      )
    : block.renderBbox || block.bbox;
  return {
    ...block,
    rect: {
      left: (box.x / 1000) * page.width * scale,
      top: (box.y / 1000) * page.height * scale,
      width: (box.w / 1000) * page.width * scale,
      height: (box.h / 1000) * page.height * scale,
    },
    fontSize: Math.max(10, Math.round(block.fontSizePx * scale)),
    text,
  };
}

/** @param {RenderBlock} block */
function renderBlockHtml(block) {
  const bg = hexToRgba(block.backgroundColor, block.opacity);
  const transform = block.rotationDeg
    ? `transform:rotate(${block.rotationDeg}deg);transform-origin:center;`
    : "";
  const writing =
    block.renderDirection === "vertical"
      ? "writing-mode:vertical-rl;text-orientation:upright;"
      : "writing-mode:horizontal-tb;";
  return `<div class="block" data-font-size="${block.fontSize}" data-line-height="${block.lineHeight}" style="left:${block.rect.left}px;top:${block.rect.top}px;width:${block.rect.width}px;height:${block.rect.height}px;background:${bg};color:${block.textColor};${transform}"><span class="text" style="${writing}text-shadow:${buildTextOutlineShadow(block.fontSize)};">${escapeHtml(block.text)}</span></div>`;
}

/** @param {number} fontSize */
function buildTextOutlineShadow(fontSize) {
  const radius =
    Math.round(Math.min(4, Math.max(0.35, fontSize * 0.055)) * 10) / 10;
  const half = Math.round(radius * 0.55 * 10) / 10;
  return [
    [0, -radius],
    [radius, 0],
    [0, radius],
    [-radius, 0],
    [radius, -radius],
    [radius, radius],
    [-radius, radius],
    [-radius, -radius],
    [half, -half],
    [half, half],
    [-half, half],
    [-half, -half],
  ]
    .map(([x, y]) => `${x}px ${y}px 0 rgba(255,255,255,.95)`)
    .join(", ");
}

/** @param {RenderedSmokeItem[]} items @param {string} outputPath @param {"geometryPath" | "overlayPath"} imagePathKey */
async function renderContactSheet(items, outputPath, imagePathKey) {
  const thumbWidth = 320;
  const columns = 5;
  const outputDir = path.dirname(outputPath);
  const htmlPath = path.join(
    outputDir,
    `${path.basename(outputPath, path.extname(outputPath))}.html`,
  );
  const sheetItems = items.map((item) => ({
    ...item,
    imageSrc: path.relative(outputDir, item[imagePathKey]).replace(/\\/g, "/"),
  }));
  await writeFile(
    htmlPath,
    buildContactSheetHtml(sheetItems, thumbWidth, columns),
    "utf8",
  );
  const rows = Math.max(1, Math.ceil(items.length / columns));
  const win = new BrowserWindow({
    width: columns * thumbWidth,
    height: rows * 460,
    show: false,
    webPreferences: { offscreen: true },
  });
  try {
    await win.loadFile(htmlPath);
    await waitForReady(win);
    const image = await win.webContents.capturePage();
    await writeFile(outputPath, image.toPNG());
  } finally {
    win.destroy();
  }
}

/** @param {ContactSheetItem[]} items @param {number} thumbWidth @param {number} columns */
function buildContactSheetHtml(items, thumbWidth, columns) {
  const cells = items
    .map(
      (item) =>
        `<div class="cell"><div class="label">${item.index}. ${escapeHtml(item.sample.filePath)}<br />blocks: ${item.blockCount} / pattern:${item.typeCounts?.pattern ?? 0}</div><img src="${escapeHtml(item.imageSrc)}" /></div>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8" /><style>
body{margin:0;background:#101114;color:#f3efe7;font-family:"Malgun Gothic",sans-serif}.grid{display:grid;grid-template-columns:repeat(${columns},${thumbWidth}px);gap:0}.cell{box-sizing:border-box;width:${thumbWidth}px;height:460px;padding:8px;border:1px solid #2a3038;overflow:hidden}.label{height:42px;font-size:12px;line-height:1.3;color:#d8d2c5;overflow:hidden}img{width:100%;max-height:390px;object-fit:contain;background:#050607}
</style></head><body><div class="grid">${cells}</div><script>window.addEventListener("load",()=>setTimeout(()=>document.body.dataset.ready="1",200));</script></body></html>`;
}

/** @param {import("electron").BrowserWindow} win */
function waitForReady(win) {
  return win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const done = () => resolve(true);
      if (document.body.dataset.ready === "1") done();
      const timer = setInterval(() => {
        if (document.body.dataset.ready === "1") {
          clearInterval(timer);
          done();
        }
      }, 50);
      setTimeout(() => {
        clearInterval(timer);
        done();
      }, 3000);
    })
  `);
}

/** @param {string} filePath */
async function readImageDataUrl(filePath) {
  const buffer = await readFile(filePath);
  return `data:${mimeFromPath(filePath)};base64,${buffer.toString("base64")}`;
}

/** @param {string} filePath */
function mimeFromPath(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}

/** @param {unknown} hex @param {unknown} alpha */
function hexToRgba(hex, alpha) {
  const value = String(hex || "#ffffff").replace("#", "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, Number(alpha) || 0))})`;
}

/** @param {unknown} value */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = { createSmokeRenderer };
