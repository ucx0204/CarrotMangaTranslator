#!/usr/bin/env electron
/* eslint-disable -- isolated product-path regression replay */
// @ts-nocheck -- laboratory artifact generator; production types remain checked.
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { app, nativeImage } = require("electron");

function parseArgs(argv) {
  const args = { baseline: null, expected: null, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--baseline") args.baseline = path.resolve(argv[++index]);
    else if (value === "--expected")
      args.expected = path.resolve(argv[++index]);
    else if (value === "--output") args.output = path.resolve(argv[++index]);
    else if (value === "--help") {
      console.log(
        "Usage: electron scripts/font-size-ai-lab/replay-production-page-estimator.cjs " +
          "--baseline PATH --expected PATH --output PATH",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${value}`);
  }
  for (const key of Object.keys(args)) {
    if (!args[key]) throw new Error(`--${key} is required.`);
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadRaster(imagePath) {
  const image = nativeImage.createFromPath(imagePath);
  if (image.isEmpty()) throw new Error(`Could not decode image: ${imagePath}`);
  const { width, height } = image.getSize();
  return { bgra: Uint8Array.from(image.toBitmap()), width, height };
}

function toItem(candidate, page, index) {
  const bbox = candidate.bbox;
  return {
    angle: 0,
    bbox: {
      x: (bbox.x1 / page.width) * 1_000,
      y: (bbox.y1 / page.height) * 1_000,
      w: ((bbox.x2 - bbox.x1) / page.width) * 1_000,
      h: ((bbox.y2 - bbox.y1) / page.height) * 1_000,
    },
    confidence: candidate.hayaiConfidence ?? 1,
    direction: candidate.direction,
    id: index + 1,
    jp: candidate.sourceText,
    ko: "검증",
    sourceText: candidate.sourceText,
    textRole: "ordinary",
    translatedText: "검증",
    type: "nonsolid",
  };
}

function expectedMap(evaluation) {
  return new Map(
    evaluation.predictions.map((prediction) => [
      prediction.key,
      prediction.selected,
    ]),
  );
}

async function run(args) {
  const baseline = readJson(args.baseline);
  const expectedEvaluation = readJson(args.expected);
  const expected = expectedMap(expectedEvaluation);
  const { estimatePageSourceFontSizes } = require(
    path.resolve("out/main/pipeline/sourceFontSizeEstimator.js"),
  );
  const predictions = [];
  const changes = [];
  const mismatches = [];
  for (const page of baseline.pages) {
    const raster = loadRaster(page.imagePath);
    if (raster.width !== page.width || raster.height !== page.height) {
      throw new Error(`Raster dimensions changed: ${page.pageId}`);
    }
    const estimates = await estimatePageSourceFontSizes({
      enabled: true,
      items: page.candidates.map((candidate, index) =>
        toItem(candidate, page, index),
      ),
      page: { id: page.pageId, width: page.width, height: page.height },
      loadRaster: async () => raster,
    });
    page.candidates.forEach((candidate, index) => {
      const id = `${page.pageId}/${candidate.candidateId}`;
      const before = candidate.estimate ?? null;
      const after = estimates[index] ?? null;
      predictions.push({ id, before, after });
      if (
        before &&
        after &&
        Math.abs(Math.log(after.facePx / before.facePx)) >= Math.log(1.01)
      ) {
        changes.push({ id, before, after, sourceText: candidate.sourceText });
      }
      const predicted = expected.get(id) ?? null;
      if (!sameEstimate(after, predicted)) {
        mismatches.push({
          id,
          expectedFacePx: round(predicted?.facePx),
          actualFacePx: round(after?.facePx),
        });
      }
    });
  }
  const output = {
    schemaVersion: 1,
    experiment: "production-page-peer-gated-regression-replay",
    createdAt: new Date().toISOString(),
    sourceReport: path
      .relative(process.cwd(), args.baseline)
      .replaceAll("\\", "/"),
    expectedEvaluation: path
      .relative(process.cwd(), args.expected)
      .replaceAll("\\", "/"),
    summary: {
      candidateCount: predictions.length,
      sourceReportEstimated: predictions.filter((item) => item.before).length,
      estimated: predictions.filter((item) => item.after).length,
      sourceReportChangedCount: changes.length,
      expectedRuleChangedCount: expectedEvaluation.changed.length,
      expectedPredictionMismatchCount: mismatches.length,
    },
    changes,
    expectedMismatches: mismatches,
  };
  await fsp.mkdir(path.dirname(args.output), { recursive: true });
  await fsp.writeFile(
    args.output,
    `${JSON.stringify(output, null, 2)}\n`,
    "utf8",
  );
  console.log(JSON.stringify({ output: args.output, ...output.summary }));
}

function sameEstimate(actual, expected) {
  if (!actual || !expected) return !actual && !expected;
  return Math.abs(actual.facePx - expected.facePx) <= 0.0001;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

const args = parseArgs(process.argv.slice(2));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "fsai-page-replay-"));
app.setPath("userData", userData);
app.on("window-all-closed", () => {});
app
  .whenReady()
  .then(() => run(args))
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error?.stack || error);
    app.exit(1);
  });
