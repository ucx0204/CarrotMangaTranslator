// @ts-check
const { app, BrowserWindow, nativeImage, protocol } = require("electron");
const {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} = require("node:fs");
const { mkdir, writeFile } = require("node:fs/promises");
const { extname, join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const root = resolve(__dirname, "..", "..");
const runRoot = readRequiredEnv("MGT_PIXEL_PARITY_RUN_ROOT");
const artifactDir = readRequiredEnv("MGT_PIXEL_PARITY_ARTIFACT_DIR");
const bundleDir = readRequiredEnv("MGT_PIXEL_PARITY_BUNDLE_DIR");
const resultPath = readRequiredEnv("MGT_PIXEL_PARITY_RESULT_PATH");
const userDataDir = readRequiredEnv("MGT_PIXEL_PARITY_USER_DATA");
const rendererStylesheet = pathToFileURL(
  join(root, "src", "renderer", "src", "styles.css"),
).toString();
const panelRuntime = pathToFileURL(join(bundleDir, "panel.js")).toString();
const panelStyles = pathToFileURL(join(bundleDir, "panel.css")).toString();

if (process.env.MGT_PIXEL_PARITY_HARDWARE !== "1") {
  app.disableHardwareAcceleration();
}
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.setPath("userData", userDataDir);

// 패널과 export 모두 빌트인 폰트를 mgt-font:// 커스텀 스킴으로 로드한다(본
// 앱의 imageProtocol 과 동일). 표준 특권 스킴은 app ready 이전에 등록해야 한다.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "mgt-font",
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

/** @type {Array<PixelParityResult>} */
const caseResults = [];

void app
  .whenReady()
  .then(registerBundledFontProtocol)
  .then(run)
  .then(() => {
    writeResult({
      cases: caseResults,
      ok: caseResults.every((item) => item.mismatchedPixels === 0),
    });
    app.exit(caseResults.every((item) => item.mismatchedPixels === 0) ? 0 : 1);
  })
  .catch((error) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    writeResult({ cases: caseResults, error: message, ok: false });
    app.exit(1);
  });

/**
 * 본 앱의 mgt-font 핸들러(imageProtocol.ts)를 최소 복제해 패널/export 가
 * 동일한 폰트 바이트를 로드하도록 한다. 핸들은 resolveBundledFontFilePath
 * (dev: 소스 자산, 패키짭: out/renderer/assets/fonts)로 파일을 해석해
 * file:// origin에서 교차 출처 fetch되므로 CORS 헤더를 포함해 응답한다.
 */
function registerBundledFontProtocol() {
  const { resolveBundledFontFilePath } = require(
    join(root, "out", "main", "bundledFontResolver.js"),
  );
  protocol.handle("mgt-font", async (request) => {
    const url = new URL(request.url);
    const id = url.hostname || url.pathname.replace(/^\/+/, "");
    const fontPath = resolveBundledFontFilePath(id);
    if (!fontPath) {
      return new Response("Font not found", { status: 404 });
    }
    const contentType =
      extname(fontPath).toLowerCase() === ".otf" ? "font/otf" : "font/ttf";
    return new Response(readFileSync(fontPath), {
      status: 200,
      headers: {
        "content-type": contentType,
        "access-control-allow-origin": "*",
      },
    });
  });
}

async function run() {
  reportStatus("preparing fixture");
  await mkdir(artifactDir, { recursive: true });
  const imageDataUrl = createFixtureImageDataUrl(836, 1200);
  const htmlSource = createTestHtmlSource();
  const { createPageExportRenderSession } = require(
    join(root, "out", "main", "pageExport.js"),
  );
  const session = await createPageExportRenderSession({
    dataRoot: runRoot,
    decodeFallback: async () => null,
    htmlSource,
    resolveImageUrl: () => imageDataUrl,
  });
  try {
    for (const testCase of createCases()) {
      reportStatus(`${testCase.id}: rendering export`);
      const page = createFixturePage(testCase.pageSize);
      const exported = await session.renderPage(page);
      reportStatus(`${testCase.id}: rendering panel`);
      const panel = await capturePanelArtwork({
        imageDataUrl,
        page,
        panelSize: testCase.panelSize,
        testId: testCase.id,
      });
      caseResults.push(await compareAndPersist(testCase.id, panel, exported));
      reportStatus(`${testCase.id}: comparison complete`);
    }
  } finally {
    session.close();
  }
}

function createTestHtmlSource() {
  const { createPageExportHtmlSource } = require(
    join(root, "out", "main", "pageExportHtml.js"),
  );
  return createPageExportHtmlSource({
    assetDirectories: () => [join(root, "out", "page-export")],
    rendererStylesheet: () => rendererStylesheet,
    fonts: {
      list: () => [],
      readPreferences: () => ({
        defaultFontId: "default",
        favoriteIds: [],
        orderedIds: [],
      }),
      resolveFilePath: () => null,
    },
  });
}

function createCases() {
  return [
    {
      id: "matching-native-size",
      pageSize: { width: 836, height: 1200 },
      panelSize: { width: 836, height: 1200 },
    },
    {
      id: "metadata-mismatch-natural-stage",
      pageSize: { width: 1000, height: 1400 },
      panelSize: { width: 836, height: 1200 },
    },
  ];
}

/**
 * @param {{width: number; height: number}} pageSize
 */
function createFixturePage(pageSize) {
  return {
    analysisStatus: "completed",
    blocks: createFixtureBlocks(),
    createdAt: "2026-01-01T00:00:00.000Z",
    dataUrl: "",
    height: pageSize.height,
    id: `pixel-parity-${pageSize.width}x${pageSize.height}`,
    imagePath: "fixture.png",
    name: "fixture.png",
    updatedAt: "2026-01-01T00:00:00.000Z",
    width: pageSize.width,
  };
}

function createFixtureBlocks() {
  return [
    createBlock("rich", {
      bbox: { x: 110.25, y: 75.5, w: 300.5, h: 155.25 },
      bold: true,
      fontWidthScale: 0.86,
      italic: true,
      letterSpacing: 0.08,
      rotationDeg: 13.5,
      translatedText: "**굵게** 그리고 *기울임*",
    }),
    createBlock("vertical", {
      bbox: { x: 650.2, y: 105.4, w: 155.7, h: 350.3 },
      renderDirection: "vertical",
      translatedText: "세로쓰기",
      wordBreak: "keep-all",
    }),
    createBlock("perspective", {
      bbox: { x: 145.1, y: 495.6, w: 600.8, h: 135.2 },
      perspectiveTransform: {
        corners: [
          { x: 0.04, y: 0.1 },
          { x: 0.98, y: 0 },
          { x: 0.91, y: 0.94 },
          { x: 0.02, y: 0.82 },
        ],
        version: 1,
      },
      translatedText: "원근 변환",
    }),
    createBlock("curve", {
      bbox: { x: 115.5, y: 730.25, w: 710.5, h: 190.75 },
      curveLayout: {
        alignment: "center",
        fitSpacing: true,
        offsetEm: 0.15,
        orientation: "tangent",
        path: {
          control: { x: 0.5, y: 0.05 },
          end: { x: 0.95, y: 0.7 },
          start: { x: 0.05, y: 0.7 },
          type: "quadratic",
        },
        version: 1,
      },
      translatedText: "곡선 텍스트",
    }),
    createBlock("empty", {
      bbox: { x: 90, y: 980, w: 240, h: 90 },
      sourceText: "",
      translatedText: "",
    }),
  ];
}

/**
 * @param {string} id
 * @param {Record<string, unknown>} overrides
 */
function createBlock(id, overrides) {
  return {
    autoFitText: true,
    backgroundColor: "#ffffff",
    bbox: { x: 100, y: 100, w: 300, h: 160 },
    confidence: 1,
    fontFamily: "nanum-myeongjo",
    fontSizePx: 34,
    id,
    lineHeight: 1.18,
    opacity: 1,
    outlineColor: "#ffffff",
    outlineWidthScale: 0.04,
    renderDirection: "horizontal",
    sourceDirection: "horizontal",
    sourceText: "",
    textAlign: "center",
    textColor: "#111111",
    translatedText: "텍스트",
    type: "nonsolid",
    ...overrides,
  };
}

/**
 * @param {{
 *   imageDataUrl: string;
 *   page: ReturnType<typeof createFixturePage>;
 *   panelSize: {width: number; height: number};
 *   testId: string;
 * }} input
 */
async function capturePanelArtwork(input) {
  const htmlPath = join(runRoot, `${input.testId}-panel.html`);
  await writeFile(htmlPath, buildPanelHtml(input), "utf8");
  const win = new BrowserWindow({
    backgroundColor: "#ffffff",
    // Deliberately keep the viewport shorter than the fixture so this check
    // cannot pass only because the host display happens to fit the full page.
    height: Math.min(input.panelSize.height + 48, 600),
    show: false,
    useContentSize: true,
    width: input.panelSize.width + 48,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  try {
    await withTimeout(
      win.loadFile(htmlPath),
      15_000,
      "Panel pixel-parity page load timed out.",
    );
    await waitForPanelReady(win);
    const bounds = await withTimeout(
      readPanelBounds(win),
      10_000,
      "Panel artwork bounds timed out.",
    );
    assertPanelBounds(bounds, input.panelSize);
    const debuggerApi = win.webContents.debugger;
    debuggerApi.attach("1.3");
    await withTimeout(
      debuggerApi.sendCommand("Page.enable"),
      10_000,
      "Panel debugger setup timed out.",
    );
    const capture = await withTimeout(
      debuggerApi.sendCommand("Page.captureScreenshot", {
        captureBeyondViewport: true,
        clip: {
          height: bounds.height,
          scale: 1,
          width: bounds.width,
          x: bounds.x,
          y: bounds.y,
        },
        format: "png",
        fromSurface: true,
      }),
      30_000,
      "Panel screenshot capture timed out.",
    );
    if (typeof capture.data !== "string" || !capture.data) {
      throw new Error("Panel capture returned an empty PNG.");
    }
    return Buffer.from(capture.data, "base64");
  } finally {
    if (win.webContents.debugger.isAttached()) {
      win.webContents.debugger.detach();
    }
    win.destroy();
  }
}

/**
 * @param {{
 *   imageDataUrl: string;
 *   page: ReturnType<typeof createFixturePage>;
 *   panelSize: {width: number; height: number};
 * }} input
 */
function buildPanelHtml(input) {
  const documentSize = {
    height: input.panelSize.height + 48,
    width: input.panelSize.width + 48,
  };
  const document = {
    fontLibrary: {
      customFonts: [],
      preferences: {
        defaultFontId: "default",
        favoriteIds: [],
        orderedIds: [],
      },
    },
    imageSrc: input.imageDataUrl,
    page: {
      blocks: input.page.blocks,
      height: input.page.height,
      id: input.page.id,
      name: input.page.name,
      width: input.page.width,
    },
  };
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data: mgt-font: file:; style-src 'unsafe-inline' file:; script-src file:; base-uri 'none';" />
<link rel="stylesheet" href="${escapeHtml(rendererStylesheet)}" />
<link rel="stylesheet" href="${escapeHtml(panelStyles)}" />
<style>
html, body, #root {
  width: ${documentSize.width}px;
  height: ${documentSize.height}px;
  margin: 0;
  overflow: visible;
}
[data-pixel-parity-workspace] {
  overflow: visible;
}
</style>
</head>
<body>
<div id="root"></div>
<script id="pixel-parity-data" type="application/json">${safeJson({
    document,
    panelSize: input.panelSize,
  })}</script>
<script src="${escapeHtml(panelRuntime)}" defer></script>
</body>
</html>`;
}

/** @param {BrowserWindow} win */
async function waitForPanelReady(win) {
  await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const tick = () => {
          if (document.body.dataset.error) {
            reject(new Error(document.body.dataset.error));
            return;
          }
          if (document.body.dataset.ready === "1") {
            resolve(true);
            return;
          }
          if (Date.now() - startedAt > 15000) {
            reject(new Error("Panel renderer readiness timed out."));
            return;
          }
          setTimeout(tick, 40);
        };
        tick();
      })
    `),
    20_000,
    "Panel renderer readiness timed out.",
  );
}

/** @param {BrowserWindow} win */
async function readPanelBounds(win) {
  const value = await win.webContents.executeJavaScript(`
    (() => {
      const stage = document.querySelector(".image-stage");
      if (!stage) return null;
      const rect = stage.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    })()
  `);
  if (
    typeof value !== "object" ||
    value === null ||
    !["x", "y", "width", "height"].every(
      (key) => typeof value[key] === "number" && Number.isFinite(value[key]),
    )
  ) {
    throw new Error("Panel renderer returned invalid artwork bounds.");
  }
  return value;
}

/**
 * @param {{x: number; y: number; width: number; height: number}} actual
 * @param {{width: number; height: number}} expected
 */
function assertPanelBounds(actual, expected) {
  if (actual.width !== expected.width || actual.height !== expected.height) {
    throw new Error(
      `Panel artwork is ${actual.width}x${actual.height}; expected ${expected.width}x${expected.height}.`,
    );
  }
}

/**
 * @param {string} id
 * @param {Buffer} panelPng
 * @param {Buffer} exportPng
 * @returns {Promise<PixelParityResult>}
 */
async function compareAndPersist(id, panelPng, exportPng) {
  const panelPath = join(artifactDir, `${id}-panel.png`);
  const exportPath = join(artifactDir, `${id}-export.png`);
  await Promise.all([
    writeFile(panelPath, panelPng),
    writeFile(exportPath, exportPng),
  ]);
  const panelImage = decodePng(panelPng, `${id} panel`);
  const exportImage = decodePng(exportPng, `${id} export`);
  const panelSize = panelImage.getSize();
  const exportSize = exportImage.getSize();
  if (
    panelSize.width !== exportSize.width ||
    panelSize.height !== exportSize.height
  ) {
    return {
      exportSize,
      id,
      panelSize,
    };
  }
  const comparison = compareBitmaps(
    panelImage.toBitmap({ scaleFactor: 1 }),
    exportImage.toBitmap({ scaleFactor: 1 }),
    panelSize,
  );
  if (comparison.mismatchedPixels > 0) {
    const diff = nativeImage.createFromBitmap(comparison.diff, {
      height: panelSize.height,
      scaleFactor: 1,
      width: panelSize.width,
    });
    await writeFile(join(artifactDir, `${id}-diff.png`), diff.toPNG());
  }
  return {
    exportSize,
    id,
    maxChannelDelta: comparison.maxChannelDelta,
    mismatchBounds: comparison.mismatchBounds,
    mismatchedPixels: comparison.mismatchedPixels,
    panelSize,
  };
}

/**
 * @param {Buffer} panel
 * @param {Buffer} exported
 * @param {{width: number; height: number}} size
 */
function compareBitmaps(panel, exported, size) {
  if (
    panel.length !== exported.length ||
    panel.length !== size.width * size.height * 4
  ) {
    throw new Error("Decoded pixel buffers have unexpected lengths.");
  }
  const diff = Buffer.alloc(panel.length);
  let maxChannelDelta = 0;
  let mismatchedPixels = 0;
  let minX = size.width;
  let minY = size.height;
  let maxX = -1;
  let maxY = -1;
  for (let offset = 0; offset < panel.length; offset += 4) {
    let pixelDiffers = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(
        panel[offset + channel] - exported[offset + channel],
      );
      maxChannelDelta = Math.max(maxChannelDelta, delta);
      pixelDiffers ||= delta !== 0;
    }
    if (!pixelDiffers) continue;
    const pixel = offset / 4;
    const x = pixel % size.width;
    const y = Math.floor(pixel / size.width);
    mismatchedPixels += 1;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    diff[offset] = 255;
    diff[offset + 1] = 0;
    diff[offset + 2] = 255;
    diff[offset + 3] = 255;
  }
  return {
    diff,
    maxChannelDelta,
    mismatchBounds:
      mismatchedPixels > 0 ? { maxX, maxY, minX, minY } : undefined,
    mismatchedPixels,
  };
}

/** @param {Buffer} png @param {string} label */
function decodePng(png, label) {
  const image = nativeImage.createFromBuffer(png);
  if (image.isEmpty()) throw new Error(`${label} PNG could not be decoded.`);
  return image;
}

/**
 * @param {number} width
 * @param {number} height
 */
function createFixtureImageDataUrl(width, height) {
  const bitmap = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      bitmap[offset] = (x * 7 + y * 3) % 256;
      bitmap[offset + 1] = (x * 2 + y * 5) % 256;
      bitmap[offset + 2] = (x + y * 11) % 256;
      bitmap[offset + 3] = 255;
    }
  }
  const image = nativeImage.createFromBitmap(bitmap, {
    height,
    scaleFactor: 1,
    width,
  });
  if (image.isEmpty()) throw new Error("Fixture image creation failed.");
  return `data:image/png;base64,${image.toPNG().toString("base64")}`;
}

/**
 * @template T
 * @param {Promise<T>} operation
 * @param {number} timeoutMs
 * @param {string} message
 */
function withTimeout(operation, timeoutMs, message) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    void operation.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** @param {string} value */
function escapeHtml(value) {
  return value.replace(/[&<>"]/g, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    return "&quot;";
  });
}

/** @param {unknown} value */
function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** @param {string} name */
function readRequiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment value: ${name}`);
  return value;
}

/** @param {string} message */
function reportStatus(message) {
  console.log(`[pixel-parity] ${message}`);
  appendFileSync(
    join(runRoot, "phase.log"),
    `${new Date().toISOString()} ${message}\n`,
    "utf8",
  );
}

/** @param {{ok: boolean; cases: PixelParityResult[]; error?: string}} result */
function writeResult(result) {
  mkdirSync(resolve(resultPath, ".."), { recursive: true });
  writeFileSync(resultPath, JSON.stringify(result, null, 2), "utf8");
}

/**
 * @typedef {{
 *   id: string;
 *   panelSize: {width: number; height: number};
 *   exportSize: {width: number; height: number};
 *   mismatchedPixels?: number;
 *   maxChannelDelta?: number;
 *   mismatchBounds?: {minX: number; minY: number; maxX: number; maxY: number};
 * }} PixelParityResult
 */
