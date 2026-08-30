#!/usr/bin/env node
/* eslint-disable @typescript-eslint/ban-ts-comment -- this read-only CLI validates versioned artifacts at runtime */
// @ts-nocheck -- versioned read-only research artifacts are validated at runtime.
"use strict";

/** Exercise the compiled production geometry lock and source-size estimator. */

const fs = require("node:fs");
const path = require("node:path");
const { app, nativeImage } = require("electron");
const { applyOcrCandidateGeometryLocks } = loadBuiltModule(
  "out/main/pipeline/overlayOcrGeometryLocks.js",
);
const { estimateSourceFontSizeForItem } = loadBuiltModule(
  "out/main/pipeline/sourceFontSizeEstimator.js",
);

function loadBuiltModule(relativePath) {
  return require(path.join(__dirname, "..", relativePath));
}

function parseArgs(argv) {
  const args = {
    audit: path.resolve(".tmp/source-font-size-v3/geometry-audit.json"),
    output: path.resolve(
      ".tmp/source-font-size-v3/geometry-production-smoke.json",
    ),
    limit: 100,
    scope: "expanded",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--audit") args.audit = path.resolve(argv[++index]);
    else if (value === "--output") args.output = path.resolve(argv[++index]);
    else if (value === "--limit") args.limit = Number(argv[++index]);
    else if (value === "--scope") args.scope = String(argv[++index]);
    else if (value === "--help") {
      console.log(
        "Usage: electron scripts/research_source_font_size_v3_production_smoke.cjs " +
          "[--audit PATH] [--output PATH] [--limit N] " +
          "[--scope expanded|line|all]",
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

function normalizedBboxFromPixels(bbox, page) {
  return {
    x: (Number(bbox.x) / page.width) * 1000,
    y: (Number(bbox.y) / page.height) * 1000,
    w: (Number(bbox.w) / page.width) * 1000,
    h: (Number(bbox.h) / page.height) * 1000,
  };
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
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

function estimateSummary(raster, item) {
  const estimate = estimateSourceFontSizeForItem(raster, item);
  return estimate
    ? {
        confidence: round(estimate.confidence),
        facePx: round(estimate.facePx),
        method: estimate.method,
      }
    : null;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const audit = readJson(args.audit);
  if (!["expanded", "line", "all"].includes(args.scope)) {
    throw new Error(`Unknown scope: ${args.scope}`);
  }
  const allRows = Array.isArray(audit.rows) ? audit.rows : [];
  const scopedRows =
    args.scope === "all"
      ? allRows
      : args.scope === "line"
        ? allRows.filter((row) => Number(row.sourceFontLineCount) >= 1)
        : Array.isArray(audit.topGeometryExpansions)
          ? audit.topGeometryExpansions
          : [];
  const sourceRows =
    args.limit > 0 ? scopedRows.slice(0, args.limit) : scopedRows;
  const rasterCache = new Map();
  const rows = [];
  for (const row of sourceRows) {
    const result = readJson(row.resultPath);
    const overlayPath = path.join(
      path.dirname(row.resultPath),
      "overlay-items.json",
    );
    const overlay = readJson(overlayPath);
    let raster = rasterCache.get(row.imagePath);
    if (!raster) {
      raster = loadRaster(row.imagePath);
      rasterCache.set(row.imagePath, raster);
    }
    const page = { width: raster.width, height: raster.height };
    const requestSummary = result.requestSummary ?? {};
    const items = (Array.isArray(overlay.items) ? overlay.items : []).map(
      (item) => normalizeRawItem(item, requestSummary, page),
    );
    const locked = applyOcrCandidateGeometryLocks(
      items,
      page,
      Array.isArray(requestSummary.ocrBboxHints)
        ? requestSummary.ocrBboxHints
        : [],
    );
    const item = locked.find(
      (candidate) =>
        candidate.id === row.itemId &&
        normalizeText(candidate.sourceText ?? candidate.jp) ===
          normalizeText(row.sourceText),
    );
    if (!item) {
      rows.push({ blockId: row.blockId, error: "locked item not found" });
      continue;
    }
    const { sourceFontLineGeometry, ...unionItem } = item;
    const persistedItem = {
      ...unionItem,
      bbox: normalizedBboxFromPixels(row.persistedBboxPx, page),
    };
    rows.push({
      blockId: row.blockId,
      workTitle: row.workTitle,
      pageNumber: row.pageNumber,
      itemId: row.itemId,
      sourceText: row.sourceText,
      textRole: row.textRole,
      fontRole: row.fontRole,
      geometryExpanded: row.geometryExpanded,
      storedSourceFontFacePx: row.sourceFontFacePx,
      evidenceLineCount: sourceFontLineGeometry?.lines?.length ?? 0,
      evidenceCandidateIds:
        sourceFontLineGeometry?.lines?.map((line) => line.candidateId) ?? [],
      persistedEstimate: estimateSummary(raster, persistedItem),
      mergedUnionEstimate: estimateSummary(raster, unionItem),
      lineGeometryEstimate: estimateSummary(raster, item),
    });
  }
  const report = {
    schemaVersion: 1,
    audit: args.audit,
    scope: args.scope,
    rows,
  };
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ rows: rows.length, output: args.output }));
}

app
  .whenReady()
  .then(run)
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
