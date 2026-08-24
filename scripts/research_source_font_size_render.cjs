// @ts-check
"use strict";

/**
 * Render source-size A/B/C pages through the production page exporter.
 *
 * A is referenced from the sealed original Japanese page, B is the untouched
 * current auto-fit page, and C is the same inpainted page with only the
 * experimental source-size cap attached to confident blocks.
 */

const { app } = require("electron");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

/** @typedef {{ id?: unknown }} ResearchConfig */
/**
 * @typedef {object} ResearchPageEntry
 * @property {unknown} pageNumber
 * @property {unknown} [workTitle]
 * @property {unknown} [chapterTitle]
 * @property {unknown} [pageName]
 * @property {unknown} [originalImagePath]
 * @property {unknown} [inpaintedImagePath]
 * @property {unknown} baselinePage
 * @property {Record<string, string> | undefined} [candidatePages]
 */
/**
 * @typedef {object} ResearchManifest
 * @property {unknown} schemaVersion
 * @property {unknown} [cohort]
 * @property {ResearchConfig[] | undefined} [configs]
 * @property {ResearchPageEntry[] | undefined} [pages]
 */
/**
 * @typedef {object} RenderPage
 * @property {unknown} [inpaintedImagePath]
 * @property {Record<string, unknown>} [key]
 */

const root = path.resolve(__dirname, "..");
const manifestPath = path.resolve(readRequiredEnv("MGT_SOURCE_SIZE_MANIFEST"));
const outputRoot = path.resolve(
  readRequiredEnv("MGT_SOURCE_SIZE_RENDER_OUTPUT"),
);
const userDataRoot = path.resolve(readRequiredEnv("MGT_SOURCE_SIZE_USER_DATA"));
const selectedConfigIds = new Set(
  String(process.env.MGT_SOURCE_SIZE_CONFIGS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
/** @type {Map<string, string>} */
const imageDataUrls = new Map();

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
app.commandLine.appendSwitch("disk-cache-size", "0");
app.setPath("userData", userDataRoot);

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
      await fsp.mkdir(outputRoot, { recursive: true });
      await fsp.writeFile(
        path.join(outputRoot, "render-report.json"),
        JSON.stringify({ ok: false, error: message }, null, 2) + "\n",
        "utf8",
      );
    } catch (reportError) {
      console.error("Could not persist the source-size render failure report.");
      console.error(reportError);
    }
    console.error(message);
    app.exit(1);
  });

async function run() {
  /** @type {ResearchManifest} */
  const manifest = await readJson(manifestPath);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.pages)) {
    throw new Error("Source-size render manifest contract drifted.");
  }
  const manifestRoot = path.dirname(manifestPath);
  const configIds = (Array.isArray(manifest.configs) ? manifest.configs : [])
    .map((config) => String(config?.id || ""))
    .filter(
      (id) => id && (selectedConfigIds.size === 0 || selectedConfigIds.has(id)),
    );
  if (configIds.length === 0) {
    throw new Error("No source-size configurations were selected.");
  }
  await fsp.mkdir(outputRoot, { recursive: true });
  const { createPageExportRenderSession } = require(
    path.join(root, "out", "main", "pageExport.js"),
  );
  const session = await createPageExportRenderSession({
    dataRoot: outputRoot,
    decodeFallback: async () => null,
    lowPriority: true,
    resolveImageUrl: fileDataUrl,
  });
  /** @type {Array<Record<string, unknown>>} */
  const reportPages = [];
  try {
    for (const pageEntry of manifest.pages) {
      const pageNumber = Number(pageEntry.pageNumber);
      const pageDir = path.join(outputRoot, `page-${pad2(pageNumber)}`);
      await fsp.mkdir(pageDir, { recursive: true });
      const baselinePage = /** @type {RenderPage} */ (
        await readJson(path.join(manifestRoot, String(pageEntry.baselinePage)))
      );
      verifyInpaintedInput(baselinePage, pageNumber);
      const baselineBuffer = await session.renderPage(baselinePage);
      const baselinePath = path.join(pageDir, "B-current-auto-fit.png");
      await atomicWrite(baselinePath, baselineBuffer);
      /** @type {Record<string, string>} */
      const candidates = {};
      for (const configId of configIds) {
        const relativeCandidate = pageEntry.candidatePages?.[configId];
        if (!relativeCandidate) {
          throw new Error(
            `Missing ${configId} candidate for page ${pageNumber}.`,
          );
        }
        const candidatePage = /** @type {RenderPage} */ (
          await readJson(path.join(manifestRoot, relativeCandidate))
        );
        verifyInpaintedInput(candidatePage, pageNumber);
        const candidateBuffer = await session.renderPage(candidatePage);
        const candidateName = `C-${configId}.png`;
        await atomicWrite(path.join(pageDir, candidateName), candidateBuffer);
        candidates[configId] = path.relative(
          outputRoot,
          path.join(pageDir, candidateName),
        );
      }
      reportPages.push({
        pageNumber,
        workTitle: pageEntry.workTitle,
        chapterTitle: pageEntry.chapterTitle,
        pageName: pageEntry.pageName,
        originalImagePath: pageEntry.originalImagePath,
        inpaintedImagePath: pageEntry.inpaintedImagePath,
        baseline: path.relative(outputRoot, baselinePath),
        candidates,
      });
      console.log(
        `[source-size-render] ${pageNumber}/${manifest.pages.length}: ${pageEntry.workTitle}`,
      );
    }
  } finally {
    session.close();
  }
  await atomicWrite(
    path.join(outputRoot, "render-report.json"),
    Buffer.from(
      JSON.stringify(
        {
          ok: true,
          renderer: "production createPageExportRenderSession",
          cohort: manifest.cohort,
          configIds,
          pages: reportPages,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    ),
  );
}

/** @param {RenderPage} page @param {number} pageNumber */
function verifyInpaintedInput(page, pageNumber) {
  const inpainted = String(page.inpaintedImagePath || "");
  if (!inpainted || !fs.existsSync(inpainted)) {
    throw new Error(`Page ${pageNumber} has no completed inpainted image.`);
  }
}

/** @param {string} filePath @returns {string} */
function fileDataUrl(filePath) {
  const cached = imageDataUrls.get(filePath);
  if (cached) return cached;
  const extension = path.extname(filePath).toLowerCase();
  const mime =
    extension === ".jpg" || extension === ".jpeg"
      ? "image/jpeg"
      : extension === ".webp"
        ? "image/webp"
        : "image/png";
  const value = `data:${mime};base64,${fs.readFileSync(filePath).toString("base64")}`;
  imageDataUrls.set(filePath, value);
  return value;
}

/** @param {string} destination @param {string | Buffer} content */
async function atomicWrite(destination, content) {
  const temporary = `${destination}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, content);
  await fsp.rename(temporary, destination);
}

/** @template T @param {string} filePath @returns {Promise<T>} */
async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

/** @param {number} value @returns {string} */
function pad2(value) {
  return String(value).padStart(2, "0");
}

/** @param {string} name @returns {string} */
function readRequiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}
