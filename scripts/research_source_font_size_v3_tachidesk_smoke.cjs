#!/usr/bin/env node
/* eslint-disable @typescript-eslint/ban-ts-comment -- local smoke inputs are validated at runtime */
// @ts-nocheck -- local smoke inputs and compiled production modules are runtime-defined.
"use strict";

/**
 * Run production PaddleOCR over held-out Tachidesk body pages, then replay the
 * production OCR geometry lock and source-size estimator over semantic OCR
 * groups.  The old comparison deliberately strips only the new line evidence;
 * both sides therefore use the same source image and merged group envelope.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { app, nativeImage } = require("electron");

function parseArgs(argv) {
  const args = {
    manifest: path.resolve(
      ".tmp/source-font-size-v3/tachidesk/tachidesk-body-samples.json",
    ),
    output: path.resolve(".tmp/source-font-size-v3/tachidesk/ocr-smoke.json"),
    settings: path.resolve("C:/Users/sam40/Downloads/망가번역기/settings.json"),
    ocrRuntime: path.resolve("C:/Users/sam40/Downloads/망가번역기/ocr-runtime"),
    limit: 0,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--manifest") args.manifest = path.resolve(argv[++index]);
    else if (value === "--output") args.output = path.resolve(argv[++index]);
    else if (value === "--settings")
      args.settings = path.resolve(argv[++index]);
    else if (value === "--ocr-runtime")
      args.ocrRuntime = path.resolve(argv[++index]);
    else if (value === "--limit") args.limit = Number(argv[++index]);
    else if (value === "--help") {
      console.log(
        "Usage: electron scripts/research_source_font_size_v3_tachidesk_smoke.cjs " +
          "[--manifest PATH] [--output PATH] [--settings PATH] " +
          "[--ocr-runtime PATH] [--limit N]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

function quantile(values, position) {
  const sorted = values
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const offset = (sorted.length - 1) * position;
  const lower = Math.floor(offset);
  const upper = Math.ceil(offset);
  if (lower === upper) return round(sorted[lower]);
  const weight = offset - lower;
  return round(sorted[lower] * (1 - weight) + sorted[upper] * weight);
}

function hintId(hint) {
  return hint?.id ?? hint?.candidateId ?? null;
}

function hintText(hint) {
  return String(hint?.ocrText ?? hint?.text ?? "").trim();
}

function hintBox(hint) {
  const x1 = finite(hint?.x1);
  const y1 = finite(hint?.y1);
  const x2 = finite(hint?.x2);
  const y2 = finite(hint?.y2);
  if (
    x1 === null ||
    y1 === null ||
    x2 === null ||
    y2 === null ||
    x2 <= x1 ||
    y2 <= y1
  ) {
    return null;
  }
  return { x1, y1, x2, y2 };
}

function groupKey(hint, index) {
  const semantic = Boolean(hint?.semanticGroup);
  const group = hint?.groupId ?? hint?.paddleGroupId;
  if (semantic && group !== undefined && group !== null) {
    return `semantic:${String(group)}`;
  }
  const fragment = hint?.reviewFragmentId;
  if (
    fragment !== undefined &&
    fragment !== null &&
    String(hint?.reviewStatus ?? "") === "confirmed"
  ) {
    return `fragment:${String(fragment)}`;
  }
  return `singleton:${hintId(hint) ?? index}`;
}

function orderValue(hint, fallback) {
  return (
    finite(hint?.orderInGroup) ??
    finite(hint?.paddleOrder) ??
    finite(hint?.reviewOrder) ??
    finite(hint?.id) ??
    fallback
  );
}

function groupHints(hints) {
  const groups = new Map();
  hints.forEach((hint, index) => {
    if (!hintBox(hint) || !hintText(hint) || hintId(hint) === null) return;
    const key = groupKey(hint, index);
    const values = groups.get(key) ?? [];
    values.push({ hint, index });
    groups.set(key, values);
  });
  return [...groups.entries()].map(([key, values]) => ({
    key,
    hints: values
      .sort(
        (left, right) =>
          orderValue(left.hint, left.index) -
          orderValue(right.hint, right.index),
      )
      .map((value) => value.hint),
  }));
}

function unionBox(hints) {
  const boxes = hints.map(hintBox).filter(Boolean);
  return {
    x1: Math.min(...boxes.map((box) => box.x1)),
    y1: Math.min(...boxes.map((box) => box.y1)),
    x2: Math.max(...boxes.map((box) => box.x2)),
    y2: Math.max(...boxes.map((box) => box.y2)),
  };
}

function normalizedBbox(box, page) {
  return {
    x: (box.x1 / page.width) * 1000,
    y: (box.y1 / page.height) * 1000,
    w: ((box.x2 - box.x1) / page.width) * 1000,
    h: ((box.y2 - box.y1) / page.height) * 1000,
  };
}

function resolveDirection(hints) {
  let vertical = 0;
  let horizontal = 0;
  for (const hint of hints) {
    const box = hintBox(hint);
    if (!box) continue;
    if (box.y2 - box.y1 > (box.x2 - box.x1) * 1.12) vertical += 1;
    else horizontal += 1;
  }
  return vertical > horizontal ? "vertical" : "horizontal";
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

function estimateSummary(estimate) {
  if (!estimate) return null;
  return {
    facePx: round(estimate.facePx),
    confidence: round(estimate.confidence),
    method: estimate.method,
  };
}

function summarizeRows(rows) {
  const valid = rows.filter(
    (row) => row.oldEstimate?.facePx && row.newEstimate?.facePx,
  );
  const oldFaces = valid.map((row) => row.oldEstimate.facePx);
  const newFaces = valid.map((row) => row.newEstimate.facePx);
  return {
    groups: rows.length,
    estimatedBoth: valid.length,
    multiLineGroups: rows.filter((row) => row.lineCount >= 2).length,
    lineEvidenceGroups: rows.filter((row) => row.evidenceLineCount >= 1).length,
    oldAtMost12: valid.filter((row) => row.oldEstimate.facePx <= 12).length,
    newAtMost12: valid.filter((row) => row.newEstimate.facePx <= 12).length,
    oldAtMost14: valid.filter((row) => row.oldEstimate.facePx <= 14).length,
    newAtMost14: valid.filter((row) => row.newEstimate.facePx <= 14).length,
    raisedAtLeast30Percent: valid.filter(
      (row) => row.newEstimate.facePx >= row.oldEstimate.facePx * 1.3,
    ).length,
    loweredAtLeast25Percent: valid.filter(
      (row) => row.newEstimate.facePx <= row.oldEstimate.facePx * 0.75,
    ).length,
    oldQuantiles: {
      q01: quantile(oldFaces, 0.01),
      q05: quantile(oldFaces, 0.05),
      median: quantile(oldFaces, 0.5),
      q95: quantile(oldFaces, 0.95),
      q99: quantile(oldFaces, 0.99),
    },
    newQuantiles: {
      q01: quantile(newFaces, 0.01),
      q05: quantile(newFaces, 0.05),
      median: quantile(newFaces, 0.5),
      q95: quantile(newFaces, 0.95),
      q99: quantile(newFaces, 0.99),
    },
  };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  process.env.MANGA_TRANSLATOR_OCR_RUNTIME_DIR = args.ocrRuntime;
  const manifest = readJson(args.manifest);
  const selected = Array.isArray(manifest.samples) ? manifest.samples : [];
  const samples = args.limit > 0 ? selected.slice(0, args.limit) : selected;
  if (samples.length === 0) throw new Error("No Tachidesk samples selected.");

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

  const settings = normalizeAppSettings(readJson(args.settings));
  const outputDirectory = path.dirname(args.output);
  await fsp.mkdir(outputDirectory, { recursive: true });
  const baseOptions = buildBaseTranslationOptions({
    jobId: "source-font-size-v3-tachidesk",
    runDir: path.join(outputDirectory, "runtime"),
    paths: getAppPaths(),
    settings,
  });
  const options = samples.map((sample, index) => ({
    ...baseOptions,
    imagePath: sample.imagePath,
    imageWidth: sample.width,
    imageHeight: sample.height,
    outputDir: path.join(outputDirectory, "ocr", sample.sampleId),
    label: `source-font-size-v3-${sample.sampleId}`,
    ocrProgressDefaultToPage: false,
    onProgress: (event) => {
      if (event?.progressText) {
        console.log(
          `[ocr ${index + 1}/${samples.length}] ${sample.sampleId}: ${event.progressText}`,
        );
      }
    },
  }));

  const results = simplePage.collectOcrBboxHintsBatch
    ? await simplePage.collectOcrBboxHintsBatch(options)
    : await Promise.all(
        options.map((option) => simplePage.collectOcrBboxHints(option)),
      );
  const pages = [];
  for (let pageIndex = 0; pageIndex < samples.length; pageIndex += 1) {
    const sample = samples[pageIndex];
    const result = results[pageIndex] ?? { hints: [], diagnostics: [] };
    const hints = Array.isArray(result.hints) ? result.hints : [];
    const raster = loadRaster(sample.analysisRasterPath ?? sample.imagePath);
    const page = { width: raster.width, height: raster.height };
    const rows = [];
    for (const group of groupHints(hints)) {
      const sourceText = group.hints.map(hintText).join("\n");
      const item = {
        id: hintId(group.hints[0]),
        candidateIds: group.hints.map(hintId),
        type: "nonsolid",
        bbox: normalizedBbox(unionBox(group.hints), page),
        sourceText,
        jp: sourceText,
        ko: "검증",
        direction: resolveDirection(group.hints),
      };
      const [locked] = applyOcrCandidateGeometryLocks([item], page, hints);
      if (!locked) continue;
      const { sourceFontLineGeometry, ...oldItem } = locked;
      const oldEstimate = estimateSummary(
        estimateSourceFontSizeForItem(raster, oldItem),
      );
      const newEstimate = estimateSummary(
        estimateSourceFontSizeForItem(raster, locked),
      );
      rows.push({
        groupKey: group.key,
        candidateIds: group.hints.map(hintId),
        sourceText,
        direction: item.direction,
        lineCount: group.hints.length,
        evidenceLineCount: sourceFontLineGeometry?.lines?.length ?? 0,
        bboxPx: unionBox(group.hints),
        oldEstimate,
        newEstimate,
        ratio:
          oldEstimate?.facePx && newEstimate?.facePx
            ? round(newEstimate.facePx / oldEstimate.facePx)
            : null,
      });
    }
    const pageRecord = {
      ...sample,
      hintCount: hints.length,
      diagnostics: result.diagnostics ?? [],
      noTextDetected: Boolean(result.noTextDetected),
      summary: summarizeRows(rows),
      groups: rows,
    };
    pages.push(pageRecord);
    await fsp.mkdir(path.join(outputDirectory, "ocr", sample.sampleId), {
      recursive: true,
    });
    await fsp.writeFile(
      path.join(outputDirectory, "ocr", sample.sampleId, "ocr-result.json"),
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8",
    );
    console.log(
      `[smoke ${pageIndex + 1}/${samples.length}] ${sample.sampleId}: hints=${hints.length}, groups=${rows.length}`,
    );
  }

  const allRows = pages.flatMap((page) =>
    page.groups.map((group) => ({ ...group, sampleId: page.sampleId })),
  );
  const report = {
    schemaVersion: 1,
    manifest: args.manifest,
    settings: {
      modelProvider: settings.modelProvider,
      ocrDevice: baseOptions.ocrDevice,
      ocrEngine: baseOptions.ocrEngine,
      ocrVersion: baseOptions.ocrVersion,
      ocrMergeMode: baseOptions.ocrMergeMode,
    },
    pageCount: pages.length,
    workCount: new Set(pages.map((page) => `${page.provider}/${page.work}`))
      .size,
    providerCount: new Set(pages.map((page) => page.provider)).size,
    summary: summarizeRows(allRows),
    largestIncreases: allRows
      .filter((row) => Number.isFinite(row.ratio))
      .sort((left, right) => right.ratio - left.ratio)
      .slice(0, 40),
    largestDecreases: allRows
      .filter((row) => Number.isFinite(row.ratio))
      .sort((left, right) => left.ratio - right.ratio)
      .slice(0, 40),
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
