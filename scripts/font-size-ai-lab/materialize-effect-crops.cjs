#!/usr/bin/env node
/* eslint-disable -- isolated experiment/audit utility, not a production module */
// @ts-nocheck -- isolated experiment/audit utility; production types remain checked.
"use strict";

/**
 * Backfill individually zoomable effect-region evidence for a completed lab
 * baseline. This changes only the disposable experiment artifact directory.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { app, nativeImage } = require("electron");
const { PNG } = require("pngjs");

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--baseline") {
    throw new Error(
      "Usage: electron scripts/font-size-ai-lab/materialize-effect-crops.cjs --baseline DIR",
    );
  }
  return { baseline: path.resolve(argv[1]) };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function loadRaster(imagePath) {
  const image = nativeImage.createFromPath(imagePath);
  if (image.isEmpty()) throw new Error(`Could not decode image: ${imagePath}`);
  const { width, height } = image.getSize();
  const bgra = Uint8Array.from(image.toBitmap());
  if (bgra.length !== width * height * 4) {
    throw new Error(`Unexpected raster byte length for ${imagePath}.`);
  }
  return { bgra, height, width };
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function setPixel(png, x, y, color) {
  const offset = (y * png.width + x) * 4;
  png.data[offset] = color[0];
  png.data[offset + 1] = color[1];
  png.data[offset + 2] = color[2];
  png.data[offset + 3] = 255;
}

function drawRectangle(png, box, color, lineWidth) {
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

function pixelBox(region, manifest) {
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

function cropWithBox(raster, box) {
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
    [30, 136, 229],
    Math.max(2, Math.round(Math.min(width, height) / 180)),
  );
  return output;
}

async function writePng(filePath, png) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, PNG.sync.write(png));
}

async function writeJson(filePath, value) {
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function run(args) {
  const reportPath = path.join(args.baseline, "baseline-report.json");
  const report = readJson(reportPath);
  let materialized = 0;
  for (const page of report.pages ?? []) {
    const pageDir = path.join(args.baseline, "pages", page.pageId);
    const manifest = readJson(path.join(pageDir, "ocr", "hayai-regions.json"));
    const raster = loadRaster(page.imagePath);
    const effectCandidates = [];
    for (const [index, effect] of (manifest.effectRegions ?? []).entries()) {
      const box = pixelBox(effect, manifest);
      const candidateId = String(
        effect.regionId || `FX${String(index + 1).padStart(3, "0")}`,
      );
      const cropPath = path.join(pageDir, "bboxes", `${candidateId}.png`);
      await writePng(cropPath, cropWithBox(raster, box));
      effectCandidates.push({
        bbox: {
          x1: round(box.x1, 3),
          x2: round(box.x2, 3),
          y1: round(box.y1, 3),
          y2: round(box.y2, 3),
        },
        candidateId,
        cropPath: path.relative(args.baseline, cropPath).replaceAll("\\", "/"),
        detectorConfidence: round(Number(effect.detectorConfidence)),
        sourceDetectionIds: effect.sourceDetectionIds ?? [],
      });
      materialized += 1;
    }
    page.effectCandidates = effectCandidates;
    await writeJson(path.join(pageDir, "page.json"), page);
  }
  await writeJson(reportPath, report);
  console.log(JSON.stringify({ baseline: args.baseline, materialized }));
}

const args = parseArgs(process.argv.slice(2));
if (!fs.existsSync(path.join(args.baseline, "baseline-report.json"))) {
  throw new Error(`Baseline report not found: ${args.baseline}`);
}
app.setPath("userData", path.join(args.baseline, "electron-user-data-effects"));
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
app.on("window-all-closed", () => {});
app
  .whenReady()
  .then(() => run(args))
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error?.stack || error);
    app.exit(1);
  });
