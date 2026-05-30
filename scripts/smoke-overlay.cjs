const { app, BrowserWindow, nativeImage } = require("electron");
const { copyFile, mkdir, readFile, readdir, writeFile } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DEFAULT_MANGA_ROOT = "C:\\Users\\sam40\\AppData\\Local\\Tachidesk\\downloads\\mangas";
const SAMPLE_COUNT = readIntEnv("MANGA_SMOKE_COUNT", 30);
const MANGA_ROOT = process.env.MANGA_SMOKE_MANGA_ROOT || DEFAULT_MANGA_ROOT;
const TARGET_IMAGE_PATH = process.env.MANGA_SMOKE_IMAGE_PATH || "";
const SMOKE_PROVIDER = normalizeSmokeProvider(process.env.MANGA_SMOKE_PROVIDER);
const SAMPLE_OFFSET = readIntEnv("MANGA_SMOKE_SAMPLE_OFFSET", 0);
const MAX_CAPTURE_LONG_SIDE = readIntEnv("MANGA_SMOKE_MAX_LONG_SIDE", 1400);
const PAGE_TIMEOUT_MS = readIntEnv("MANGA_SMOKE_PAGE_TIMEOUT_MS", 120000);
let sharedGeometry = null;

async function main() {
  app.setPath("userData", path.join(ROOT, ".tmp", "smoke-overlay", "electron-user-data"));
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
  app.commandLine.appendSwitch("disk-cache-size", "0");
  app.on("window-all-closed", (event) => {
    event.preventDefault();
  });
  await app.whenReady();

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(ROOT, ".tmp", "smoke-overlay", timestamp);
  const pagesDir = path.join(outDir, "pages");
  await mkdir(pagesDir, { recursive: true });

  const { getAppPaths } = require("../out/main/appPaths.js");
  const { normalizeAppSettings, buildBaseTranslationOptions } = require("../out/main/appSettings.js");
  const { startOpenAIOAuthEndpoint, stopOpenAIOAuthEndpoint } = require("../out/main/openaiOauthEndpoint.js");
  const { applyOcrCandidateGeometryLocks, overlayItemToBlock, normalizeOverlayItemBboxes } = require("../out/main/wholePagePipeline.js");
  sharedGeometry = require("../out/shared/geometry.js");
  const simplePage = require("../out/app-runtime/simple-page-translate.cjs");
  const overlayTools = require("../out/app-runtime/overlay-parser.cjs");

  const paths = getAppPaths();
  const settings = normalizeAppSettings(await readJsonIfExists(paths.settingsPath));
  const configuredBaseOptions = buildBaseTranslationOptions({
    jobId: "smoke-overlay",
    runDir: path.join(outDir, "runs"),
    paths,
    settings
  });
  const baseOptions = {
    ...configuredBaseOptions,
    ...(SMOKE_PROVIDER ? { modelProvider: SMOKE_PROVIDER } : {}),
    serverLogPath: path.join(outDir, "server.log"),
    label: "smoke-overlay"
  };

  const samples = await selectSmokeSamples(MANGA_ROOT, SAMPLE_COUNT * 4);
  await writeFile(path.join(outDir, "samples.json"), `${JSON.stringify(samples, null, 2)}\n`, "utf8");
  await writeFile(path.join(outDir, "settings-summary.json"), `${JSON.stringify({
    modelProvider: baseOptions.modelProvider,
    gemmaVramMode: baseOptions.gemmaVramMode,
    modelRepo: baseOptions.modelRepo,
    modelFile: baseOptions.modelFile,
    mmprojRepo: baseOptions.mmprojRepo,
    mmprojFile: baseOptions.mmprojFile,
    codexModel: baseOptions.codexModel,
    codexReasoningEffort: baseOptions.codexReasoningEffort
  }, null, 2)}\n`, "utf8");

  const server = baseOptions.modelProvider === "openai-codex"
    ? await startOpenAIOAuthEndpoint(baseOptions)
    : await simplePage.startServer(baseOptions);
  const rendered = [];
  const skipped = [];
  try {
    for (const [candidateIndex, sample] of samples.entries()) {
      if (rendered.length >= SAMPLE_COUNT) {
        break;
      }
      const index = rendered.length;
      const pageOutDir = path.join(pagesDir, String(index + 1).padStart(2, "0"));
      await mkdir(pageOutDir, { recursive: true });
      try {
        const page = createPageRecord(sample.filePath, index);
        const abortController = new AbortController();
        const pageOptions = {
          ...baseOptions,
          imagePath: page.imagePath,
          imageWidth: page.width,
          imageHeight: page.height,
          outputDir: path.join(pageOutDir, "analysis"),
          label: `smoke-${index + 1}`,
          abortSignal: abortController.signal
        };

        console.log(`[smoke] ${index + 1}/${SAMPLE_COUNT} candidate=${candidateIndex + 1}/${samples.length} ${sample.filePath}`);
        const result = await withTimeout(
          simplePage.requestTranslation(server, pageOptions),
          PAGE_TIMEOUT_MS,
          `page timed out after ${PAGE_TIMEOUT_MS}ms`,
          abortController
        );
        await simplePage.saveArtifacts(pageOptions, result);
        const parsed = overlayTools.parseJsonLenient(result.outputText);
        const items = overlayTools.normalizeItems(parsed);
        if (items.length === 0) {
          throw new Error("No overlay items parsed.");
        }
        const normalizedItems = applyOcrCandidateGeometryLocks(
          normalizeOverlayItemBboxes(items, page, getBboxNormalizationOptions(result.requestBody)),
          page,
          Array.isArray(result.requestBody?.ocrBboxHints) ? result.requestBody.ocrBboxHints : []
        );
        const blocks = normalizedItems.map((item, itemIndex) => overlayItemToBlock(item, page, itemIndex));
        const typeCounts = countBlockTypes(blocks);
        const analyzedPage = {
          ...page,
          blocks,
          analysisStatus: "completed",
          updatedAt: new Date().toISOString()
        };

        const pageJsonPath = path.join(pageOutDir, "page.json");
        const geometryPath = path.join(pageOutDir, "geometry.png");
        const overlayPath = path.join(pageOutDir, "overlay.png");
        await copyFile(sample.filePath, path.join(pageOutDir, `original${path.extname(sample.filePath).toLowerCase()}`));
        await writeFile(pageJsonPath, `${JSON.stringify({ sample, items: normalizedItems, page: analyzedPage }, null, 2)}\n`, "utf8");
        await renderGeometryPng(analyzedPage, analyzedPage.blocks, geometryPath);
        await renderOverlayPng(analyzedPage, overlayPath);
        rendered.push({ index: index + 1, sample, geometryPath, overlayPath, blockCount: blocks.length, typeCounts });
      } catch (error) {
        const failure = {
          sample,
          message: error instanceof Error ? error.message : String(error),
          status: error?.status,
          statusText: error?.statusText,
          rawTextPreview: error?.rawTextPreview,
          requestSummary: error?.requestSummary
        };
        skipped.push(failure);
        await writeFile(path.join(pageOutDir, "skip.json"), `${JSON.stringify(failure, null, 2)}\n`, "utf8");
        console.warn(`[smoke] skip ${sample.filePath}: ${failure.message}`);
      }
    }
  } finally {
    if (baseOptions.modelProvider === "openai-codex") {
      await stopOpenAIOAuthEndpoint(server);
    } else {
      await simplePage.stopServer(server);
    }
  }

  await writeFile(path.join(outDir, "skipped.json"), `${JSON.stringify(skipped, null, 2)}\n`, "utf8");
  const shouldWriteSheets = SAMPLE_COUNT > 1 || rendered.length > 1;
  const geometrySheetPath = shouldWriteSheets ? path.join(outDir, "geometry-sheet.png") : "";
  const overlaySheetPath = shouldWriteSheets ? path.join(outDir, "overlay-sheet.png") : "";
  if (shouldWriteSheets) {
    await renderContactSheet(rendered, geometrySheetPath, "geometryPath");
    await renderContactSheet(rendered, overlaySheetPath, "overlayPath");
  }
  await writeReport(outDir, rendered, skipped, geometrySheetPath, overlaySheetPath, baseOptions);
  console.log(`[smoke] wrote ${outDir}`);
  app.quit();
}

function countBlockTypes(blocks) {
  return blocks.reduce(
    (counts, block) => {
      if (block.type === "solid") {
        counts.solid += 1;
      } else if (block.type === "nonsolid") {
        counts.nonsolid += 1;
      } else {
        counts.other += 1;
      }
      return counts;
    },
    { solid: 0, nonsolid: 0, other: 0 }
  );
}

function getBboxNormalizationOptions(requestBody) {
  if (!requestBody || typeof requestBody !== "object" || requestBody.bboxCoordinateSpace !== "pixels") {
    return {};
  }

  return {
    coordinateSpace: "pixels",
    pixelWidth: Number(requestBody.bboxCoordinateFrame?.width),
    pixelHeight: Number(requestBody.bboxCoordinateFrame?.height)
  };
}

function createPageRecord(imagePath, index) {
  const image = nativeImage.createFromPath(imagePath);
  const size = image.getSize();
  if (!size.width || !size.height) {
    throw new Error(`Failed to read image dimensions: ${imagePath}`);
  }
  const now = new Date().toISOString();
  return {
    id: `smoke-page-${index + 1}`,
    name: path.basename(imagePath),
    imagePath,
    dataUrl: "",
    width: size.width,
    height: size.height,
    blocks: [],
    analysisStatus: "idle",
    createdAt: now,
    updatedAt: now
  };
}

async function selectSmokeSamples(root, count) {
  if (TARGET_IMAGE_PATH) {
    return [{
      filePath: TARGET_IMAGE_PATH,
      groupKey: resolveGroupKey(root, TARGET_IMAGE_PATH),
      hash: stableHash(TARGET_IMAGE_PATH)
    }];
  }

  const files = await collectImageFiles(root);
  const sorted = rotateItems(files
    .map((filePath) => ({ filePath, groupKey: resolveGroupKey(root, filePath), hash: stableHash(filePath) }))
    .sort((a, b) => a.hash - b.hash || a.filePath.localeCompare(b.filePath)), SAMPLE_OFFSET);
  const selected = [];
  const usedGroups = new Set();

  for (const sample of sorted) {
    if (selected.length >= count) {
      break;
    }
    if (usedGroups.has(sample.groupKey)) {
      continue;
    }
    selected.push(sample);
    usedGroups.add(sample.groupKey);
  }

  for (const sample of sorted) {
    if (selected.length >= count) {
      break;
    }
    if (!selected.some((current) => current.filePath === sample.filePath)) {
      selected.push(sample);
    }
  }

  return selected.slice(0, count);
}

function rotateItems(items, offset) {
  if (items.length === 0) {
    return items;
  }
  const normalizedOffset = ((offset % items.length) + items.length) % items.length;
  return [...items.slice(normalizedOffset), ...items.slice(0, normalizedOffset)];
}

async function collectImageFiles(root) {
  const result = [];
  const stack = [root];
  const extensions = new Set([".jpg", ".jpeg", ".png"]);
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase()) && isOriginalMangaPageCandidate(root, fullPath)) {
        result.push(fullPath);
      }
    }
  }
  return result;
}

function isOriginalMangaPageCandidate(root, filePath) {
  const relativeParts = path.relative(root, filePath).split(path.sep).map((part) => part.toLowerCase());
  const fileName = path.basename(filePath).toLowerCase();
  const blockedSegments = new Set([
    "mask",
    "masks",
    "inpaint",
    "inpainted",
    "translated",
    "translated_images",
    "translation",
    "translations",
    "output",
    "outputs",
    "result",
    "results"
  ]);
  if (relativeParts.some((part) => blockedSegments.has(part))) {
    return false;
  }
  return !/(^|[_\-. ])translated([_\-. ]|$)|(^|[_\-. ])mask([_\-. ]|$)|(^|[_\-. ])inpaint/i.test(fileName);
}

function resolveGroupKey(root, filePath) {
  const relative = path.relative(root, filePath).split(path.sep);
  return relative.slice(0, Math.min(3, relative.length - 1)).join("/");
}

function stableHash(value) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

async function renderOverlayPng(page, outputPath) {
  const scale = Math.min(1, MAX_CAPTURE_LONG_SIDE / Math.max(page.width, page.height));
  const width = Math.max(1, Math.round(page.width * scale));
  const height = Math.max(1, Math.round(page.height * scale));
  const imageDataUrl = await readImageDataUrl(page.imagePath);
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    webPreferences: {
      offscreen: true
    }
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildOverlayHtml(page, scale, imageDataUrl))}`);
    await waitForReady(win);
    const image = await win.webContents.capturePage();
    await writeFile(outputPath, image.toPNG());
  } finally {
    win.destroy();
  }
}

async function renderGeometryPng(page, items, outputPath) {
  const scale = Math.min(1, MAX_CAPTURE_LONG_SIDE / Math.max(page.width, page.height));
  const width = Math.max(1, Math.round(page.width * scale));
  const height = Math.max(1, Math.round(page.height * scale));
  const imageDataUrl = await readImageDataUrl(page.imagePath);
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    webPreferences: {
      offscreen: true
    }
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildGeometryHtml(page, items, scale, imageDataUrl))}`);
    await waitForReady(win);
    const image = await win.webContents.capturePage();
    await writeFile(outputPath, image.toPNG());
  } finally {
    win.destroy();
  }
}

function buildGeometryHtml(page, items, scale, imageDataUrl) {
  const rows = items.map((item, index) => {
    const left = (item.bbox.x / 1000) * page.width * scale;
    const top = (item.bbox.y / 1000) * page.height * scale;
    const width = (item.bbox.w / 1000) * page.width * scale;
    const height = (item.bbox.h / 1000) * page.height * scale;
    const color = item.type === "nonsolid" ? "#f59e0b" : "#22c55e";
    const direction = item.direction || item.sourceDirection || "horizontal";
    const angle = item.angle ?? item.rotationDeg ?? 0;
    const fontSize = item.fontSize ?? item.fontSizePx ?? "?";
    const label = `${index + 1} ${item.type || "dialogue"} ${direction} ${angle}deg ${fontSize}px`;
    return `<div class="bbox" style="left:${left}px;top:${top}px;width:${width}px;height:${height}px;border-color:${color};color:${color};"><span>${escapeHtml(label)}</span></div>`;
  });

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #111; }
.stage { position: relative; width: ${Math.round(page.width * scale)}px; height: ${Math.round(page.height * scale)}px; }
.page { position: absolute; inset: 0; width: 100%; height: 100%; }
.bbox {
  position: absolute;
  box-sizing: border-box;
  border: 3px solid;
  background: rgba(255, 255, 255, 0.12);
}
.bbox span {
  position: absolute;
  left: 0;
  top: -22px;
  padding: 2px 5px;
  background: rgba(0, 0, 0, 0.78);
  font: 700 13px "Malgun Gothic", sans-serif;
  white-space: nowrap;
}
</style>
</head>
<body>
<div class="stage">
  <img class="page" src="${escapeHtml(imageDataUrl)}" />
  ${rows.join("\n")}
</div>
<script>window.addEventListener("load", () => setTimeout(() => document.body.dataset.ready = "1", 120));</script>
</body>
</html>`;
}

function buildOverlayHtml(page, scale, imageDataUrl) {
  const blocks = page.blocks.map((block) => {
    const text = block.translatedText || block.sourceText || "...";
    const box = sharedGeometry?.resolveEffectiveRenderBbox
      ? sharedGeometry.resolveEffectiveRenderBbox(block, { width: page.width, height: page.height }, text)
      : block.renderBbox || block.bbox;
    return {
      ...block,
      rect: {
        left: (box.x / 1000) * page.width * scale,
        top: (box.y / 1000) * page.height * scale,
        width: (box.w / 1000) * page.width * scale,
        height: (box.h / 1000) * page.height * scale
      },
      fontSize: Math.max(10, Math.round(block.fontSizePx * scale)),
      text
    };
  });

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #111; }
.stage { position: relative; width: ${Math.round(page.width * scale)}px; height: ${Math.round(page.height * scale)}px; }
.page { position: absolute; inset: 0; width: 100%; height: 100%; }
.block {
  position: absolute;
  display: grid;
  place-items: center;
  box-sizing: border-box;
  overflow: hidden;
  padding: 0;
  border: 1px solid rgba(50, 50, 50, 0.32);
  border-radius: 4px;
  font-family: "Malgun Gothic", "Apple SD Gothic Neo", sans-serif;
  font-weight: 600;
  white-space: pre-wrap;
  text-align: center;
}
.text {
  max-width: 100%;
  max-height: 100%;
  overflow-wrap: anywhere;
  word-break: break-word;
}
</style>
</head>
<body>
<div class="stage">
  <img class="page" src="${escapeHtml(imageDataUrl)}" />
  ${blocks.map((block) => renderBlockHtml(block)).join("\n")}
</div>
<script>
const MIN_FONT_SIZE = 10;
function fitBlocks() {
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
}
window.addEventListener("load", () => {
  fitBlocks();
  setTimeout(() => document.body.dataset.ready = "1", 120);
});
</script>
</body>
</html>`;
}

function renderBlockHtml(block) {
  const bg = hexToRgba(block.backgroundColor, block.opacity);
  const color = block.textColor;
  const transform = block.rotationDeg ? `transform: rotate(${block.rotationDeg}deg); transform-origin: center center;` : "";
  const writing = block.renderDirection === "vertical"
    ? "writing-mode: vertical-rl; text-orientation: upright;"
    : "writing-mode: horizontal-tb;";
  const shadow = `text-shadow: ${buildTextOutlineShadow(block.fontSize)};`;
  return `<div class="block" data-font-size="${block.fontSize}" data-line-height="${block.lineHeight}" style="left:${block.rect.left}px;top:${block.rect.top}px;width:${block.rect.width}px;height:${block.rect.height}px;background:${bg};color:${color};${transform}"><span class="text" style="${writing}${shadow}">${escapeHtml(block.text)}</span></div>`;
}

function buildTextOutlineShadow(fontSize) {
  const radius = Math.round(Math.min(4, Math.max(0.35, fontSize * 0.055)) * 10) / 10;
  const halfRadius = Math.round(radius * 0.55 * 10) / 10;
  const color = "rgba(255,255,255,0.95)";
  return [
    [0, -radius],
    [radius, 0],
    [0, radius],
    [-radius, 0],
    [radius, -radius],
    [radius, radius],
    [-radius, radius],
    [-radius, -radius],
    [halfRadius, -halfRadius],
    [halfRadius, halfRadius],
    [-halfRadius, halfRadius],
    [-halfRadius, -halfRadius]
  ].map(([x, y]) => `${x}px ${y}px 0 ${color}`).join(", ");
}

async function renderContactSheet(items, outputPath, imagePathKey) {
  const thumbWidth = 320;
  const cols = 5;
  const rows = Math.max(1, Math.ceil(items.length / cols));
  const width = cols * thumbWidth;
  const height = rows * 460;
  const outputDir = path.dirname(outputPath);
  const htmlPath = path.join(outputDir, `${path.basename(outputPath, path.extname(outputPath))}.html`);
  const sheetItems = items.map((item) => ({
    ...item,
    imageSrc: path.relative(outputDir, item[imagePathKey]).replace(/\\/g, "/")
  }));
  await writeFile(htmlPath, buildContactSheetHtml(sheetItems, thumbWidth, cols), "utf8");
  const win = new BrowserWindow({ width, height, show: false, webPreferences: { offscreen: true } });
  try {
    await win.loadFile(htmlPath);
    await waitForReady(win);
    const image = await win.webContents.capturePage();
    await writeFile(outputPath, image.toPNG());
  } finally {
    win.destroy();
  }
}

function buildContactSheetHtml(items, thumbWidth, cols) {
  return `<!doctype html><html><head><meta charset="utf-8" /><style>
body { margin: 0; background: #101114; color: #f3efe7; font-family: "Malgun Gothic", sans-serif; }
.grid { display: grid; grid-template-columns: repeat(${cols}, ${thumbWidth}px); gap: 0; }
.cell { box-sizing: border-box; width: ${thumbWidth}px; height: 460px; padding: 8px; border: 1px solid #2a3038; overflow: hidden; }
.label { height: 42px; font-size: 12px; line-height: 1.3; color: #d8d2c5; overflow: hidden; }
img { width: 100%; max-height: 390px; object-fit: contain; background: #050607; }
</style></head><body><div class="grid">
${items.map((item) => `<div class="cell"><div class="label">${item.index}. ${escapeHtml(item.sample.filePath)}<br />blocks: ${item.blockCount} / solid:${item.typeCounts?.solid ?? 0} nonsolid:${item.typeCounts?.nonsolid ?? 0}</div><img src="${escapeHtml(item.imageSrc)}" /></div>`).join("")}
</div><script>window.addEventListener("load", () => setTimeout(() => document.body.dataset.ready = "1", 200));</script></body></html>`;
}

async function writeReport(outDir, rendered, skipped, geometrySheetPath, overlaySheetPath, baseOptions) {
  const totalTypeCounts = rendered.reduce(
    (counts, item) => {
      counts.solid += item.typeCounts?.solid ?? 0;
      counts.nonsolid += item.typeCounts?.nonsolid ?? 0;
      counts.other += item.typeCounts?.other ?? 0;
      return counts;
    },
    { solid: 0, nonsolid: 0, other: 0 }
  );
  const lines = [
    "# Overlay Smoke Test",
    "",
    `- Generated: ${new Date().toISOString()}`,
    `- Provider: ${baseOptions.modelProvider}`,
    `- Samples: ${rendered.length}`,
    `- Skipped candidates: ${skipped.length}`,
    `- Type counts: solid ${totalTypeCounts.solid}, nonsolid ${totalTypeCounts.nonsolid}, other ${totalTypeCounts.other}`,
    ...(geometrySheetPath ? [`- Geometry sheet: ${geometrySheetPath}`] : []),
    ...(overlaySheetPath ? [`- Overlay sheet: ${overlaySheetPath}`] : []),
    "- Source filter: original jpg/jpeg/png pages only; translated_images, mask, inpainted, translated outputs are excluded.",
    "",
    "## Manual QA checklist",
    "",
    "- Geometry PNG: bbox tightly covers the original Japanese glyph ink.",
    "- Overlay PNG: Korean overlay stays near the source position and preserves source scale where possible.",
    "- No bottom clipping in overlay PNG.",
    "- Neighboring speech bubbles stay separate.",
    "- Non-dialogue slanted text keeps a useful angle.",
    "",
    "## Samples",
    "",
    ...rendered.flatMap((item) => [
      `- ${item.index}. blocks=${item.blockCount} solid=${item.typeCounts?.solid ?? 0} nonsolid=${item.typeCounts?.nonsolid ?? 0} ${item.sample.filePath}`,
      `  - geometry: ${item.geometryPath}`,
      `  - overlay: ${item.overlayPath}`
    ])
  ];
  await writeFile(path.join(outDir, "report.md"), `${lines.join("\n")}\n`, "utf8");
}

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

function withTimeout(promise, timeoutMs, message, abortController) {
  let timer;
  return Promise.race([
    promise.finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        abortController?.abort();
        reject(new Error(message));
      }, timeoutMs);
    })
  ]);
}

async function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) {
    return undefined;
  }
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readImageDataUrl(filePath) {
  const buffer = await readFile(filePath);
  return `data:${mimeFromPath(filePath)};base64,${buffer.toString("base64")}`;
}

function mimeFromPath(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lower.endsWith(".webp")) {
    return "image/webp";
  }
  return "image/png";
}

function hexToRgba(hex, alpha) {
  const value = String(hex || "#ffffff").replace("#", "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, Number(alpha) || 0))})`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function readIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function normalizeSmokeProvider(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "gemma" || text === "openai-codex") {
    return text;
  }
  if (text === "codex" || text === "openai") {
    return "openai-codex";
  }
  return "";
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
