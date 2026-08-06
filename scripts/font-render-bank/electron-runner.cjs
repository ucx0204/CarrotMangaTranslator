// @ts-check
const { app, BrowserWindow, nativeImage } = require("electron");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { mkdir, writeFile } = require("node:fs/promises");
const { createServer } = require("node:http");
const { dirname, isAbsolute, join, relative, resolve } = require("node:path");

const root = readRequiredEnv("MGT_FONT_BANK_ROOT");
const inputPath = readRequiredEnv("MGT_FONT_BANK_INPUT");
const resultPath = readRequiredEnv("MGT_FONT_BANK_RESULT");
const outputDirectory = readRequiredEnv("MGT_FONT_BANK_OUTPUT");
const userDataDirectory = readRequiredEnv("MGT_FONT_BANK_USER_DATA");
const rendererSourceRoot = join(root, "src", "renderer", "src");
const productionStylesheetPath = join(
  rendererSourceRoot,
  "styles",
  "fonts.css",
);
const fontAssetRoot = join(rendererSourceRoot, "assets", "fonts");

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("disable-lcd-text");
app.setPath("userData", userDataDirectory);

/** @type {string | null} */
let activeRenderId = null;

/** @typedef {{width: number; height: number}} Size */
/**
 * @typedef {{
 *   render_id: string;
 *   browser_family_alias: string;
 *   production_css_family: string;
 *   font_weight: number;
 *   font_style: string;
 *   text: string;
 *   writing_mode: string;
 *   font_size_px: number;
 *   letter_spacing_px: number;
 *   canvas: Size;
 *   image_file: string;
 * }} RenderJob
 */
/**
 * @typedef {{
 *   schema_version: string;
 *   render_spec: Record<string, unknown>;
 *   jobs: RenderJob[];
 * }} RunnerInput
 */

void app
  .whenReady()
  .then(run)
  .then((result) => {
    writeResult({ ...result, ok: true });
    app.exit(0);
  })
  .catch((error) => {
    writeResult({
      active_render_id: activeRenderId,
      error: formatError(error),
      ok: false,
      renders: [],
    });
    app.exit(1);
  });

async function run() {
  const input = readInput();
  assertDirectoryInside(outputDirectory, dirname(outputDirectory));
  await mkdir(outputDirectory, { recursive: true });
  const assetServer = await startAssetServer(buildHtml());
  const win = createWindow();
  try {
    await withTimeout(
      win.loadURL(`${assetServer.origin}/render-bank.html`),
      20_000,
      "Font render-bank page load timed out.",
    );
    await waitForPageReady(win);
    /** @type {Array<Record<string, unknown>>} */
    const renders = [];
    for (let index = 0; index < input.jobs.length; index += 1) {
      const job = input.jobs[index];
      if (!job) throw new Error(`Missing render job ${index}.`);
      activeRenderId = job.render_id;
      if (index % 25 === 0 || index === input.jobs.length - 1) {
        console.log(
          `[font-render-bank] ${index + 1}/${input.jobs.length} ${job.render_id}`,
        );
      }
      renders.push(
        await renderOne(win, job, Number(input.render_spec.padding_px)),
      );
    }
    return {
      renderer: {
        engine: "electron-chromium",
        electron_version: process.versions.electron,
        chrome_version: process.versions.chrome,
        device_scale_factor: 1,
        hardware_acceleration: false,
        production_stylesheet_loaded: `${assetServer.origin}/styles/fonts.css`,
      },
      renders,
    };
  } finally {
    win.destroy();
    await assetServer.close();
  }
}

/** @param {unknown} error */
function formatError(error) {
  if (error instanceof Error) return error.stack ?? error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const value = /** @type {Record<string, unknown>} */ (error);
    const fields = ["name", "message", "stack", "code"].flatMap((key) =>
      value[key] === undefined ? [] : [`${key}=${String(value[key])}`],
    );
    if (fields.length > 0) return fields.join("; ");
  }
  try {
    return JSON.stringify(error);
  } catch (serializationError) {
    return `${String(error)}; serialization failed: ${
      serializationError instanceof Error
        ? serializationError.message
        : String(serializationError)
    }`;
  }
}

function readInput() {
  const value = /** @type {RunnerInput} */ (
    JSON.parse(readFileSync(inputPath, "utf8"))
  );
  if (!value || !Array.isArray(value.jobs)) {
    throw new Error("Font render-bank input is invalid.");
  }
  return value;
}

function createWindow() {
  return new BrowserWindow({
    backgroundColor: "#ffffff",
    height: 448,
    show: false,
    useContentSize: true,
    width: 448,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
      sandbox: true,
      webSecurity: true,
    },
  });
}

function buildHtml() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src 'self'; style-src 'unsafe-inline' 'self'; script-src 'unsafe-inline'; base-uri 'none';" />
<link id="production-font-css" rel="stylesheet" href="/styles/fonts.css" />
<style>
html, body { margin: 0; overflow: hidden; background: #ffffff; }
#stage {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: #ffffff;
  color: #111111;
}
#target {
  box-sizing: border-box;
  display: block;
  max-width: calc(100% - 48px);
  max-height: calc(100% - 48px);
  padding: 0;
  margin: 0;
  color: #111111;
  background: transparent;
  white-space: nowrap;
  overflow: visible;
  word-break: keep-all;
  overflow-wrap: normal;
  text-align: center;
  font-synthesis: weight style;
  font-kerning: normal;
  text-rendering: geometricPrecision;
}
</style>
</head>
<body><div id="stage"><span id="target"></span></div>
<script>
const stage = document.getElementById("stage");
const target = document.getElementById("target");

window.renderFontBankJob = async (job) => {
  stage.style.width = job.canvas.width + "px";
  stage.style.height = job.canvas.height + "px";
  target.textContent = job.text;
  target.style.fontFamily = job.production_css_family;
  target.style.fontWeight = String(job.font_weight);
  target.style.fontStyle = job.font_style;
  target.style.fontSize = job.font_size_px + "px";
  target.style.letterSpacing = job.letter_spacing_px + "px";
  target.style.lineHeight = "1.15";
  target.style.writingMode = job.writing_mode === "vertical" ? "vertical-rl" : "horizontal-tb";
  target.style.textOrientation = job.writing_mode === "vertical" ? "upright" : "mixed";

  const descriptor = job.font_style + " " + job.font_weight + " " + job.font_size_px + "px " + JSON.stringify(job.production_css_family);
  const loaded = await document.fonts.load(descriptor, job.text);
  await document.fonts.ready;
  const checkPassed = document.fonts.check(descriptor, job.text);
  const normalizedFamily = job.production_css_family.toLowerCase();
  const matchingFaces = [...document.fonts].filter((face) =>
    face.family.replace(/["']/g, "").toLowerCase() === normalizedFamily &&
    face.status === "loaded",
  );
  const metricDelta = compareWithFallback(job);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const computed = getComputedStyle(target);
  const rect = stage.getBoundingClientRect();
  const contentFits =
    target.scrollWidth <= job.canvas.width - 48 &&
    target.scrollHeight <= job.canvas.height - 48;
  return {
    bounds: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
    fonts_ready: document.fonts.status === "loaded",
    requested_face_loaded_count: loaded.length,
    matching_face_count: matchingFaces.length,
    matching_face_statuses: matchingFaces.map((face) => face.status),
    font_check_passed: checkPassed,
    production_font_check_passed: checkPassed,
    fallback_metric_max_delta: metricDelta,
    content_fits: contentFits,
    content_size: {
      scroll_width: target.scrollWidth,
      scroll_height: target.scrollHeight,
      client_width: target.clientWidth,
      client_height: target.clientHeight,
    },
    computed_font_family: computed.fontFamily,
    computed_font_weight: computed.fontWeight,
    computed_font_style: computed.fontStyle,
  };
};

function compareWithFallback(job) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const samples = [job.text, "가나다라마바사 0123", "한글 Font ABC xyz"];
  const metrics = (family) => samples.flatMap((sample) => {
    context.font = job.font_style + " " + job.font_weight + " " + job.font_size_px + "px " + family;
    const value = context.measureText(sample);
    return [value.width, value.actualBoundingBoxLeft, value.actualBoundingBoxRight, value.actualBoundingBoxAscent, value.actualBoundingBoxDescent];
  });
  const actual = metrics(JSON.stringify(job.production_css_family));
  const fallback = metrics("sans-serif");
  return Math.max(...actual.map((value, index) => Math.abs(value - fallback[index])));
}

Promise.all([
  new Promise((resolve, reject) => {
    const sheet = document.getElementById("production-font-css");
    sheet.addEventListener("load", resolve, {once: true});
    sheet.addEventListener("error", () => reject(new Error("Production fonts.css failed to load.")), {once: true});
  }),
  document.fonts.ready,
]).then(() => { document.body.dataset.ready = "1"; }).catch((error) => {
  document.body.dataset.error = error instanceof Error ? error.message : String(error);
});
</script>
</body>
</html>`;
}

/** @param {string} html */
async function startAssetServer(html) {
  const server = createServer((request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname === "/render-bank.html") {
        writeHttpResponse(
          response,
          200,
          "text/html; charset=utf-8",
          Buffer.from(html),
        );
        return;
      }
      if (pathname === "/styles/fonts.css") {
        // fonts.css는 빌트인 폰트를 mgt-font:///<rel> 커스텀 스킴으로 참조한다(#53).
        // 이 HTTP 하니스는 mgt-font: 프로토콜을 등록하지 않으므로, 서빙 시 접두어를
        // ../assets/fonts/<rel> 로 치환해 자산 서버 라우트로 되돌린다(source-contract.cjs
        // 와 동일 변환).
        writeHttpResponse(
          response,
          200,
          "text/css; charset=utf-8",
          rewriteBundledFontCssForHttp(readFileSync(productionStylesheetPath)),
        );
        return;
      }
      if (pathname.startsWith("/assets/fonts/")) {
        const relativeAsset = decodeURIComponent(
          pathname.slice("/assets/fonts/".length),
        );
        const assetPath = resolve(fontAssetRoot, relativeAsset);
        assertDirectoryInside(assetPath, fontAssetRoot);
        writeHttpResponse(
          response,
          200,
          resolveFontMimeType(assetPath),
          readFileSync(assetPath),
        );
        return;
      }
      writeHttpResponse(
        response,
        404,
        "text/plain; charset=utf-8",
        Buffer.from("Not found"),
      );
    } catch (error) {
      writeHttpResponse(
        response,
        500,
        "text/plain; charset=utf-8",
        Buffer.from(error instanceof Error ? error.message : String(error)),
      );
    }
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Font render-bank HTTP server has no TCP address.");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolvePromise, reject) => {
        server.closeAllConnections();
        server.close((error) =>
          error ? reject(error) : resolvePromise(undefined),
        );
      }),
  };
}

/** @param {import("node:http").ServerResponse} response @param {number} status @param {string} contentType @param {Buffer} bytes */
function writeHttpResponse(response, status, contentType, bytes) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": String(bytes.length),
    "Content-Type": contentType,
  });
  response.end(bytes);
}

/** @param {string} path */
function resolveFontMimeType(path) {
  if (path.toLowerCase().endsWith(".otf")) return "font/otf";
  return "font/ttf";
}

/**
 * 프로덕션 fonts.css 의 mgt-font:///<rel> 참조를 HTTP 자산 라우트로 치환한다.
 * CSS 는 /styles/fonts.css 로 서빙되므로 ../assets/fonts/<rel> 은 /assets/fonts/<rel>
 * 로 해석되어 startAssetServer 의 자산 브랜치로 라우팅된다(#53).
 * @param {Buffer} cssBytes
 */
function rewriteBundledFontCssForHttp(cssBytes) {
  return Buffer.from(
    cssBytes.toString("utf8").replace(/mgt-font:\/\/\//g, "../assets/fonts/"),
    "utf8",
  );
}

/** @param {BrowserWindow} win */
async function waitForPageReady(win) {
  await withTimeout(
    win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const tick = () => {
        if (document.body.dataset.error) return reject(new Error(document.body.dataset.error));
        if (document.body.dataset.ready === "1") return resolve(true);
        if (Date.now() - startedAt > 15000) return reject(new Error("Font page readiness timed out."));
        setTimeout(tick, 30);
      };
      tick();
    })`),
    20_000,
    "Font render-bank page readiness timed out.",
  );
}

/** @param {BrowserWindow} win @param {RenderJob} job @param {number} padding */
async function renderOne(win, job, padding) {
  win.setContentSize(job.canvas.width, job.canvas.height);
  const envelope = /** @type {Record<string, any>} */ (
    await withTimeout(
      win.webContents.executeJavaScript(
        `Promise.resolve()
          .then(() => window.renderFontBankJob(${safeJson(job)}))
          .then(
            (value) => ({ok: true, value}),
            (error) => ({
              ok: false,
              error: {
                name: String(error?.name ?? ""),
                message: String(error?.message ?? error),
                stack: String(error?.stack ?? ""),
              },
            }),
          )`,
      ),
      20_000,
      `Font readiness timed out for ${job.render_id}.`,
    )
  );
  if (envelope.ok !== true || !envelope.value) {
    throw new Error(
      `Browser font render failed for ${job.render_id}: ${JSON.stringify(envelope.error)}.`,
    );
  }
  const browserResult = /** @type {Record<string, any>} */ (envelope.value);
  assertBrowserResult(job, browserResult);
  const capture = await captureWithRetry(win, job);
  const png = capture.image.toPNG();
  const pixels = inspectInk(png, job.canvas, padding);
  const imagePath = resolve(outputDirectory, ...job.image_file.split("/"));
  assertDirectoryInside(imagePath, outputDirectory);
  await mkdir(dirname(imagePath), { recursive: true });
  await writeFile(imagePath, png);
  return {
    render_id: job.render_id,
    readiness: {
      document_fonts_ready: browserResult.fonts_ready,
      requested_face_loaded_count: browserResult.requested_face_loaded_count,
      matching_face_count: browserResult.matching_face_count,
      matching_face_statuses: browserResult.matching_face_statuses,
      font_check_passed: browserResult.font_check_passed,
      production_font_check_passed: browserResult.production_font_check_passed,
      content_fits: browserResult.content_fits,
      content_size: browserResult.content_size,
      capture_attempts: capture.attempts,
    },
    fallback_detection: {
      status: "passed",
      metric_max_delta: browserResult.fallback_metric_max_delta,
      method:
        "production-css-font-loading-api+cmap-preflight+canvas-metric-sentinel",
    },
    computed_style: {
      font_family: browserResult.computed_font_family,
      font_weight: browserResult.computed_font_weight,
      font_style: browserResult.computed_font_style,
    },
    pixels,
  };
}

/** @param {BrowserWindow} win @param {RenderJob} job */
async function captureWithRetry(win, job) {
  /** @type {unknown} */
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const image = await withTimeout(
        win.webContents.capturePage({
          x: 0,
          y: 0,
          width: job.canvas.width,
          height: job.canvas.height,
        }),
        20_000,
        `PNG capture timed out for ${job.render_id}.`,
      );
      if (!image.isEmpty()) return { image, attempts: attempt };
      lastError = new Error("Electron returned an empty capture image.");
    } catch (error) {
      lastError = error;
    }
    await win.webContents.executeJavaScript(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
  }
  throw new Error(
    `PNG capture failed after 3 attempts for ${job.render_id}: ${formatError(lastError)}.`,
  );
}

/** @param {RenderJob} job @param {Record<string, any>} value */
function assertBrowserResult(job, value) {
  const productionFamilySeen = String(value.computed_font_family).includes(
    job.production_css_family,
  );
  const allLoaded = Array.isArray(value.matching_face_statuses)
    ? value.matching_face_statuses.every((status) => status === "loaded")
    : false;
  if (
    value.fonts_ready !== true ||
    value.font_check_passed !== true ||
    value.production_font_check_passed !== true ||
    value.requested_face_loaded_count < 1 ||
    value.matching_face_count < 1 ||
    !allLoaded ||
    !productionFamilySeen ||
    value.content_fits !== true ||
    !(value.fallback_metric_max_delta > 0.01)
  ) {
    throw new Error(
      `Font fallback/readiness check failed for ${job.render_id}: ${JSON.stringify(value)}.`,
    );
  }
}

/** @param {Buffer} png @param {Size} expected @param {number} padding */
function inspectInk(png, expected, padding) {
  const image = nativeImage.createFromBuffer(png);
  if (image.isEmpty()) throw new Error("Captured font PNG is empty.");
  const size = image.getSize();
  if (size.width !== expected.width || size.height !== expected.height) {
    throw new Error(
      `Captured font PNG is ${size.width}x${size.height}; expected ${expected.width}x${expected.height}.`,
    );
  }
  const bitmap = image.toBitmap({ scaleFactor: 1 });
  let inkPixels = 0;
  let minX = size.width;
  let minY = size.height;
  let maxX = -1;
  let maxY = -1;
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    if (
      bitmap[offset] >= 245 &&
      bitmap[offset + 1] >= 245 &&
      bitmap[offset + 2] >= 245
    ) {
      continue;
    }
    const pixel = offset / 4;
    const x = pixel % size.width;
    const y = Math.floor(pixel / size.width);
    inkPixels += 1;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (inkPixels < 16) throw new Error("Captured font PNG has no glyph ink.");
  const tolerance = 2;
  if (
    minX < padding - tolerance ||
    minY < padding - tolerance ||
    maxX > size.width - padding + tolerance - 1 ||
    maxY > size.height - padding + tolerance - 1
  ) {
    throw new Error(
      `Captured glyph ink violates the ${padding}px safe padding: ${minX},${minY}-${maxX},${maxY}.`,
    );
  }
  return {
    ink_pixel_count: inkPixels,
    ink_bounds: { min_x: minX, min_y: minY, max_x: maxX, max_y: maxY },
    width: size.width,
    height: size.height,
    qa_overlay: false,
  };
}

/** @template T @param {Promise<T>} operation @param {number} timeoutMs @param {string} message */
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

/** @param {string} targetPath @param {string} parentPath */
function assertDirectoryInside(targetPath, parentPath) {
  const child = relative(resolve(parentPath), resolve(targetPath));
  if (!child || child.startsWith("..") || isAbsolute(child)) {
    throw new Error(
      `Refusing unexpected font render-bank path: ${targetPath}.`,
    );
  }
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
  if (!value) throw new Error(`Missing required environment value: ${name}.`);
  return value;
}

/** @param {Record<string, unknown>} result */
function writeResult(result) {
  mkdirSync(dirname(resultPath), { recursive: true });
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}
