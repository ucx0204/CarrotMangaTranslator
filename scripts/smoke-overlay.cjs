const { app, BrowserWindow, nativeImage } = require("electron");
const {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");

/**
 * @typedef {import("../src/shared/libraryTypes").MangaPage} MangaPage
 * @typedef {import("../src/shared/textTypes").TranslationBlock} TranslationBlock
 * @typedef {{ pattern: number; other: number }} BlockTypeCounts
 * @typedef {{ filePath: string; groupKey: string; hash: number }} SmokeSample
 * @typedef {{ index: number; sample: SmokeSample; geometryPath: string; overlayPath: string; blockCount: number; typeCounts: BlockTypeCounts; elapsedMs: number }} RenderedSmokeItem
 * @typedef {{ sample: SmokeSample; message: string; status?: unknown; statusText?: unknown; rawTextPreview?: unknown; requestSummary?: unknown }} SkippedSmokeItem
 * @typedef {{ modelProvider?: string; gemmaVramMode?: unknown; modelRepo?: unknown; modelFile?: unknown; mmprojRepo?: unknown; mmprojFile?: unknown; ctx?: unknown; batch?: unknown; ubatch?: unknown; kvOffload?: unknown; mmprojOffload?: unknown; fitTargetMb?: unknown; useDraft?: unknown; imageMinTokens?: unknown; imageMaxTokens?: unknown; codexModel?: unknown; codexReasoningEffort?: unknown; ocrBboxHints?: unknown; serverLogPath?: string; label?: string; imagePath?: string; imageWidth?: number; imageHeight?: number; outputDir?: string; abortSignal?: AbortSignal; [key: string]: unknown }} SmokeOptions
 * @typedef {TranslationBlock & { direction?: string; angle?: number; fontSize?: number; sourceDirection?: string; sourceType?: string }} GeometryBlock
 * @typedef {TranslationBlock & { rect: { left: number; top: number; width: number; height: number }; fontSize: number; text: string }} RenderBlock
 * @typedef {RenderedSmokeItem & { imageSrc: string }} ContactSheetItem
 */

const ROOT = path.join(__dirname, "..");
const DEFAULT_MANGA_ROOT =
  "C:\\Users\\sam40\\AppData\\Local\\Tachidesk\\downloads\\mangas";
const SAMPLE_COUNT = readIntEnv("MANGA_SMOKE_COUNT", 30);
const MANGA_ROOT = process.env.MANGA_SMOKE_MANGA_ROOT || DEFAULT_MANGA_ROOT;
const TARGET_IMAGE_PATH = process.env.MANGA_SMOKE_IMAGE_PATH || "";
const TARGET_IMAGE_LIST = process.env.MANGA_SMOKE_IMAGE_LIST || "";
const TARGET_IMAGE_LIST_FILE = process.env.MANGA_SMOKE_IMAGE_LIST_FILE || "";
const SMOKE_PROVIDER = normalizeSmokeProvider(process.env.MANGA_SMOKE_PROVIDER);
const REUSE_OCR_DIR = process.env.MANGA_SMOKE_REUSE_OCR_DIR || "";
const SAMPLE_OFFSET = readIntEnv("MANGA_SMOKE_SAMPLE_OFFSET", 0);
const MAX_CAPTURE_LONG_SIDE = readIntEnv("MANGA_SMOKE_MAX_LONG_SIDE", 1400);
const PAGE_TIMEOUT_MS = readIntEnv("MANGA_SMOKE_PAGE_TIMEOUT_MS", 120000);
/** @type {typeof import("../src/shared/geometry") | null} */
let sharedGeometry = null;

/**
 * @returns {Promise<void>}
 */
async function main() {
  app.setPath(
    "userData",
    path.join(ROOT, ".tmp", "smoke-overlay", "electron-user-data"),
  );
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
  app.commandLine.appendSwitch("disk-cache-size", "0");
  app.on("window-all-closed", () => {});
  await app.whenReady();

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(ROOT, ".tmp", "smoke-overlay", timestamp);
  const pagesDir = path.join(outDir, "pages");
  await mkdir(pagesDir, { recursive: true });

  const { getAppPaths } = /** @type {typeof import("../src/main/appPaths")} */ (
    loadBuiltModule("out/main/appPaths.js")
  );
  const { normalizeAppSettings, buildBaseTranslationOptions } =
    /** @type {typeof import("../src/main/appSettings")} */ (
      loadBuiltModule("out/main/appSettings.js")
    );
  const { startOpenAIOAuthEndpoint, stopOpenAIOAuthEndpoint } =
    /** @type {typeof import("../src/main/openaiOauthEndpoint")} */ (
      loadBuiltModule("out/main/openaiOauthEndpoint.js")
    );
  const {
    applyOcrCandidateGeometryLocks,
    filterRejectedOrUncertainSoundItems,
    getBboxNormalizationOptions: getPipelineBboxNormalizationOptions,
    getOcrBboxHints,
    overlayItemToBlock,
    normalizeOverlayItemBboxes,
  } = /** @type {typeof import("../src/main/pipeline/overlayItems")} */ (
    loadBuiltModule("out/main/pipeline/overlayItems.js")
  );
  sharedGeometry = /** @type {typeof import("../src/shared/geometry")} */ (
    loadBuiltModule("out/shared/geometry.js")
  );
  const simplePage =
    /** @type {typeof import("../src/main/runtime/simple-page-translate.cjs")} */ (
      loadBuiltModule("out/app-runtime/simple-page-translate.cjs")
    );
  const overlayTools =
    /** @type {typeof import("../src/main/runtime/overlay-parser.cjs")} */ (
      loadBuiltModule("out/app-runtime/overlay-parser.cjs")
    );

  const paths = getAppPaths();
  const settings = normalizeAppSettings(
    await readJsonIfExists(paths.settingsPath),
  );
  const configuredBaseOptions = buildBaseTranslationOptions({
    jobId: "smoke-overlay",
    runDir: path.join(outDir, "runs"),
    paths,
    settings,
  });
  const baseOptions = applySmokeOptionOverrides({
    ...configuredBaseOptions,
    ...(SMOKE_PROVIDER ? { modelProvider: SMOKE_PROVIDER } : {}),
    serverLogPath: path.join(outDir, "server.log"),
    label: "smoke-overlay",
  });

  const samples = await selectSmokeSamples(MANGA_ROOT, SAMPLE_COUNT * 4);
  await writeFile(
    path.join(outDir, "samples.json"),
    `${JSON.stringify(samples, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(outDir, "settings-summary.json"),
    `${JSON.stringify(
      {
        modelProvider: baseOptions.modelProvider,
        gemmaVramMode: baseOptions.gemmaVramMode,
        modelRepo: baseOptions.modelRepo,
        modelFile: baseOptions.modelFile,
        mmprojRepo: baseOptions.mmprojRepo,
        mmprojFile: baseOptions.mmprojFile,
        ctx: baseOptions.ctx,
        batch: baseOptions.batch,
        ubatch: baseOptions.ubatch,
        kvOffload: baseOptions.kvOffload,
        mmprojOffload: baseOptions.mmprojOffload,
        fitTargetMb: baseOptions.fitTargetMb,
        useDraft: baseOptions.useDraft,
        imageMinTokens: baseOptions.imageMinTokens,
        imageMaxTokens: baseOptions.imageMaxTokens,
        codexModel: baseOptions.codexModel,
        codexReasoningEffort: baseOptions.codexReasoningEffort,
        reuseOcrDir: REUSE_OCR_DIR || undefined,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const smokeStartedAt = Date.now();
  const server =
    baseOptions.modelProvider === "openai-codex"
      ? await startOpenAIOAuthEndpoint(
          /** @type {Parameters<typeof startOpenAIOAuthEndpoint>[0]} */ (
            baseOptions
          ),
        )
      : await simplePage.startServer(baseOptions);
  /** @type {RenderedSmokeItem[]} */
  const rendered = [];
  /** @type {SkippedSmokeItem[]} */
  const skipped = [];
  try {
    for (const [candidateIndex, sample] of samples.entries()) {
      if (rendered.length >= SAMPLE_COUNT) {
        break;
      }
      const index = rendered.length;
      const pageOutDir = path.join(
        pagesDir,
        String(index + 1).padStart(2, "0"),
      );
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
          ...(REUSE_OCR_DIR
            ? {
                ocrBboxHints: await readReusableOcrHints(
                  REUSE_OCR_DIR,
                  index + 1,
                ),
              }
            : {}),
          abortSignal: abortController.signal,
        };

        console.log(
          `[smoke] ${index + 1}/${SAMPLE_COUNT} candidate=${candidateIndex + 1}/${samples.length} ${sample.filePath}`,
        );
        const pageStartedAt = Date.now();
        const result = await withTimeout(
          simplePage.requestTranslation(server, pageOptions),
          PAGE_TIMEOUT_MS,
          `page timed out after ${PAGE_TIMEOUT_MS}ms`,
          abortController,
        );
        await simplePage.saveArtifacts(pageOptions, result);
        const requestOcrHints = Array.isArray(result.requestBody?.ocrBboxHints)
          ? result.requestBody.ocrBboxHints
          : Array.isArray(pageOptions.ocrBboxHints)
            ? pageOptions.ocrBboxHints
            : [];
        if (requestOcrHints.length > 0) {
          await writeFile(
            path.join(pageOutDir, "ocr-bbox-hints.json"),
            `${JSON.stringify(requestOcrHints, null, 2)}\n`,
            "utf8",
          );
        }
        const parsed = overlayTools.parseJsonLenient(result.outputText);
        const items = overlayTools.normalizeItems(parsed);
        if (items.length === 0) {
          throw new Error("No overlay items parsed.");
        }
        let normalizedItems = applyOcrCandidateGeometryLocks(
          normalizeOverlayItemBboxes(
            items,
            page,
            getPipelineBboxNormalizationOptions(result.requestBody),
          ),
          page,
          getOcrBboxHints(result.requestBody),
        );
        const soundFiltered =
          filterRejectedOrUncertainSoundItems(normalizedItems);
        normalizedItems = soundFiltered.items;
        const blocks = normalizedItems.map((item, itemIndex) =>
          overlayItemToBlock(item, page, itemIndex),
        );
        const typeCounts = countBlockTypes(blocks);
        const analyzedPage = /** @type {MangaPage} */ ({
          ...page,
          blocks,
          analysisStatus: "completed",
          updatedAt: new Date().toISOString(),
        });

        const pageJsonPath = path.join(pageOutDir, "page.json");
        const geometryPath = path.join(pageOutDir, "geometry.png");
        const overlayPath = path.join(pageOutDir, "overlay.png");
        await copyFile(
          sample.filePath,
          path.join(
            pageOutDir,
            `original${path.extname(sample.filePath).toLowerCase()}`,
          ),
        );
        await writeFile(
          pageJsonPath,
          `${JSON.stringify({ sample, items: normalizedItems, page: analyzedPage }, null, 2)}\n`,
          "utf8",
        );
        await renderGeometryPng(
          analyzedPage,
          analyzedPage.blocks,
          geometryPath,
        );
        await renderOverlayPng(analyzedPage, overlayPath);
        rendered.push({
          index: index + 1,
          sample,
          geometryPath,
          overlayPath,
          blockCount: blocks.length,
          typeCounts,
          elapsedMs: Date.now() - pageStartedAt,
        });
      } catch (error) {
        const errorDetail =
          error && typeof error === "object"
            ? /** @type {{ status?: unknown; statusText?: unknown; rawTextPreview?: unknown; requestSummary?: unknown }} */ (
                error
              )
            : {};
        const failure = {
          sample,
          message: error instanceof Error ? error.message : String(error),
          status: errorDetail.status,
          statusText: errorDetail.statusText,
          rawTextPreview: errorDetail.rawTextPreview,
          requestSummary: errorDetail.requestSummary,
        };
        skipped.push(failure);
        await writeFile(
          path.join(pageOutDir, "skip.json"),
          `${JSON.stringify(failure, null, 2)}\n`,
          "utf8",
        );
        console.warn(`[smoke] skip ${sample.filePath}: ${failure.message}`);
      }
    }
  } finally {
    if (baseOptions.modelProvider === "openai-codex") {
      await stopOpenAIOAuthEndpoint(
        /** @type {Awaited<ReturnType<typeof startOpenAIOAuthEndpoint>>} */ (
          server
        ),
      );
    } else {
      await simplePage.stopServer(server);
    }
  }

  await writeFile(
    path.join(outDir, "skipped.json"),
    `${JSON.stringify(skipped, null, 2)}\n`,
    "utf8",
  );
  const shouldWriteSheets = SAMPLE_COUNT > 1 || rendered.length > 1;
  const geometrySheetPath = shouldWriteSheets
    ? path.join(outDir, "geometry-sheet.png")
    : "";
  const overlaySheetPath = shouldWriteSheets
    ? path.join(outDir, "overlay-sheet.png")
    : "";
  if (shouldWriteSheets) {
    await renderContactSheet(rendered, geometrySheetPath, "geometryPath");
    await renderContactSheet(rendered, overlaySheetPath, "overlayPath");
  }
  await writeReport(
    outDir,
    rendered,
    skipped,
    geometrySheetPath,
    overlaySheetPath,
    baseOptions,
    Date.now() - smokeStartedAt,
  );
  console.log(`[smoke] wrote ${outDir}`);
  app.quit();
}

/**
 * @param {string} relativePath
 * @returns {unknown}
 */
function loadBuiltModule(relativePath) {
  return require(path.join(ROOT, relativePath));
}

/**
 * @param {TranslationBlock[]} blocks
 * @returns {BlockTypeCounts}
 */
function countBlockTypes(blocks) {
  return blocks.reduce(
    (counts, block) => {
      if (block.type === "nonsolid") {
        counts.pattern += 1;
      } else {
        counts.other += 1;
      }
      return counts;
    },
    { pattern: 0, other: 0 },
  );
}

/**
 * @param {SmokeOptions} options
 * @returns {SmokeOptions}
 */
function applySmokeOptionOverrides(options) {
  const next = { ...options };
  setStringOption(next, "modelRepo", "MANGA_TRANSLATOR_MODEL_HF");
  setStringOption(next, "modelFile", "LLAMA_ARG_HF_FILE");
  setStringOption(next, "mmprojRepo", "MANGA_TRANSLATOR_MMPROJ_HF");
  setStringOption(next, "mmprojFile", "LLAMA_ARG_MMPROJ_FILE");
  setStringOption(next, "serverPath", "MANGA_TRANSLATOR_LLAMA_SERVER_PATH");
  setNumberOption(next, "ctx", "MANGA_TRANSLATOR_CTX");
  setNumberOption(next, "batch", "MANGA_TRANSLATOR_BATCH");
  setNumberOption(next, "ubatch", "MANGA_TRANSLATOR_UBATCH");
  setNumberOption(next, "imageMinTokens", "MANGA_TRANSLATOR_IMAGE_MIN_TOKENS");
  setNumberOption(next, "imageMaxTokens", "MANGA_TRANSLATOR_IMAGE_MAX_TOKENS");
  setNumberOption(
    next,
    "ctxCheckpoints",
    "MANGA_TRANSLATOR_GEMMA_CTX_CHECKPOINTS",
  );
  setBooleanOption(next, "mmprojOffload", "MANGA_TRANSLATOR_MMPROJ_OFFLOAD");
  const vramMode = String(process.env.MANGA_TRANSLATOR_GEMMA_VRAM_MODE || "")
    .trim()
    .toLowerCase();
  if (["full", "full31b", "31b"].includes(vramMode)) {
    next.gemmaVramMode = "full31b";
  } else if (["economy", "economy26b", "eco", "26b"].includes(vramMode)) {
    next.gemmaVramMode = "economy26b";
  } else if (
    ["minimum", "minimum12b", "minimal", "min", "12b"].includes(vramMode)
  ) {
    next.gemmaVramMode = "minimum12b";
  }
  return next;
}

/**
 * @param {SmokeOptions} target
 * @param {string} key
 * @param {string} envName
 * @returns {void}
 */
function setStringOption(target, key, envName) {
  const value = String(process.env[envName] ?? "").trim();
  if (value) {
    target[key] = value;
  }
}

/**
 * @param {SmokeOptions} target
 * @param {string} key
 * @param {string} envName
 * @returns {void}
 */
function setNumberOption(target, key, envName) {
  const value = Number(process.env[envName]);
  if (Number.isFinite(value) && value > 0) {
    target[key] = Math.round(value);
  }
}

/**
 * @param {SmokeOptions} target
 * @param {string} key
 * @param {string} envName
 * @returns {void}
 */
function setBooleanOption(target, key, envName) {
  const value = String(process.env[envName] ?? "")
    .trim()
    .toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) {
    target[key] = true;
  } else if (["0", "false", "no", "off"].includes(value)) {
    target[key] = false;
  }
}

/**
 * @param {string} rootDir
 * @param {number} pageIndex
 * @returns {Promise<unknown[] | undefined>}
 */
async function readReusableOcrHints(rootDir, pageIndex) {
  const padded = String(pageIndex).padStart(2, "0");
  const candidates = [
    path.join(rootDir, "pages", padded, "ocr-bbox-hints.json"),
    path.join(rootDir, "pages", padded, "ocr", "ocr-bbox-hints.json"),
    path.join(rootDir, "pages", padded, "ocr", "ocr-hints.json"),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      const parsed = JSON.parse(await readFile(candidate, "utf8"));
      const hints = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.hints)
          ? parsed.hints
          : [];
      if (hints.length > 0) {
        return hints;
      }
    } catch (error) {
      console.warn(
        `[smoke] failed to read reusable OCR hints ${candidate}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return undefined;
}

/**
 * @param {string} imagePath
 * @param {number} index
 * @returns {import("../src/shared/libraryTypes").MangaPage}
 */
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
    updatedAt: now,
  };
}

/**
 * @param {string} root
 * @param {number} count
 * @returns {Promise<SmokeSample[]>}
 */
async function selectSmokeSamples(root, count) {
  const targetListText =
    TARGET_IMAGE_LIST ||
    (TARGET_IMAGE_LIST_FILE
      ? await readTextIfExists(TARGET_IMAGE_LIST_FILE)
      : "");
  const targetList = parseTargetImageList(targetListText);
  if (targetList.length > 0) {
    return targetList.map((filePath) => ({
      filePath,
      groupKey: resolveGroupKey(root, filePath),
      hash: stableHash(filePath),
    }));
  }

  if (TARGET_IMAGE_PATH) {
    return [
      {
        filePath: TARGET_IMAGE_PATH,
        groupKey: resolveGroupKey(root, TARGET_IMAGE_PATH),
        hash: stableHash(TARGET_IMAGE_PATH),
      },
    ];
  }

  const files = await collectImageFiles(root);
  const sorted = rotateItems(
    files
      .map((filePath) => ({
        filePath,
        groupKey: resolveGroupKey(root, filePath),
        hash: stableHash(filePath),
      }))
      .sort((a, b) => a.hash - b.hash || a.filePath.localeCompare(b.filePath)),
    SAMPLE_OFFSET,
  );
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

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function parseTargetImageList(value) {
  const text = String(value || "")
    .replace(/^\uFEFF/, "")
    .trim();
  if (!text) {
    return [];
  }

  if (text.startsWith("[") && text.endsWith("]")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed
          .map((entry) => String(entry || "").trim())
          .filter(Boolean);
      }
    } catch (_error) {
      // error-policy-allow: malformed JSON input falls through to the documented list format.
    }
  }

  return text
    .split(/\r?\n|;/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function readTextIfExists(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (_error) {
    return "";
  }
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} offset
 * @returns {T[]}
 */
function rotateItems(items, offset) {
  if (items.length === 0) {
    return items;
  }
  const normalizedOffset =
    ((offset % items.length) + items.length) % items.length;
  return [
    ...items.slice(normalizedOffset),
    ...items.slice(0, normalizedOffset),
  ];
}

/**
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function collectImageFiles(root) {
  /** @type {string[]} */
  const result = [];
  /** @type {string[]} */
  const stack = [root];
  const extensions = new Set([".jpg", ".jpeg", ".png"]);
  while (stack.length) {
    const dir = stack.pop();
    if (!dir) {
      continue;
    }
    /** @type {import("node:fs").Dirent[]} */
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (
        entry.isFile() &&
        extensions.has(path.extname(entry.name).toLowerCase()) &&
        isOriginalMangaPageCandidate(root, fullPath)
      ) {
        result.push(fullPath);
      }
    }
  }
  return result;
}

/**
 * @param {string} root
 * @param {string} filePath
 * @returns {boolean}
 */
function isOriginalMangaPageCandidate(root, filePath) {
  const relativeParts = path
    .relative(root, filePath)
    .split(path.sep)
    .map((part) => part.toLowerCase());
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
    "results",
  ]);
  if (relativeParts.some((part) => blockedSegments.has(part))) {
    return false;
  }
  return !/(^|[_\-. ])translated([_\-. ]|$)|(^|[_\-. ])mask([_\-. ]|$)|(^|[_\-. ])inpaint/i.test(
    fileName,
  );
}

/**
 * @param {string} root
 * @param {string} filePath
 * @returns {string}
 */
function resolveGroupKey(root, filePath) {
  const relative = path.relative(root, filePath).split(path.sep);
  return relative.slice(0, Math.min(3, relative.length - 1)).join("/");
}

/**
 * @param {string} value
 * @returns {number}
 */
function stableHash(value) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * @param {MangaPage} page
 * @param {string} outputPath
 * @returns {Promise<void>}
 */
async function renderOverlayPng(page, outputPath) {
  const scale = Math.min(
    1,
    MAX_CAPTURE_LONG_SIDE / Math.max(page.width, page.height),
  );
  const width = Math.max(1, Math.round(page.width * scale));
  const height = Math.max(1, Math.round(page.height * scale));
  const imageDataUrl = await readImageDataUrl(page.imagePath);
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    webPreferences: {
      offscreen: true,
    },
  });
  try {
    await win.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(buildOverlayHtml(page, scale, imageDataUrl))}`,
    );
    await waitForReady(win);
    const image = await win.webContents.capturePage();
    await writeFile(outputPath, image.toPNG());
  } finally {
    win.destroy();
  }
}

/**
 * @param {MangaPage} page
 * @param {GeometryBlock[]} items
 * @param {string} outputPath
 * @returns {Promise<void>}
 */
async function renderGeometryPng(page, items, outputPath) {
  const scale = Math.min(
    1,
    MAX_CAPTURE_LONG_SIDE / Math.max(page.width, page.height),
  );
  const width = Math.max(1, Math.round(page.width * scale));
  const height = Math.max(1, Math.round(page.height * scale));
  const imageDataUrl = await readImageDataUrl(page.imagePath);
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    webPreferences: {
      offscreen: true,
    },
  });
  try {
    await win.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(buildGeometryHtml(page, items, scale, imageDataUrl))}`,
    );
    await waitForReady(win);
    const image = await win.webContents.capturePage();
    await writeFile(outputPath, image.toPNG());
  } finally {
    win.destroy();
  }
}

/**
 * @param {MangaPage} page
 * @param {GeometryBlock[]} items
 * @param {number} scale
 * @param {string} imageDataUrl
 * @returns {string}
 */
function buildGeometryHtml(page, items, scale, imageDataUrl) {
  const rows = items.map((item, index) => {
    const left = (item.bbox.x / 1000) * page.width * scale;
    const top = (item.bbox.y / 1000) * page.height * scale;
    const width = (item.bbox.w / 1000) * page.width * scale;
    const height = (item.bbox.h / 1000) * page.height * scale;
    const color = "#f59e0b";
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

/**
 * @param {MangaPage} page
 * @param {number} scale
 * @param {string} imageDataUrl
 * @returns {string}
 */
function buildOverlayHtml(page, scale, imageDataUrl) {
  /** @type {RenderBlock[]} */
  const blocks = page.blocks.map((block) => {
    const text = block.translatedText || block.sourceText || "...";
    const box = sharedGeometry?.resolveEffectiveRenderBbox
      ? sharedGeometry.resolveEffectiveRenderBbox(
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

/**
 * @param {RenderBlock} block
 * @returns {string}
 */
function renderBlockHtml(block) {
  const bg = hexToRgba(block.backgroundColor, block.opacity);
  const color = block.textColor;
  const transform = block.rotationDeg
    ? `transform: rotate(${block.rotationDeg}deg); transform-origin: center center;`
    : "";
  const writing =
    block.renderDirection === "vertical"
      ? "writing-mode: vertical-rl; text-orientation: upright;"
      : "writing-mode: horizontal-tb;";
  const shadow = `text-shadow: ${buildTextOutlineShadow(block.fontSize)};`;
  return `<div class="block" data-font-size="${block.fontSize}" data-line-height="${block.lineHeight}" style="left:${block.rect.left}px;top:${block.rect.top}px;width:${block.rect.width}px;height:${block.rect.height}px;background:${bg};color:${color};${transform}"><span class="text" style="${writing}${shadow}">${escapeHtml(block.text)}</span></div>`;
}

/**
 * @param {number} fontSize
 * @returns {string}
 */
function buildTextOutlineShadow(fontSize) {
  const radius =
    Math.round(Math.min(4, Math.max(0.35, fontSize * 0.055)) * 10) / 10;
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
    [-halfRadius, -halfRadius],
  ]
    .map(([x, y]) => `${x}px ${y}px 0 ${color}`)
    .join(", ");
}

/**
 * @param {RenderedSmokeItem[]} items
 * @param {string} outputPath
 * @param {"geometryPath" | "overlayPath"} imagePathKey
 * @returns {Promise<void>}
 */
async function renderContactSheet(items, outputPath, imagePathKey) {
  const thumbWidth = 320;
  const cols = 5;
  const rows = Math.max(1, Math.ceil(items.length / cols));
  const width = cols * thumbWidth;
  const height = rows * 460;
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
    buildContactSheetHtml(sheetItems, thumbWidth, cols),
    "utf8",
  );
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
  }
}

/**
 * @param {ContactSheetItem[]} items
 * @param {number} thumbWidth
 * @param {number} cols
 * @returns {string}
 */
function buildContactSheetHtml(items, thumbWidth, cols) {
  return `<!doctype html><html><head><meta charset="utf-8" /><style>
body { margin: 0; background: #101114; color: #f3efe7; font-family: "Malgun Gothic", sans-serif; }
.grid { display: grid; grid-template-columns: repeat(${cols}, ${thumbWidth}px); gap: 0; }
.cell { box-sizing: border-box; width: ${thumbWidth}px; height: 460px; padding: 8px; border: 1px solid #2a3038; overflow: hidden; }
.label { height: 42px; font-size: 12px; line-height: 1.3; color: #d8d2c5; overflow: hidden; }
img { width: 100%; max-height: 390px; object-fit: contain; background: #050607; }
</style></head><body><div class="grid">
${items.map((item) => `<div class="cell"><div class="label">${item.index}. ${escapeHtml(item.sample.filePath)}<br />blocks: ${item.blockCount} / pattern:${item.typeCounts?.pattern ?? 0}</div><img src="${escapeHtml(item.imageSrc)}" /></div>`).join("")}
</div><script>window.addEventListener("load", () => setTimeout(() => document.body.dataset.ready = "1", 200));</script></body></html>`;
}

/**
 * @param {string} outDir
 * @param {RenderedSmokeItem[]} rendered
 * @param {SkippedSmokeItem[]} skipped
 * @param {string} geometrySheetPath
 * @param {string} overlaySheetPath
 * @param {SmokeOptions} baseOptions
 * @param {number} elapsedMs
 * @returns {Promise<void>}
 */
async function writeReport(
  outDir,
  rendered,
  skipped,
  geometrySheetPath,
  overlaySheetPath,
  baseOptions,
  elapsedMs,
) {
  const totalTypeCounts = rendered.reduce(
    (counts, item) => {
      counts.pattern += item.typeCounts?.pattern ?? 0;
      counts.other += item.typeCounts?.other ?? 0;
      return counts;
    },
    { pattern: 0, other: 0 },
  );
  const lines = [
    "# Overlay Smoke Test",
    "",
    `- Generated: ${new Date().toISOString()}`,
    `- Provider: ${baseOptions.modelProvider}`,
    `- Samples: ${rendered.length}`,
    `- Skipped candidates: ${skipped.length}`,
    `- Elapsed: ${formatDuration(elapsedMs)}`,
    `- Gemma mode: ${baseOptions.gemmaVramMode ?? ""}`,
    `- Model: ${baseOptions.modelRepo ?? ""} / ${baseOptions.modelFile ?? ""}`,
    `- MMProj: ${baseOptions.mmprojRepo ?? ""} / ${baseOptions.mmprojFile ?? ""}`,
    `- Runtime: ctx ${baseOptions.ctx ?? ""}, batch ${baseOptions.batch ?? ""}, ubatch ${baseOptions.ubatch ?? ""}, image tokens ${baseOptions.imageMinTokens ?? ""}-${baseOptions.imageMaxTokens ?? ""}`,
    `- Runtime flags: kvOffload=${String(baseOptions.kvOffload)}, mmprojOffload=${String(baseOptions.mmprojOffload)}, useDraft=${String(baseOptions.useDraft)}, fitTargetMb=${String(baseOptions.fitTargetMb ?? "")}`,
    `- Type counts: pattern ${totalTypeCounts.pattern}, other ${totalTypeCounts.other}`,
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
      `- ${item.index}. blocks=${item.blockCount} pattern=${item.typeCounts?.pattern ?? 0} elapsed=${formatDuration(item.elapsedMs)} ${item.sample.filePath}`,
      `  - geometry: ${item.geometryPath}`,
      `  - overlay: ${item.overlayPath}`,
    ]),
  ];
  await writeFile(
    path.join(outDir, "report.md"),
    `${lines.join("\n")}\n`,
    "utf8",
  );
}

/**
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  const safeMs = Math.max(0, Number(ms) || 0);
  if (safeMs < 1000) {
    return `${Math.round(safeMs)}ms`;
  }
  const seconds = safeMs / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${(seconds - minutes * 60).toFixed(1)}s`;
}

/**
 * @param {import("electron").BrowserWindow} win
 * @returns {Promise<unknown>}
 */
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

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {string} message
 * @param {AbortController} [abortController]
 * @returns {Promise<T>}
 */
function withTimeout(promise, timeoutMs, message, abortController) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
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
    }),
  ]);
}

/**
 * @param {string} filePath
 * @returns {Promise<unknown | undefined>}
 */
async function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) {
    return undefined;
  }
  return JSON.parse(await readFile(filePath, "utf8"));
}

/**
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function readImageDataUrl(filePath) {
  const buffer = await readFile(filePath);
  return `data:${mimeFromPath(filePath)};base64,${buffer.toString("base64")}`;
}

/**
 * @param {string} filePath
 * @returns {string}
 */
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

/**
 * @param {unknown} hex
 * @param {unknown} alpha
 * @returns {string}
 */
function hexToRgba(hex, alpha) {
  const value = String(hex || "#ffffff").replace("#", "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, Number(alpha) || 0))})`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function readIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

/**
 * @param {unknown} value
 * @returns {"" | "gemma" | "openai-codex"}
 */
function normalizeSmokeProvider(value) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
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
