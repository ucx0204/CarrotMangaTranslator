#!/usr/bin/env node
/* eslint-disable -- isolated experiment/audit utility, not a production module */
// @ts-nocheck -- isolated experiment utility; production types remain checked.
"use strict";

/**
 * Inspect projection estimates across plausible text-line counts while reusing
 * one immutable HayaiOCR report. This is diagnostic plumbing for the locked
 * Campaign 002 experiment; it does not select or promote a production result.
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
        "Usage: electron scripts/font-size-ai-lab/inspect-line-count-candidates.cjs " +
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

function formulaLineCount(glyphCount, cross, major) {
  if (glyphCount <= 1 || cross <= 0 || major <= 0) return 1;
  const estimate = Math.sqrt((glyphCount * cross) / major);
  const maximum = Math.max(1, Math.min(12, Math.ceil(glyphCount / 2)));
  return Math.min(maximum, Math.max(1, Math.round(estimate)));
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function describe(estimate) {
  return estimate
    ? {
        confidence: round(estimate.confidence),
        facePx: round(estimate.facePx),
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
  const { measureMajorAxisPitch } = require(
    path.resolve("out/main/pipeline/sourceFontSizeMajorPitch.js"),
  );
  const candidates = [];
  for (const page of report.pages) {
    const raster = loadRaster(page.imagePath);
    for (const candidate of page.candidates) {
      const glyphCount = visibleGlyphCount(candidate.sourceText);
      const core = buildSourceFontCoreMask(
        raster,
        normalizeBbox(candidate.bbox, page),
      );
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
      const formula = formulaLineCount(glyphCount, cross, major);
      const maximum = Math.max(
        1,
        Math.min(12, Math.ceil(glyphCount / 2), formula + 4),
      );
      const trials = core
        ? Array.from({ length: maximum }, (_unused, index) => {
            const lineCount = index + 1;
            const estimate = estimateSourceFontFace(
              core,
              candidate.direction,
              glyphCount,
              { componentAffinity: false, lineCountOverride: lineCount },
            );
            const component = measureComponentAffinity(
              core,
              candidate.direction,
              lineCount,
            );
            const majorPitch = measureMajorAxisPitch(
              core,
              candidate.direction,
              glyphCount,
              lineCount,
            );
            return {
              component: component
                ? {
                    confidence: round(component.confidence),
                    lineCount: component.lineCount,
                    primaryFace: round(component.primaryFace),
                    primaryMassShare: round(component.primaryMassShare),
                    secondaryFace: round(component.secondaryFace),
                  }
                : null,
              estimate: describe(estimate),
              lineCount,
              majorPitch: majorPitch
                ? {
                    bandFaces: majorPitch.bandFaces.map((value) =>
                      round(value),
                    ),
                    confidence: round(majorPitch.confidence),
                    face: round(majorPitch.face),
                    lineCount: majorPitch.lineCount,
                  }
                : null,
            };
          })
        : [];
      const consensus = core
        ? estimateSourceFontFace(core, candidate.direction, glyphCount, {
            geometryConsensus: true,
          })
        : null;
      candidates.push({
        candidateId: candidate.candidateId,
        consensus: describe(consensus),
        cross,
        direction: candidate.direction,
        formulaLineCount: formula,
        glyphCount,
        major,
        pageId: page.pageId,
        sourceText: candidate.sourceText,
        trials,
      });
    }
  }
  const output = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    sourceReport: path
      .relative(process.cwd(), args.report)
      .replaceAll("\\", "/"),
    candidateCount: candidates.length,
    candidates,
  };
  await fsp.mkdir(path.dirname(args.output), { recursive: true });
  await fsp.writeFile(
    args.output,
    `${JSON.stringify(output, null, 2)}\n`,
    "utf8",
  );
  console.log(
    JSON.stringify(
      { output: args.output, candidates: candidates.length },
      null,
      2,
    ),
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
