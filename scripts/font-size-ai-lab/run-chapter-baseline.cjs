#!/usr/bin/env node
/* eslint-disable -- isolated experiment/audit utility, not a production module */
// @ts-nocheck -- isolated experiment/audit utility; production types remain checked.
"use strict";

/**
 * Run the production Text Detector + HayaiOCR path over one sealed chapter,
 * measure the current source-size baseline, and materialize zoomable geometry
 * evidence without changing the Tachidesk source or the user's library.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { app, nativeImage } = require("electron");
const { PNG } = require("pngjs");

function parseArgs(argv) {
  const args = {
    dataRoot: null,
    limit: 0,
    output: null,
    pageEstimator: false,
    selection: null,
    settings: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--selection") args.selection = path.resolve(argv[++index]);
    else if (value === "--output") args.output = path.resolve(argv[++index]);
    else if (value === "--settings")
      args.settings = path.resolve(argv[++index]);
    else if (value === "--data-root")
      args.dataRoot = path.resolve(argv[++index]);
    else if (value === "--limit") args.limit = Number(argv[++index]);
    else if (value === "--page-estimator") args.pageEstimator = true;
    else if (value === "--help") {
      console.log(
        "Usage: electron scripts/font-size-ai-lab/run-chapter-baseline.cjs " +
          "--selection PATH --output DIR --settings PATH --data-root PATH " +
          "[--limit N] [--page-estimator]",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${value}`);
  }
  for (const key of ["selection", "output", "settings", "dataRoot"]) {
    if (!args[key])
      throw new Error(
        `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required.`,
      );
  }
  if (!Number.isInteger(args.limit) || args.limit < 0) {
    throw new Error("--limit must be a non-negative integer.");
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function loadBuilt(relativePath) {
  return require(path.resolve(relativePath));
}

async function loadRaster(imagePath, decodeFallback, fallbackPath) {
  let detectorPath = imagePath;
  let image = nativeImage.createFromPath(imagePath);
  if (image.isEmpty()) {
    const fallbackBuffer = await decodeFallback(imagePath);
    image = fallbackBuffer?.length
      ? nativeImage.createFromBuffer(fallbackBuffer)
      : nativeImage.createEmpty();
    if (image.isEmpty()) {
      throw new Error(`Could not decode image: ${imagePath}`);
    }
    await fsp.mkdir(path.dirname(fallbackPath), { recursive: true });
    await fsp.writeFile(fallbackPath, fallbackBuffer);
    detectorPath = fallbackPath;
  }
  const { width, height } = image.getSize();
  const bgra = Uint8Array.from(image.toBitmap());
  if (bgra.length !== width * height * 4) {
    throw new Error(`Unexpected raster byte length for ${imagePath}.`);
  }
  return { bgra, detectorPath, height, width };
}

function hintBox(hint) {
  const x1 = Number(hint?.x1);
  const y1 = Number(hint?.y1);
  const x2 = Number(hint?.x2);
  const y2 = Number(hint?.y2);
  if (![x1, y1, x2, y2].every(Number.isFinite) || x2 <= x1 || y2 <= y1) {
    return null;
  }
  return { x1, x2, y1, y2 };
}

function normalizedBbox(box, page) {
  return {
    h: ((box.y2 - box.y1) / page.height) * 1_000,
    w: ((box.x2 - box.x1) / page.width) * 1_000,
    x: (box.x1 / page.width) * 1_000,
    y: (box.y1 / page.height) * 1_000,
  };
}

function inferDirection(box) {
  return box.y2 - box.y1 > (box.x2 - box.x1) * 1.25 ? "vertical" : "horizontal";
}

function recognitionSegments(hint, parent) {
  if (
    !Array.isArray(hint?.recognitionSegments) ||
    hint.recognitionSegments.length < 2 ||
    hint.recognitionSegments.length > 8
  ) {
    return [];
  }
  const segments = hint.recognitionSegments.flatMap((segment) => {
    const box = hintBox(segment);
    if (
      !box ||
      box.x1 < parent.x1 - 1 ||
      box.y1 < parent.y1 - 1 ||
      box.x2 > parent.x2 + 1 ||
      box.y2 > parent.y2 + 1
    ) {
      return [];
    }
    return [{ box, sourceText: String(segment.ocrText ?? "").trim() }];
  });
  return segments.length === hint.recognitionSegments.length ? segments : [];
}

function inferHintDirection(box, segments) {
  if (segments.length < 2) return inferDirection(box);
  const vertical = segments.filter(
    (segment) => inferDirection(segment.box) === "vertical",
  ).length;
  if (vertical * 2 === segments.length) return inferDirection(box);
  return vertical * 2 > segments.length ? "vertical" : "horizontal";
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function toPng(raster) {
  const png = new PNG({ height: raster.height, width: raster.width });
  for (let pixel = 0; pixel < raster.width * raster.height; pixel += 1) {
    const offset = pixel * 4;
    png.data[offset] = raster.bgra[offset + 2] ?? 0;
    png.data[offset + 1] = raster.bgra[offset + 1] ?? 0;
    png.data[offset + 2] = raster.bgra[offset] ?? 0;
    png.data[offset + 3] = raster.bgra[offset + 3] ?? 255;
  }
  return png;
}

function drawRectangle(png, box, color, lineWidth = 3) {
  const x1 = clamp(Math.floor(box.x1), 0, png.width - 1);
  const y1 = clamp(Math.floor(box.y1), 0, png.height - 1);
  const x2 = clamp(Math.ceil(box.x2) - 1, 0, png.width - 1);
  const y2 = clamp(Math.ceil(box.y2) - 1, 0, png.height - 1);
  for (let offset = 0; offset < lineWidth; offset += 1) {
    for (let x = x1; x <= x2; x += 1) {
      setPixel(png, x, clamp(y1 + offset, 0, png.height - 1), color);
      setPixel(png, x, clamp(y2 - offset, 0, png.height - 1), color);
    }
    for (let y = y1; y <= y2; y += 1) {
      setPixel(png, clamp(x1 + offset, 0, png.width - 1), y, color);
      setPixel(png, clamp(x2 - offset, 0, png.width - 1), y, color);
    }
  }
}

function setPixel(png, x, y, color) {
  const offset = (y * png.width + x) * 4;
  png.data[offset] = color[0];
  png.data[offset + 1] = color[1];
  png.data[offset + 2] = color[2];
  png.data[offset + 3] = 255;
}

function cropWithBox(raster, box, color = [229, 57, 53]) {
  const padding = Math.max(
    18,
    Math.round(Math.max(box.x2 - box.x1, box.y2 - box.y1) * 0.18),
  );
  const crop = {
    x1: clamp(Math.floor(box.x1) - padding, 0, raster.width),
    y1: clamp(Math.floor(box.y1) - padding, 0, raster.height),
    x2: clamp(Math.ceil(box.x2) + padding, 0, raster.width),
    y2: clamp(Math.ceil(box.y2) + padding, 0, raster.height),
  };
  const width = crop.x2 - crop.x1;
  const height = crop.y2 - crop.y1;
  const output = new PNG({ height, width });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = ((crop.y1 + y) * raster.width + crop.x1 + x) * 4;
      const target = (y * width + x) * 4;
      output.data[target] = raster.bgra[source + 2] ?? 0;
      output.data[target + 1] = raster.bgra[source + 1] ?? 0;
      output.data[target + 2] = raster.bgra[source] ?? 0;
      output.data[target + 3] = raster.bgra[source + 3] ?? 255;
    }
  }
  drawRectangle(
    output,
    {
      x1: box.x1 - crop.x1,
      x2: box.x2 - crop.x1,
      y1: box.y1 - crop.y1,
      y2: box.y2 - crop.y1,
    },
    color,
    Math.max(2, Math.round(Math.min(width, height) / 180)),
  );
  return output;
}

async function writePng(filePath, png) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, PNG.sync.write(png));
}

function pixelEffectBox(region, manifest) {
  if (Array.isArray(region?.bbox) && region.bbox.length === 4) {
    return {
      x1: Number(region.bbox[0]),
      y1: Number(region.bbox[1]),
      x2: Number(region.bbox[2]),
      y2: Number(region.bbox[3]),
    };
  }
  const bbox = region?.bbox ?? {};
  return {
    x1: (Number(bbox.x) / 1_000) * manifest.width,
    y1: (Number(bbox.y) / 1_000) * manifest.height,
    x2: ((Number(bbox.x) + Number(bbox.w)) / 1_000) * manifest.width,
    y2: ((Number(bbox.y) + Number(bbox.h)) / 1_000) * manifest.height,
  };
}

async function run(args) {
  const selection = readJson(args.selection);
  const selectedPages =
    args.limit > 0 ? selection.pages.slice(0, args.limit) : selection.pages;
  if (selectedPages.length === 0) throw new Error("Selection has no pages.");
  await fsp.mkdir(args.output, { recursive: true });

  process.env.MANGA_TRANSLATOR_OCR_RUNTIME_DIR = path.join(
    args.dataRoot,
    "ocr-runtime",
  );
  const { buildBaseTranslationOptions, normalizeAppSettings } = loadBuilt(
    "out/main/appSettings.js",
  );
  const { getAppPaths } = loadBuilt("out/main/appPaths.js");
  const { loadTranslationRuntimePort, disposeTranslationRuntimeResources } =
    loadBuilt("out/main/translationRuntime.js");
  const { decodeImageThroughRuntime } = loadBuilt(
    "out/main/simplePageRuntime.js",
  );
  const { estimatePageSourceFontSizes, estimateSourceFontSizeForItem } =
    loadBuilt("out/main/pipeline/sourceFontSizeEstimator.js");
  const settings = normalizeAppSettings(readJson(args.settings));
  const defaultPaths = getAppPaths();
  const paths = {
    ...defaultPaths,
    dataRoot: args.dataRoot,
    fontsDir: path.join(args.dataRoot, "fonts"),
    libraryDir: path.join(args.dataRoot, "library"),
    ocrRuntimeDir: path.join(args.dataRoot, "ocr-runtime"),
    settingsPath: args.settings,
    toolsDir: path.join(args.dataRoot, "tools"),
  };
  const baseOptions = {
    ...buildBaseTranslationOptions({
      jobId: "font-size-ai-lab-campaign-001-baseline",
      paths,
      runDir: args.output,
      settings,
    }),
    ocrBboxProvider: "hayai-regions",
    ocrPipeline: "hayai",
    workingDir: args.dataRoot,
  };
  if (
    baseOptions.ocrPipeline !== "hayai" ||
    baseOptions.ocrBboxProvider !== "hayai-regions"
  ) {
    throw new Error("Baseline is not configured for Text Detector + HayaiOCR.");
  }

  const decodeImage = (filePath, signal) =>
    decodeImageThroughRuntime(paths.runtimeDir, filePath, signal);
  const pages = [];
  for (const [index, page] of selectedPages.entries()) {
    const pageId = `P${String(index + 1).padStart(3, "0")}`;
    const raster = await loadRaster(
      page.path,
      decodeImage,
      path.join(args.output, "decoded-pages", `${pageId}.png`),
    );
    pages.push({ ...page, ...raster, pageId });
  }
  const runtime = loadTranslationRuntimePort();
  const options = pages.map((page, index) => ({
    ...baseOptions,
    imageHeight: page.height,
    imagePath: page.detectorPath,
    imageWidth: page.width,
    label: `font-size-ai-lab-baseline-${page.pageId}`,
    ocrProgressDefaultToPage: false,
    outputDir: path.join(args.output, "pages", page.pageId, "ocr"),
    onProgress: (event) => {
      if (event?.progressText) {
        console.log(
          `[baseline ${index + 1}/${pages.length}] ${page.pageId}: ${event.progressText}`,
        );
      }
    },
  }));

  console.log(
    `[baseline] detector + HayaiOCR starting for ${pages.length} pages`,
  );
  let ocrResults;
  try {
    ocrResults = await runtime.collectOcrHintsBatch(options);
  } finally {
    await disposeTranslationRuntimeResources(
      "font-size-ai-lab-baseline-finished",
    );
  }

  const pageRecords = [];
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    const result = ocrResults[index] ?? { diagnostics: [], hints: [] };
    const pageDir = path.join(args.output, "pages", page.pageId);
    const ocrDir = path.join(pageDir, "ocr");
    const manifestPath = path.join(ocrDir, "hayai-regions.json");
    const manifest = readJson(manifestPath);
    const hints = Array.isArray(result.hints) ? result.hints : [];
    const overlay = toPng(page);
    for (const hint of hints) {
      const box = hintBox(hint);
      if (box) drawRectangle(overlay, box, [229, 57, 53], 3);
    }
    for (const effect of manifest.effectRegions ?? []) {
      drawRectangle(
        overlay,
        pixelEffectBox(effect, manifest),
        [30, 136, 229],
        3,
      );
    }
    const overlayPath = path.join(pageDir, "bbox-overlay.png");
    await writePng(overlayPath, overlay);

    const preparedCandidates = hints.flatMap((hint, hintIndex) => {
      const box = hintBox(hint);
      if (!box) return [];
      const segments = recognitionSegments(hint, box);
      const direction = inferHintDirection(box, segments);
      const sourceText = String(hint.ocrText ?? hint.text ?? "").trim();
      const hintId = Number(hint.id) || hintIndex + 1;
      const item = {
        angle: 0,
        bbox: normalizedBbox(box, page),
        confidence: Number(hint.score) || 0,
        direction,
        id: hintId,
        jp: sourceText,
        ko: "검증",
        sourceText,
        textRole: "ordinary",
        translatedText: "검증",
        type: "nonsolid",
        ...(segments.length
          ? {
              sourceFontLineGeometry: {
                contractVersion: "source-font-line-geometry-v1",
                source: "ocr-geometry-lock",
                lines: segments.map((segment) => ({
                  candidateId: hintId,
                  bbox: normalizedBbox(segment.box, page),
                  sourceText: segment.sourceText,
                })),
              },
            }
          : {}),
      };
      return [{ box, direction, hint, hintIndex, item, sourceText }];
    });
    const pageEstimates = args.pageEstimator
      ? await estimatePageSourceFontSizes({
          enabled: true,
          items: preparedCandidates.map((candidate) => candidate.item),
          page: { id: page.pageId, width: page.width, height: page.height },
          loadRaster: async () => page,
        })
      : null;
    const candidates = [];
    for (const [candidateIndex, prepared] of preparedCandidates.entries()) {
      const { box, direction, hint, hintIndex, item, sourceText } = prepared;
      const estimate = args.pageEstimator
        ? pageEstimates[candidateIndex]
        : estimateSourceFontSizeForItem(page, item);
      const candidateId = `D${String(hintIndex + 1).padStart(3, "0")}`;
      const cropPath = path.join(pageDir, "bboxes", `${candidateId}.png`);
      await writePng(cropPath, cropWithBox(page, box));
      candidates.push({
        bbox: {
          x1: round(box.x1, 3),
          x2: round(box.x2, 3),
          y1: round(box.y1, 3),
          y2: round(box.y2, 3),
        },
        candidateId,
        cropPath: path.relative(args.output, cropPath).replaceAll("\\", "/"),
        direction,
        estimate: estimate
          ? {
              confidence: round(estimate.confidence),
              facePx: round(estimate.facePx),
              method: estimate.method,
            }
          : null,
        hayaiConfidence: round(Number(hint.score)),
        hintId: Number(hint.id),
        sourceDetectionIds: hint.sourceDetectionIds ?? [],
        sourceText,
      });
    }
    const effectCandidates = [];
    for (const [effectIndex, effect] of (
      manifest.effectRegions ?? []
    ).entries()) {
      const box = pixelEffectBox(effect, manifest);
      const candidateId = String(
        effect.regionId || `FX${String(effectIndex + 1).padStart(3, "0")}`,
      );
      const cropPath = path.join(pageDir, "bboxes", `${candidateId}.png`);
      await writePng(cropPath, cropWithBox(page, box, [30, 136, 229]));
      effectCandidates.push({
        bbox: {
          x1: round(box.x1, 3),
          x2: round(box.x2, 3),
          y1: round(box.y1, 3),
          y2: round(box.y2, 3),
        },
        candidateId,
        cropPath: path.relative(args.output, cropPath).replaceAll("\\", "/"),
        detectorConfidence: round(Number(effect.detectorConfidence)),
        sourceDetectionIds: effect.sourceDetectionIds ?? [],
      });
    }
    const pageRecord = {
      dialogueCount: candidates.length,
      effectCount: manifest.effectRegions?.length ?? 0,
      estimatedCount: candidates.filter((candidate) => candidate.estimate)
        .length,
      height: page.height,
      imagePath: page.path,
      ...(page.detectorPath !== page.path
        ? {
            decoderFallback: "simple-page-runtime-ffmpeg-png",
            ocrImagePath: path
              .relative(args.output, page.detectorPath)
              .replaceAll("\\", "/"),
          }
        : {}),
      name: page.name,
      noTextDetected: Boolean(result.noTextDetected),
      overlayPath: path
        .relative(args.output, overlayPath)
        .replaceAll("\\", "/"),
      pageId: page.pageId,
      sha256: page.sha256,
      width: page.width,
      candidates,
      effectCandidates,
    };
    pageRecords.push(pageRecord);
    await fsp.writeFile(
      path.join(pageDir, "page.json"),
      `${JSON.stringify(pageRecord, null, 2)}\n`,
      "utf8",
    );
    await fsp.writeFile(
      path.join(ocrDir, "ocr-result.json"),
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8",
    );
    console.log(
      `[baseline ${index + 1}/${pages.length}] ${page.pageId}: dialogue=${candidates.length}, estimated=${pageRecord.estimatedCount}, effects=${pageRecord.effectCount}`,
    );
  }

  const allCandidates = pageRecords.flatMap((page) => page.candidates);
  const report = {
    schemaVersion: 1,
    experimentId: path.basename(args.output),
    estimatorMode: args.pageEstimator ? "production-page" : "single-item",
    createdAt: new Date().toISOString(),
    selection: args.selection,
    sourceKey: selection.key,
    ocr: {
      pipeline: baseOptions.ocrPipeline,
      provider: baseOptions.ocrBboxProvider,
      device: baseOptions.ocrDevice,
      gpuBackend: baseOptions.ocrGpuBackend,
      cudaTag: baseOptions.ocrGpuCudaTag,
    },
    summary: {
      abstainedCount: allCandidates.filter((candidate) => !candidate.estimate)
        .length,
      dialogueCount: allCandidates.length,
      effectCount: pageRecords.reduce((sum, page) => sum + page.effectCount, 0),
      estimatedCount: allCandidates.filter((candidate) => candidate.estimate)
        .length,
      pageCount: pageRecords.length,
    },
    pages: pageRecords,
  };
  await fsp.writeFile(
    path.join(args.output, "baseline-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  console.log(JSON.stringify({ output: args.output, ...report.summary }));
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

const startupArgs = parseArgs(process.argv.slice(2));
if (fs.existsSync(startupArgs.output)) {
  throw new Error(`Output already exists: ${startupArgs.output}`);
}
app.setPath("userData", path.join(startupArgs.output, "electron-user-data"));
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
app.commandLine.appendSwitch("disk-cache-size", "0");
app.on("window-all-closed", () => {});
app
  .whenReady()
  .then(() => run(startupArgs))
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error?.stack || error);
    app.exit(1);
  });
