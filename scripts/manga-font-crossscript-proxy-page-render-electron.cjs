// @ts-check
"use strict";

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const qaDir = path.resolve(readRequiredEnv("MGT_FONT_PROXY_PAGE_QA_DIR"));
const userDataDir = path.resolve(
  readRequiredEnv("MGT_FONT_PROXY_PAGE_QA_USER_DATA"),
);
const resultPath = path.join(qaDir, "production-render-report.json");

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
app.commandLine.appendSwitch("disk-cache-size", "0");
app.setPath("userData", userDataDir);

const imageProtocol = require(
  path.join(root, "out", "main", "imageProtocol.js"),
);
imageProtocol.registerImageProtocolScheme();
app.on("window-all-closed", () => {});

void app
  .whenReady()
  .then(async () => {
    imageProtocol.registerImageProtocolHandler();
    await run();
    app.exit(0);
  })
  .catch(async (error) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    try {
      await writeJson(resultPath, { ok: false, error: message });
    } catch (_writeError) {
      // error-policy-allow: preserve the original render failure if its diagnostic write also fails.
    }
    console.error(message);
    app.exit(1);
  });

/** @returns {Promise<void>} */
async function run() {
  const report = await readJson(path.join(qaDir, "report.json"));
  if (
    report.schema_version !== "manga-font-crossscript-proxy-page-qa-v2" ||
    !Array.isArray(report.pages) ||
    report.pages.length < 1 ||
    report.pages.length > 10
  ) {
    throw new Error("Cross-script page QA report contract drifted.");
  }
  const { createPageExportRenderSession } = require(
    path.join(root, "out", "main", "pageExport.js"),
  );
  const session = await createPageExportRenderSession({
    dataRoot: qaDir,
    decodeFallback: async () => null,
    resolveImageUrl: (/** @type {string} */ imagePath) =>
      fileDataUrl(imagePath),
  });
  const pages = [];
  try {
    for (const pageEntry of report.pages) {
      const pageNumber = Number(pageEntry.page_number);
      const baselinePage = await readJson(
        path.join(qaDir, String(pageEntry.baseline_render_input)),
      );
      const proxyPage = await readJson(
        path.join(qaDir, String(pageEntry.proxy_render_input)),
      );
      const baselinePng = await session.renderPage(baselinePage);
      const proxyPng = await session.renderPage(proxyPage);
      const originalPath = findOriginalPagePath(baselinePage, pageNumber);
      const baselineName = `page-${pad2(pageNumber)}-r33-production.png`;
      const frozenBaselineName = `page-${pad2(pageNumber)}-r33-frozen.png`;
      const proxyName = `page-${pad2(pageNumber)}-proxy-production.png`;
      const panelName = `page-${pad2(pageNumber)}-production-ab.png`;
      await fsp.writeFile(path.join(qaDir, baselineName), baselinePng);
      await fsp.writeFile(path.join(qaDir, proxyName), proxyPng);
      const expectedBaseline = fs.readFileSync(
        path.resolve(String(pageEntry.expected_baseline_rendered_path)),
      );
      await fsp.writeFile(
        path.join(qaDir, frozenBaselineName),
        expectedBaseline,
      );
      const baselineComparison = comparePngPixels(
        expectedBaseline,
        baselinePng,
      );
      const panelPng = await renderPanel({
        originalPath,
        baselinePath: path.join(qaDir, frozenBaselineName),
        proxyPath: path.join(qaDir, proxyName),
        pageNumber,
      });
      await fsp.writeFile(path.join(qaDir, panelName), panelPng);
      pages.push({
        page_number: pageNumber,
        baseline_render: baselineName,
        frozen_baseline_render: frozenBaselineName,
        proxy_render: proxyName,
        original_page: originalPath,
        panel: panelName,
        baseline_reconstruction_vs_frozen_r33: baselineComparison,
      });
      console.log(
        `[font-proxy-render] page ${pageNumber}: reconstructed R33 mismatch ` +
          `${baselineComparison.mismatched_pixels}/${baselineComparison.total_pixels}`,
      );
    }
  } finally {
    session.close();
  }
  await writeJson(resultPath, {
    ok: true,
    renderer: "production createPageExportRenderSession",
    panel_columns: [
      "original Japanese page",
      "frozen R33 production render",
      "production render with proxy ordinary-font overrides",
    ],
    pages,
  });
}

/**
 * @param {{originalPath:string, baselinePath:string, proxyPath:string, pageNumber:number}} options
 * @returns {Promise<Buffer>}
 */
async function renderPanel({
  originalPath,
  baselinePath,
  proxyPath,
  pageNumber,
}) {
  const nativeImage = require("electron").nativeImage;
  const originalImage = nativeImage.createFromPath(originalPath);
  const baselineImage = nativeImage.createFromPath(baselinePath);
  const proxyImage = nativeImage.createFromPath(proxyPath);
  const originalSize = originalImage.getSize();
  const baselineSize = baselineImage.getSize();
  const proxySize = proxyImage.getSize();
  if (
    originalSize.width !== baselineSize.width ||
    originalSize.height !== baselineSize.height ||
    baselineSize.width !== proxySize.width ||
    baselineSize.height !== proxySize.height ||
    originalSize.width <= 0 ||
    originalSize.height <= 0
  ) {
    throw new Error(`Page ${pageNumber} original/A/B raster size drifted.`);
  }
  const header = 64;
  const gap = 12;
  // BrowserWindow is clamped to the monitor work area on Windows.  Keeping
  // the panel below that limit prevents the third column from being silently
  // cropped on 3840px displays and still leaves enough detail for A/B review.
  const maximumPanelWidth = 3000;
  const scale = Math.min(
    1,
    (maximumPanelWidth - gap * 2) / (originalSize.width * 3),
    (4096 - header) / originalSize.height,
  );
  const columnWidth = Math.floor(originalSize.width * scale);
  const pageHeight = Math.floor(originalSize.height * scale);
  const width = columnWidth * 3 + gap * 2;
  const height = pageHeight + header;
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    useContentSize: true,
    backgroundColor: "#ececec",
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  const htmlPath = path.join(qaDir, `page-${pad2(pageNumber)}-panel.html`);
  try {
    const originalUrl = pathToFileURL(originalPath).toString();
    const baselineUrl = pathToFileURL(baselinePath).toString();
    const proxyUrl = pathToFileURL(proxyPath).toString();
    const html = `<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box}html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#ececec}
      .labels{height:${header}px;display:grid;grid-template-columns:repeat(3,${columnWidth}px);gap:${gap}px;align-items:center;font:700 22px/1.2 system-ui,sans-serif;color:#111}
      .label{padding-left:14px;white-space:nowrap}.pages{display:flex;gap:${gap}px}.pages img{display:block;width:${columnWidth}px;height:${pageHeight}px;object-fit:contain}
    </style><div class="labels"><div class="label">원본 · 일본어</div><div class="label">A · 기존 R33</div><div class="label">B · 신형 의미-차단 생성/검색</div></div>
    <div class="pages"><img src="${originalUrl}"><img src="${baselineUrl}"><img src="${proxyUrl}"></div>`;
    await fsp.writeFile(htmlPath, html, "utf8");
    await win.loadURL(pathToFileURL(htmlPath).toString());
    await win.webContents.executeJavaScript(
      "Promise.all([...document.images].map(i => i.decode())).then(() => document.fonts.ready).then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))",
      true,
    );
    return (await win.webContents.capturePage()).toPNG();
  } finally {
    win.destroy();
    await fsp.rm(htmlPath, { force: true });
  }
}

/**
 * @param {Record<string, unknown>} page
 * @param {number} pageNumber
 * @returns {string}
 */
function findOriginalPagePath(page, pageNumber) {
  const cleanedPath = path.resolve(String(page.imagePath ?? ""));
  const sourceRoot = path.dirname(path.dirname(cleanedPath));
  const pagesDir = path.join(sourceRoot, "pages");
  const candidates = fs
    .readdirSync(pagesDir, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && /\.(?:png|jpe?g|webp)$/i.test(entry.name),
    )
    .map((entry) => path.join(pagesDir, entry.name));
  if (candidates.length !== 1) {
    throw new Error(
      `Page ${pageNumber} expected exactly one original page image, found ${candidates.length}.`,
    );
  }
  return candidates[0];
}

/**
 * @param {Buffer} expected
 * @param {Buffer} actual
 */
function comparePngPixels(expected, actual) {
  const nativeImage = require("electron").nativeImage;
  const expectedImage = nativeImage.createFromBuffer(expected);
  const actualImage = nativeImage.createFromBuffer(actual);
  const expectedSize = expectedImage.getSize();
  const actualSize = actualImage.getSize();
  if (
    expectedSize.width !== actualSize.width ||
    expectedSize.height !== actualSize.height
  ) {
    return {
      same_size: false,
      expected_size: expectedSize,
      actual_size: actualSize,
      mismatched_pixels: null,
      total_pixels: null,
    };
  }
  const expectedBitmap = expectedImage.toBitmap();
  const actualBitmap = actualImage.toBitmap();
  let mismatchedPixels = 0;
  let maximumChannelDelta = 0;
  for (let offset = 0; offset < expectedBitmap.length; offset += 4) {
    let pixelMismatch = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(
        expectedBitmap[offset + channel] - actualBitmap[offset + channel],
      );
      if (delta > 0) pixelMismatch = true;
      maximumChannelDelta = Math.max(maximumChannelDelta, delta);
    }
    if (pixelMismatch) mismatchedPixels += 1;
  }
  return {
    same_size: true,
    mismatched_pixels: mismatchedPixels,
    total_pixels: expectedSize.width * expectedSize.height,
    mismatch_ratio:
      mismatchedPixels / (expectedSize.width * expectedSize.height),
    maximum_channel_delta: maximumChannelDelta,
  };
}

/** @param {string} filePath */
function fileDataUrl(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const mime =
    extension === ".jpg" || extension === ".jpeg"
      ? "image/jpeg"
      : extension === ".webp"
        ? "image/webp"
        : "image/png";
  return `data:${mime};base64,${fs.readFileSync(filePath).toString("base64")}`;
}

/**
 * @param {string} filePath
 * @returns {Promise<any>}
 */
async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

/**
 * @param {string} filePath
 * @param {unknown} value
 */
async function writeJson(filePath, value) {
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** @param {string} name */
function readRequiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

/** @param {string | number} value */
function pad2(value) {
  return String(value).padStart(2, "0");
}
