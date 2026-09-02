#!/usr/bin/env node
/* eslint-disable -- isolated experiment/audit utility, not a production module */
// @ts-nocheck -- isolated experiment/audit utility; production types remain checked.
"use strict";

/**
 * Compare the exact promoted projection-only estimator with the experimental
 * component-affinity path on one immutable HayaiOCR report. Detector/OCR runs
 * are shared, so any difference comes from source-font geometry only.
 */

const fsp = require("node:fs/promises");
const path = require("node:path");
const { app, nativeImage } = require("electron");

function parseArgs(argv) {
  const args = { output: null, report: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--output") args.output = path.resolve(argv[++index]);
    else if (value === "--report") args.report = path.resolve(argv[++index]);
    else if (value === "--help") {
      console.log(
        "Usage: electron scripts/font-size-ai-lab/evaluate-component-affinity-ablation.cjs " +
          "--report PATH --output PATH",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${value}`);
  }
  if (!args.report || !args.output) {
    throw new Error("--report and --output are required.");
  }
  return args;
}

function loadRaster(imagePath) {
  const image = nativeImage.createFromPath(imagePath);
  if (image.isEmpty()) throw new Error(`Could not decode image: ${imagePath}`);
  const { width, height } = image.getSize();
  return { bgra: Uint8Array.from(image.toBitmap()), height, width };
}

function normalizeBbox(bbox, page) {
  return {
    x: (Number(bbox.x1) / page.width) * 1_000,
    y: (Number(bbox.y1) / page.height) * 1_000,
    w: ((Number(bbox.x2) - Number(bbox.x1)) / page.width) * 1_000,
    h: ((Number(bbox.y2) - Number(bbox.y1)) / page.height) * 1_000,
  };
}

function visibleGlyphCount(value) {
  return Array.from(String(value ?? "")).filter(
    (grapheme) => !/^\s$/u.test(grapheme),
  ).length;
}

function estimateLineCount(glyphCount, cross, major) {
  if (glyphCount <= 1 || cross <= 0 || major <= 0) return 1;
  const estimate = Math.sqrt((glyphCount * cross) / major);
  const maximum = Math.max(1, Math.min(12, Math.ceil(glyphCount / 2)));
  return Math.min(maximum, Math.max(1, Math.round(estimate)));
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function describeEstimate(estimate) {
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
  const report = JSON.parse(await fsp.readFile(args.report, "utf8"));
  const { buildSourceFontCoreMask } = require(
    path.resolve("out/main/pipeline/sourceFontSizeRaster.js"),
  );
  const { estimateSourceFontFace } = require(
    path.resolve("out/main/pipeline/sourceFontSizeGeometry.js"),
  );
  const { measureComponentAffinity } = require(
    path.resolve("out/main/pipeline/sourceFontSizeComponentAffinity.js"),
  );
  const candidates = [];
  for (const page of report.pages) {
    const raster = loadRaster(page.imagePath);
    if (raster.width !== page.width || raster.height !== page.height) {
      throw new Error(`Raster dimensions changed for ${page.pageId}.`);
    }
    for (const candidate of page.candidates) {
      const glyphCount = visibleGlyphCount(candidate.sourceText);
      const bbox = normalizeBbox(candidate.bbox, page);
      const core = buildSourceFontCoreMask(raster, bbox);
      const cross = core
        ? candidate.direction === "vertical"
          ? core.width
          : core.height
        : 0;
      const major = core
        ? candidate.direction === "vertical"
          ? core.height
          : core.width
        : 0;
      const expectedLines = estimateLineCount(glyphCount, cross, major);
      const projection = core
        ? estimateSourceFontFace(core, candidate.direction, glyphCount, {
            componentAffinity: false,
          })
        : null;
      const r1 = core
        ? estimateSourceFontFace(core, candidate.direction, glyphCount, {
            componentAffinity: true,
          })
        : null;
      const component = core
        ? measureComponentAffinity(core, candidate.direction, expectedLines)
        : null;
      const ratio =
        projection && r1 ? r1.facePx / Math.max(1, projection.facePx) : null;
      const componentRatio =
        projection && component
          ? component.primaryFace / Math.max(1, projection.facePx)
          : null;
      candidates.push({
        candidateId: candidate.candidateId,
        component: component
          ? {
              componentCount: component.componentCount,
              confidence: round(component.confidence),
              lineCount: component.lineCount,
              primaryFace: round(component.primaryFace),
              primaryMassShare: round(component.primaryMassShare),
              secondaryFace: round(component.secondaryFace),
            }
          : null,
        componentToProjectionRatio: round(componentRatio),
        cropPath: path
          .join(path.dirname(args.report), candidate.cropPath)
          .replaceAll("\\", "/"),
        direction: candidate.direction,
        expectedLines,
        glyphCount,
        pageId: page.pageId,
        projectionOnly: describeEstimate(projection),
        r1: describeEstimate(r1),
        r1ToProjectionRatio: round(ratio),
        sourceText: candidate.sourceText,
        status:
          projection && r1
            ? Math.abs(Math.log(ratio)) >= Math.log(1.01)
              ? "changed"
              : "same"
            : projection && !r1
              ? "r1-abstained"
              : !projection && r1
                ? "r1-recovered"
                : "both-abstained",
      });
    }
  }
  const count = (status) =>
    candidates.filter((candidate) => candidate.status === status).length;
  const projectionEstimated = candidates.filter(
    (candidate) => candidate.projectionOnly,
  ).length;
  const r1Estimated = candidates.filter((candidate) => candidate.r1).length;
  const changed = candidates
    .filter((candidate) => candidate.status === "changed")
    .sort(
      (left, right) =>
        Math.abs(Math.log(right.r1ToProjectionRatio)) -
        Math.abs(Math.log(left.r1ToProjectionRatio)),
    );
  const output = {
    schemaVersion: 1,
    experiment: "campaign-002-exp-01-r1-component-affinity",
    createdAt: new Date().toISOString(),
    sourceReport: path
      .relative(process.cwd(), args.report)
      .replaceAll("\\", "/"),
    summary: {
      candidateCount: candidates.length,
      projectionEstimated,
      projectionCoverage: round(projectionEstimated / candidates.length),
      r1Estimated,
      r1Coverage: round(r1Estimated / candidates.length),
      changedCount: count("changed"),
      r1AbstainedCount: count("r1-abstained"),
      r1RecoveredCount: count("r1-recovered"),
      bothAbstainedCount: count("both-abstained"),
      componentMeasuredCount: candidates.filter(
        (candidate) => candidate.component,
      ).length,
      secondaryScaleCount: candidates.filter(
        (candidate) => candidate.component?.secondaryFace !== null,
      ).length,
    },
    changed,
    candidates,
  };
  await fsp.mkdir(path.dirname(args.output), { recursive: true });
  await fsp.writeFile(
    args.output,
    `${JSON.stringify(output, null, 2)}\n`,
    "utf8",
  );
  console.log(
    JSON.stringify({ output: args.output, ...output.summary }, null, 2),
  );
}

app
  .whenReady()
  .then(run)
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error?.stack || error);
    app.exit(1);
  });
