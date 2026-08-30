#!/usr/bin/env node
/* eslint-disable @typescript-eslint/ban-ts-comment -- local smoke inputs are validated at runtime */
// @ts-nocheck -- local smoke inputs and compiled production modules are runtime-defined.
"use strict";

/** Run a small end-to-end Gemma translation smoke on held-out body pages. */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { app, nativeImage } = require("electron");

const MAIN_ROOT = path.resolve("C:/Users/sam40/Downloads/망가번역기");

function parseArgs(argv) {
  const args = {
    manifest: path.resolve(
      ".tmp/source-font-size-v3/tachidesk/tachidesk-body-samples.json",
    ),
    ocrRoot: path.resolve(".tmp/source-font-size-v3/tachidesk/ocr"),
    output: path.resolve(
      ".tmp/source-font-size-v3/tachidesk/full-smoke/report.json",
    ),
    settings: path.join(MAIN_ROOT, "settings.json"),
    server: path.join(
      MAIN_ROOT,
      "tools",
      "beellama-v0.2.0-cuda12.4",
      "llama-server.exe",
    ),
    limit: 9,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--manifest") args.manifest = path.resolve(argv[++index]);
    else if (value === "--ocr-root") args.ocrRoot = path.resolve(argv[++index]);
    else if (value === "--output") args.output = path.resolve(argv[++index]);
    else if (value === "--settings")
      args.settings = path.resolve(argv[++index]);
    else if (value === "--server") args.server = path.resolve(argv[++index]);
    else if (value === "--limit") args.limit = Number(argv[++index]);
    else if (value === "--help") {
      console.log(
        "Usage: electron scripts/research_source_font_size_v3_tachidesk_full_smoke.cjs " +
          "[--manifest PATH] [--ocr-root PATH] [--output PATH] " +
          "[--settings PATH] [--server PATH] [--limit N]",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}

function normalizeRawItem(item, requestSummary, page) {
  const bbox = item?.bbox ?? {};
  if (requestSummary?.bboxCoordinateSpace !== "pixels") {
    return { ...item, bbox: { ...bbox } };
  }
  const frameWidth =
    Number(requestSummary?.bboxCoordinateFrame?.width) || page.width;
  const frameHeight =
    Number(requestSummary?.bboxCoordinateFrame?.height) || page.height;
  return {
    ...item,
    bbox: {
      x: (Number(bbox.x) / frameWidth) * 1000,
      y: (Number(bbox.y) / frameHeight) * 1000,
      w: (Number(bbox.w) / frameWidth) * 1000,
      h: (Number(bbox.h) / frameHeight) * 1000,
    },
  };
}

function normalizedToPixels(bbox, page) {
  return {
    x: (Number(bbox?.x) / 1000) * page.width,
    y: (Number(bbox?.y) / 1000) * page.height,
    w: (Number(bbox?.w) / 1000) * page.width,
    h: (Number(bbox?.h) / 1000) * page.height,
  };
}

function area(bbox) {
  return Math.max(0, Number(bbox?.w)) * Math.max(0, Number(bbox?.h));
}

function loadRaster(imagePath) {
  const image = nativeImage.createFromPath(imagePath);
  if (image.isEmpty()) throw new Error(`Could not decode ${imagePath}`);
  const size = image.getSize();
  return {
    width: size.width,
    height: size.height,
    bgra: Uint8Array.from(image.toBitmap()),
  };
}

function estimateSummary(estimator, raster, item) {
  const estimate = estimator(raster, item);
  return estimate
    ? {
        facePx: round(estimate.facePx),
        confidence: round(estimate.confidence),
        method: estimate.method,
      }
    : null;
}

function selectMiddleSamplePerWork(samples, limit) {
  const byWork = new Map();
  for (const sample of samples) {
    const key = `${sample.provider}/${sample.work}`;
    const values = byWork.get(key) ?? [];
    values.push(sample);
    byWork.set(key, values);
  }
  return [...byWork.values()]
    .map(
      (values) =>
        values.find((sample) => /-P02$/.test(sample.sampleId)) ?? values[0],
    )
    .slice(0, limit > 0 ? limit : undefined);
}

function summarize(pages) {
  const rows = pages.flatMap((page) => page.items);
  const valid = rows.filter((row) => row.lineGeometryEstimate?.facePx);
  return {
    pages: pages.length,
    blocks: rows.length,
    estimatedBlocks: valid.length,
    lineEvidenceBlocks: rows.filter((row) => row.evidenceLineCount > 0).length,
    recoveredEnvelopeBlocks: rows.filter((row) => row.areaRatio >= 1.15).length,
    atMost12: valid.filter((row) => row.lineGeometryEstimate.facePx <= 12)
      .length,
    atMost14: valid.filter((row) => row.lineGeometryEstimate.facePx <= 14)
      .length,
    lineRaisedAtLeast30Percent: valid.filter(
      (row) =>
        row.unionEstimate?.facePx &&
        row.lineGeometryEstimate.facePx >= row.unionEstimate.facePx * 1.3,
    ).length,
    lineLoweredAtLeast25Percent: valid.filter(
      (row) =>
        row.unionEstimate?.facePx &&
        row.lineGeometryEstimate.facePx <= row.unionEstimate.facePx * 0.75,
    ).length,
  };
}

// eslint-disable-next-line max-lines-per-function -- one page-loop owns server, OCR, translation, and cleanup receipts.
async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.server)) {
    throw new Error(`Gemma server is missing: ${args.server}`);
  }
  process.env.MANGA_TRANSLATOR_OCR_RUNTIME_DIR = path.join(
    MAIN_ROOT,
    "ocr-runtime",
  );
  process.env.MANGA_TRANSLATOR_LLAMA_SERVER_PATH = args.server;
  const manifest = readJson(args.manifest);
  const samples = selectMiddleSamplePerWork(
    Array.isArray(manifest.samples) ? manifest.samples : [],
    args.limit,
  );
  if (samples.length === 0) throw new Error("No full-smoke samples selected.");

  const { getAppPaths } = loadBuiltModule("out/main/appPaths.js");
  const { buildBaseTranslationOptions, normalizeAppSettings } = loadBuiltModule(
    "out/main/appSettings.js",
  );
  const { applyOcrCandidateGeometryLocks } = loadBuiltModule(
    "out/main/pipeline/overlayOcrGeometryLocks.js",
  );
  const { estimateSourceFontSizeForItem } = loadBuiltModule(
    "out/main/pipeline/sourceFontSizeEstimator.js",
  );
  const simplePage = loadBuiltModule(
    "out/app-runtime/simple-page-translate.cjs",
  );
  const overlayTools = loadBuiltModule("out/app-runtime/overlay-parser.cjs");

  const outputDirectory = path.dirname(args.output);
  await fsp.mkdir(outputDirectory, { recursive: true });
  const settings = normalizeAppSettings(readJson(args.settings));
  settings.modelProvider = "gemma";
  const defaultPaths = getAppPaths();
  const paths = {
    ...defaultPaths,
    dataRoot: MAIN_ROOT,
    settingsPath: args.settings,
    libraryDir: path.join(MAIN_ROOT, "library"),
    fontsDir: path.join(MAIN_ROOT, "fonts"),
    toolsDir: path.join(MAIN_ROOT, "tools"),
    ocrRuntimeDir: path.join(MAIN_ROOT, "ocr-runtime"),
    llamaRuntimeDir: path.dirname(args.server),
    llamaServerPath: args.server,
  };
  const baseOptions = {
    ...buildBaseTranslationOptions({
      jobId: "source-font-size-v3-tachidesk-full",
      runDir: path.join(outputDirectory, "runtime"),
      paths,
      settings,
    }),
    port: 18521,
    serverPath: args.server,
    serverLogPath: path.join(outputDirectory, "server.log"),
    reuseServer: false,
    useDraft: false,
    label: "source-font-size-v3-tachidesk-full",
  };
  if (!simplePage.isModelCached(baseOptions)) {
    throw new Error(
      "Configured Gemma model is not cached; refusing a smoke-time download.",
    );
  }

  console.log(`[full-smoke] starting Gemma for ${samples.length} pages`);
  const server = await simplePage.startServer(baseOptions);
  const pages = [];
  try {
    for (const [sampleIndex, sample] of samples.entries()) {
      const pageDirectory = path.join(
        outputDirectory,
        "pages",
        sample.sampleId,
      );
      await fsp.mkdir(pageDirectory, { recursive: true });
      const ocrResult = readJson(
        path.join(args.ocrRoot, sample.sampleId, "ocr-result.json"),
      );
      const hints = Array.isArray(ocrResult.hints) ? ocrResult.hints : [];
      const options = {
        ...baseOptions,
        imagePath: sample.imagePath,
        imageWidth: sample.width,
        imageHeight: sample.height,
        outputDir: pageDirectory,
        ocrBboxResult: ocrResult,
        label: `source-font-size-v3-full-${sample.sampleId}`,
        onProgress: (event) => {
          if (event?.progressText) {
            console.log(
              `[full ${sampleIndex + 1}/${samples.length}] ${sample.sampleId}: ${event.progressText}`,
            );
          }
        },
      };
      const startedAt = Date.now();
      const result = await simplePage.requestTranslation(server, options);
      await simplePage.saveArtifacts(options, result);
      const parsed = overlayTools.parseJsonLenient(result.outputText);
      const rawItems = overlayTools
        .normalizeItems(parsed)
        .map((item) => normalizeRawItem(item, result.requestBody, sample));
      const lockedItems = applyOcrCandidateGeometryLocks(
        rawItems,
        sample,
        hints,
      );
      const raster = loadRaster(sample.analysisRasterPath ?? sample.imagePath);
      const items = lockedItems.map((locked, itemIndex) => {
        const raw =
          rawItems.find(
            (item) =>
              item.id === locked.id &&
              normalizeText(item.sourceText ?? item.jp) ===
                normalizeText(locked.sourceText ?? locked.jp),
          ) ?? rawItems[itemIndex];
        const { sourceFontLineGeometry, ...unionItem } = locked;
        const rawBoxPx = normalizedToPixels(raw?.bbox, sample);
        const lockedBoxPx = normalizedToPixels(locked.bbox, sample);
        return {
          id: locked.id,
          candidateIds: locked.candidateIds ?? [],
          sourceText: locked.sourceText ?? locked.jp,
          translatedText: locked.translatedText ?? locked.ko,
          direction: locked.direction,
          rawBboxPx: rawBoxPx,
          lockedBboxPx: lockedBoxPx,
          areaRatio:
            area(rawBoxPx) > 0
              ? round(area(lockedBoxPx) / area(rawBoxPx))
              : null,
          evidenceLineCount: sourceFontLineGeometry?.lines?.length ?? 0,
          evidenceCandidateIds:
            sourceFontLineGeometry?.lines?.map((line) => line.candidateId) ??
            [],
          rawModelEstimate: raw
            ? estimateSummary(estimateSourceFontSizeForItem, raster, raw)
            : null,
          unionEstimate: estimateSummary(
            estimateSourceFontSizeForItem,
            raster,
            unionItem,
          ),
          lineGeometryEstimate: estimateSummary(
            estimateSourceFontSizeForItem,
            raster,
            locked,
          ),
        };
      });
      pages.push({
        ...sample,
        wallMs: Date.now() - startedAt,
        hintCount: hints.length,
        rawBlockCount: rawItems.length,
        lockedBlockCount: lockedItems.length,
        items,
      });
      console.log(
        `[full ${sampleIndex + 1}/${samples.length}] ${sample.sampleId}: blocks=${items.length}, ${Date.now() - startedAt}ms`,
      );
    }
  } finally {
    await simplePage.stopServer(server);
  }

  const report = {
    schemaVersion: 1,
    manifest: args.manifest,
    serverPath: args.server,
    modelFile: baseOptions.modelFile,
    samples: samples.map((sample) => sample.sampleId),
    summary: summarize(pages),
    pages,
  };
  await fsp.writeFile(
    args.output,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  console.log(JSON.stringify({ output: args.output, ...report.summary }));
}

function loadBuiltModule(relativePath) {
  return require(path.join(__dirname, "..", relativePath));
}

app
  .whenReady()
  .then(run)
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error?.stack || error);
    app.exit(1);
  });
