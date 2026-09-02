#!/usr/bin/env node
/* eslint-disable -- isolated experiment/audit utility, not a production module */
// @ts-nocheck -- isolated experiment/audit utility; production types remain checked.
"use strict";

/**
 * Inspect the production source-size estimator on one real image region.
 *
 * This research-only entrypoint deliberately loads the compiled geometry
 * module in an isolated CommonJS wrapper so it can report private intermediate
 * values without expanding the production API or changing product behavior.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { createRequire } = require("node:module");
const path = require("node:path");
const { app, nativeImage } = require("electron");

function parseArgs(argv) {
  const args = {
    bbox: null,
    direction: "vertical",
    image: null,
    output: null,
    text: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--image") args.image = path.resolve(argv[++index]);
    else if (value === "--bbox") args.bbox = parseBbox(argv[++index]);
    else if (value === "--direction") args.direction = argv[++index];
    else if (value === "--text") args.text = argv[++index];
    else if (value === "--output") args.output = path.resolve(argv[++index]);
    else if (value === "--help") {
      console.log(
        "Usage: electron scripts/font-size-ai-lab/diagnose-source-size.cjs " +
          "--image PATH --bbox x,y,w,h --direction vertical|horizontal " +
          "--text TEXT [--output PATH]",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${value}`);
  }
  if (!args.image || !args.bbox || !args.text) {
    throw new Error("--image, --bbox, and --text are required.");
  }
  if (!new Set(["horizontal", "vertical"]).has(args.direction)) {
    throw new Error("--direction must be horizontal or vertical.");
  }
  return args;
}

function parseBbox(value) {
  const values = String(value)
    .split(",")
    .map((part) => Number(part.trim()));
  if (values.length !== 4 || values.some((part) => !Number.isFinite(part))) {
    throw new Error("--bbox must contain four finite comma-separated values.");
  }
  const [x, y, w, h] = values;
  if (w <= 0 || h <= 0)
    throw new Error("--bbox width and height must be positive.");
  return { x, y, w, h };
}

function loadRaster(imagePath) {
  const image = nativeImage.createFromPath(imagePath);
  if (image.isEmpty()) throw new Error(`Could not decode image: ${imagePath}`);
  const { width, height } = image.getSize();
  return { bgra: Uint8Array.from(image.toBitmap()), height, width };
}

function visibleGlyphCount(value) {
  return Array.from(String(value)).filter((glyph) => !/^\s$/u.test(glyph))
    .length;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function relativeDispersion(values) {
  if (values.length < 2) return 0;
  const center = median(values);
  return (
    median(values.map((value) => Math.abs(value - center))) /
    Math.max(1, center)
  );
}

function rejectionReasons(metrics) {
  return [
    [metrics.rawFace < 6, "raw-face-below-6"],
    [metrics.foregroundRatio < 0.003, "foreground-ratio-below-0.003"],
    [metrics.foregroundRatio > 0.47, "foreground-ratio-above-0.47"],
    [
      metrics.componentCount > Math.max(20, metrics.glyphCount * 8),
      "too-many-components",
    ],
    [metrics.agreement < 0.34, "pitch-agreement-below-0.34"],
    [metrics.agreement > 1.3, "pitch-agreement-above-1.3"],
    [metrics.lineAgreement < 0.24, "line-agreement-below-0.24"],
    [metrics.lineAgreement > 1.08, "line-agreement-above-1.08"],
    [metrics.dispersion > 0.4, "line-face-dispersion-above-0.4"],
  ].flatMap(([failed, reason]) => (failed ? [reason] : []));
}

function shortestMassSpan(values, targetRatio) {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  const target = total * targetRatio;
  let best = null;
  let end = 0;
  let mass = 0;
  for (let start = 0; start < values.length; start += 1) {
    while (end < values.length && mass < target) {
      mass += values[end] ?? 0;
      end += 1;
    }
    if (mass >= target && (best === null || end - start < best)) {
      best = end - start;
    }
    mass -= values[start] ?? 0;
  }
  return best;
}

function denseProfileSpan(values, thresholdRatio) {
  const peak = Math.max(0, ...values);
  const threshold = peak * thresholdRatio;
  const active = values
    .map((value, index) => (value >= threshold ? index : -1))
    .filter((index) => index >= 0);
  return active.length ? active[active.length - 1] - active[0] + 1 : null;
}

function summarizeBandProfile(profile, [start, end]) {
  const values = profile.slice(start, end);
  const mass = values.reduce((sum, value) => sum + value, 0);
  return {
    start,
    end,
    width: end - start,
    mass,
    peak: Math.max(0, ...values),
    denseSpan10: denseProfileSpan(values, 0.1),
    denseSpan15: denseProfileSpan(values, 0.15),
    denseSpan20: denseProfileSpan(values, 0.2),
    denseSpan25: denseProfileSpan(values, 0.25),
    shortestMass80: shortestMassSpan(values, 0.8),
    shortestMass85: shortestMassSpan(values, 0.85),
    shortestMass90: shortestMassSpan(values, 0.9),
    shortestMass95: shortestMassSpan(values, 0.95),
    values,
  };
}

function loadCompiledModuleWithLab(modulePath, labNames) {
  const source = fs.readFileSync(modulePath, "utf8");
  const instrumented = `${source}\nmodule.exports.__lab = { ${labNames.join(", ")} };\n`;
  const loaded = { exports: {} };
  // Evaluate the exact compiled bytes while resolving any relative imports
  // from the compiled module's own directory, just like Node would.
  const moduleRequire = createRequire(modulePath);
  const evaluate = new Function(
    "exports",
    "module",
    "require",
    "__filename",
    "__dirname",
    instrumented,
  );
  evaluate(
    loaded.exports,
    loaded,
    moduleRequire,
    modulePath,
    path.dirname(modulePath),
  );
  return loaded.exports;
}

function loadGeometryInternals() {
  const pipelineRoot = path.resolve("out/main/pipeline");
  const geometry = loadCompiledModuleWithLab(
    path.join(pipelineRoot, "sourceFontSizeGeometry.js"),
    ["estimateLineCount"],
  );
  const projection = loadCompiledModuleWithLab(
    path.join(pipelineRoot, "sourceFontSizeProjection.js"),
    ["buildCrossProfile"],
  );
  const { selectLineBands } = require(
    path.join(pipelineRoot, "sourceFontSizeProjectionBands.js"),
  );
  return {
    ...geometry,
    __lab: {
      buildCrossProfile: projection.__lab.buildCrossProfile,
      estimateLineCount: geometry.__lab.estimateLineCount,
      measureLineFaces: projection.measureLineFaces,
      selectLineBands,
    },
  };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const raster = loadRaster(args.image);
  const { buildSourceFontCoreMask } = require(
    path.resolve("out/main/pipeline/sourceFontSizeRaster.js"),
  );
  const geometry = loadGeometryInternals();
  const core = buildSourceFontCoreMask(raster, args.bbox);
  if (!core) throw new Error("Production raster-core construction abstained.");
  const glyphCount = visibleGlyphCount(args.text);
  const bboxCross = args.direction === "vertical" ? core.width : core.height;
  const bboxMajor = args.direction === "vertical" ? core.height : core.width;
  const expectedLines = geometry.__lab.estimateLineCount(
    glyphCount,
    bboxCross,
    bboxMajor,
  );
  const profile = geometry.__lab.buildCrossProfile(core, args.direction);
  const bands = geometry.__lab.selectLineBands(profile, expectedLines);
  const faces = geometry.__lab.measureLineFaces(
    core,
    args.direction,
    expectedLines,
  );
  const coreFace = faces.length ? median(faces) : null;
  const lineCross = bboxCross / Math.max(1, expectedLines);
  const glyphsPerLine = Math.max(1, glyphCount / Math.max(1, expectedLines));
  const pitch = bboxMajor / glyphsPerLine;
  const rawFace =
    coreFace === null
      ? null
      : Math.min(coreFace, lineCross * 1.06, pitch * 1.08);
  const metrics = {
    agreement: rawFace === null ? null : rawFace / Math.max(1, pitch),
    bboxCross,
    bboxMajor,
    componentCount: core.componentCount,
    coreFace,
    dispersion: relativeDispersion(faces),
    expectedLines,
    faces,
    foregroundRatio: core.foregroundRatio,
    glyphCount,
    glyphsPerLine,
    lineAgreement: rawFace === null ? null : rawFace / Math.max(1, lineCross),
    lineCross,
    pitch,
    rawFace,
  };
  const report = {
    schemaVersion: 1,
    image: args.image,
    imageSize: { height: raster.height, width: raster.width },
    bbox: args.bbox,
    direction: args.direction,
    text: args.text,
    core: {
      bands,
      bandProfiles: bands.map((band) => summarizeBandProfile(profile, band)),
      componentCount: core.componentCount,
      foregroundRatio: core.foregroundRatio,
      height: core.height,
      width: core.width,
    },
    metrics,
    rejectionReasons:
      rawFace === null ? ["no-line-face"] : rejectionReasons(metrics),
    estimate: geometry.estimateSourceFontFace(core, args.direction, glyphCount),
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (args.output) {
    await fsp.mkdir(path.dirname(args.output), { recursive: true });
    await fsp.writeFile(args.output, serialized, "utf8");
  }
  process.stdout.write(serialized);
}

app
  .whenReady()
  .then(run)
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error?.stack || error);
    app.exit(1);
  });
