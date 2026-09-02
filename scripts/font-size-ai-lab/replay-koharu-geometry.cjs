#!/usr/bin/env node
/* eslint-disable -- isolated experiment/audit utility, not a production module */
// @ts-nocheck -- isolated experiment/audit utility; production types remain checked.
"use strict";

/** Replay captured Koharu masks through the compiled region geometry. */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { app, nativeImage } = require("electron");
const { PNG } = require("pngjs");

function parseArgs(argv) {
  const args = { baseline: null, capture: null, output: null, report: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--baseline") args.baseline = path.resolve(argv[++index]);
    else if (value === "--capture") args.capture = path.resolve(argv[++index]);
    else if (value === "--output") args.output = path.resolve(argv[++index]);
    else if (value === "--report") args.report = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  for (const key of ["baseline", "capture", "output", "report"]) {
    if (!args[key]) throw new Error(`--${key} is required.`);
  }
  return args;
}

function unpackMask(packed) {
  const bits = Buffer.from(packed.bitsBase64, "base64");
  const logits = new Float32Array(packed.bitLength).fill(-1);
  for (let index = 0; index < logits.length; index += 1) {
    if ((bits[index >> 3] >> (index & 7)) & 1) logits[index] = 1;
  }
  return { logits, width: packed.width, height: packed.height };
}

function restoreDetection(record) {
  return {
    imageWidth: record.imageWidth,
    imageHeight: record.imageHeight,
    detections: record.detections.map((detection) => ({
      box: detection.box,
      label: detection.label,
      labelId: detection.labelId,
      score: detection.score,
      mask: unpackMask(detection.mask),
    })),
  };
}

function loadRaster(imagePath) {
  const image = nativeImage.createFromPath(imagePath);
  if (image.isEmpty()) throw new Error(`Could not decode image: ${imagePath}`);
  const { width, height } = image.getSize();
  return { bgra: Uint8Array.from(image.toBitmap()), width, height };
}

function toPng(raster) {
  const png = new PNG({ width: raster.width, height: raster.height });
  for (let pixel = 0; pixel < raster.width * raster.height; pixel += 1) {
    const source = pixel * 4;
    png.data[source] = raster.bgra[source + 2] ?? 0;
    png.data[source + 1] = raster.bgra[source + 1] ?? 0;
    png.data[source + 2] = raster.bgra[source] ?? 0;
    png.data[source + 3] = 255;
  }
  return png;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function setPixel(png, x, y, color) {
  const offset = (y * png.width + x) * 4;
  png.data[offset] = color[0];
  png.data[offset + 1] = color[1];
  png.data[offset + 2] = color[2];
  png.data[offset + 3] = 255;
}

function drawRectangle(png, box, color, lineWidth = 3) {
  const x1 = clamp(Math.floor(box[0]), 0, png.width - 1);
  const y1 = clamp(Math.floor(box[1]), 0, png.height - 1);
  const x2 = clamp(Math.ceil(box[2]) - 1, 0, png.width - 1);
  const y2 = clamp(Math.ceil(box[3]) - 1, 0, png.height - 1);
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

function cropWithBox(raster, box, color) {
  const padding = Math.max(
    18,
    Math.round(Math.max(box[2] - box[0], box[3] - box[1]) * 0.18),
  );
  const crop = [
    clamp(Math.floor(box[0]) - padding, 0, raster.width),
    clamp(Math.floor(box[1]) - padding, 0, raster.height),
    clamp(Math.ceil(box[2]) + padding, 0, raster.width),
    clamp(Math.ceil(box[3]) + padding, 0, raster.height),
  ];
  const width = crop[2] - crop[0];
  const height = crop[3] - crop[1];
  const output = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = ((crop[1] + y) * raster.width + crop[0] + x) * 4;
      const target = (y * width + x) * 4;
      output.data[target] = raster.bgra[source + 2] ?? 0;
      output.data[target + 1] = raster.bgra[source + 1] ?? 0;
      output.data[target + 2] = raster.bgra[source] ?? 0;
      output.data[target + 3] = 255;
    }
  }
  drawRectangle(
    output,
    [box[0] - crop[0], box[1] - crop[1], box[2] - crop[0], box[3] - crop[1]],
    color,
    3,
  );
  return output;
}

async function writePng(filePath, png) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, PNG.sync.write(png));
}

function area(box) {
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
}

function iou(first, second) {
  const intersection =
    Math.max(0, Math.min(first[2], second[2]) - Math.max(first[0], second[0])) *
    Math.max(0, Math.min(first[3], second[3]) - Math.max(first[1], second[1]));
  return intersection / Math.max(1, area(first) + area(second) - intersection);
}

function sourceJaccard(first, second) {
  const left = new Set(first.sourceDetectionIds);
  const right = new Set(second.sourceDetectionIds);
  const intersection = [...left].filter((id) => right.has(id)).length;
  return intersection / Math.max(1, new Set([...left, ...right]).size);
}

function bestMatch(region, candidates) {
  return (
    candidates
      .map((candidate) => ({
        candidate,
        score: sourceJaccard(region, candidate),
      }))
      .sort(
        (left, right) =>
          right.score - left.score ||
          iou(region.bbox, right.candidate.bbox) -
            iou(region.bbox, left.candidate.bbox),
      )[0] ?? null
  );
}

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const report = JSON.parse(await fsp.readFile(args.report, "utf8"));
  const { buildHayaiRegionManifest } = require(
    path.resolve("out/main/textDetection/hayaiRegionGeometry.js"),
  );
  await fsp.mkdir(args.output, { recursive: true });
  const pages = [];
  for (const page of report.pages) {
    const captured = JSON.parse(
      await fsp.readFile(
        path.join(args.capture, `${page.pageId}.json`),
        "utf8",
      ),
    );
    const nestedBaselinePath = path.join(
      args.baseline,
      "pages",
      page.pageId,
      "ocr",
      "hayai-regions.json",
    );
    const directBaselinePath = path.join(
      args.baseline,
      "pages",
      page.pageId,
      "hayai-regions.json",
    );
    const baselinePath = fs.existsSync(nestedBaselinePath)
      ? nestedBaselinePath
      : directBaselinePath;
    const oldManifest = JSON.parse(await fsp.readFile(baselinePath, "utf8"));
    const manifest = buildHayaiRegionManifest(restoreDetection(captured));
    const pageDir = path.join(args.output, "pages", page.pageId);
    await fsp.mkdir(pageDir, { recursive: true });
    await fsp.writeFile(
      path.join(pageDir, "hayai-regions.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    const raster = loadRaster(page.imagePath);
    const overlay = toPng(raster);
    for (const region of oldManifest.dialogueRegions)
      drawRectangle(overlay, region.bbox, [239, 108, 0], 2);
    for (const region of manifest.dialogueRegions)
      drawRectangle(overlay, region.bbox, [0, 137, 123], 3);
    await writePng(path.join(pageDir, "old-orange-new-green.png"), overlay);
    const matches = manifest.dialogueRegions.map((region) => {
      const match = bestMatch(region, oldManifest.dialogueRegions);
      const old = match && match.score > 0 ? match.candidate : null;
      const changed =
        !old || iou(region.bbox, old.bbox) < 0.98 || match.score < 1;
      return {
        newRegionId: region.regionId,
        oldRegionId: old?.regionId ?? null,
        sourceJaccard: round(match?.score ?? 0),
        bboxIou: old ? round(iou(region.bbox, old.bbox)) : 0,
        oldBbox: old?.bbox ?? null,
        newBbox: region.bbox,
        oldSourceDetectionIds: old?.sourceDetectionIds ?? [],
        newSourceDetectionIds: region.sourceDetectionIds,
        changed,
      };
    });
    for (const match of matches.filter((item) => item.changed)) {
      const stem = `${match.newRegionId}-from-${match.oldRegionId ?? "none"}`;
      await writePng(
        path.join(pageDir, "changed", `${stem}-new.png`),
        cropWithBox(raster, match.newBbox, [0, 137, 123]),
      );
      if (match.oldBbox) {
        await writePng(
          path.join(pageDir, "changed", `${stem}-old.png`),
          cropWithBox(raster, match.oldBbox, [239, 108, 0]),
        );
      }
    }
    const record = {
      pageId: page.pageId,
      oldDialogueCount: oldManifest.dialogueRegions.length,
      newDialogueCount: manifest.dialogueRegions.length,
      oldMaxAreaFraction: round(
        Math.max(
          0,
          ...oldManifest.dialogueRegions.map(
            (region) => area(region.bbox) / (page.width * page.height),
          ),
        ),
      ),
      newMaxAreaFraction: round(
        Math.max(
          0,
          ...manifest.dialogueRegions.map(
            (region) => area(region.bbox) / (page.width * page.height),
          ),
        ),
      ),
      changedCount: matches.filter((match) => match.changed).length,
      diagnostics: manifest.diagnostics,
      matches,
    };
    pages.push(record);
    await fsp.writeFile(
      path.join(pageDir, "geometry.json"),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );
  }
  const summary = {
    schemaVersion: 1,
    pages,
    totals: {
      oldDialogueCount: pages.reduce(
        (sum, page) => sum + page.oldDialogueCount,
        0,
      ),
      newDialogueCount: pages.reduce(
        (sum, page) => sum + page.newDialogueCount,
        0,
      ),
      changedCount: pages.reduce((sum, page) => sum + page.changedCount, 0),
      rejectedDialogueCount: pages.reduce(
        (sum, page) => sum + page.diagnostics.rejectedDialogueCount,
        0,
      ),
      ownershipSkips: pages.reduce(
        (sum, page) => sum + page.diagnostics.dialogueOwnershipSkips,
        0,
      ),
    },
  };
  await fsp.writeFile(
    path.join(args.output, "geometry-evaluation.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`${JSON.stringify(summary.totals, null, 2)}\n`);
}

app
  .whenReady()
  .then(run)
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error?.stack || error);
    app.exit(1);
  });
