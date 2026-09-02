#!/usr/bin/env node
/* eslint-disable -- isolated experiment/audit utility, not a production module */
// @ts-nocheck -- isolated experiment/audit utility; production types remain checked.
"use strict";

/** Capture Koharu's thresholded instance masks once for deterministic geometry replay. */

const fsp = require("node:fs/promises");
const path = require("node:path");
const { app } = require("electron");

function parseArgs(argv) {
  const args = { model: null, output: null, pages: null, report: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--model") args.model = path.resolve(argv[++index]);
    else if (value === "--output") args.output = path.resolve(argv[++index]);
    else if (value === "--pages") {
      args.pages = new Set(
        String(argv[++index])
          .split(",")
          .map((item) => item.trim()),
      );
    } else if (value === "--report") args.report = path.resolve(argv[++index]);
    else if (value === "--help") {
      console.log(
        "Usage: electron scripts/font-size-ai-lab/capture-koharu-detections.cjs " +
          "--report PATH --model PATH --output DIR [--pages P011,P023]",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${value}`);
  }
  for (const key of ["model", "output", "report"]) {
    if (!args[key]) throw new Error(`--${key} is required.`);
  }
  return args;
}

function packMask(mask) {
  const bits = Buffer.alloc(Math.ceil(mask.logits.length / 8));
  let area = 0;
  for (let index = 0; index < mask.logits.length; index += 1) {
    if ((mask.logits[index] ?? -1) < 0) continue;
    bits[index >> 3] |= 1 << (index & 7);
    area += 1;
  }
  return {
    area,
    bitLength: mask.logits.length,
    bitsBase64: bits.toString("base64"),
    height: mask.height,
    width: mask.width,
  };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const report = JSON.parse(await fsp.readFile(args.report, "utf8"));
  const selected = report.pages.filter(
    (page) => !args.pages || args.pages.has(page.pageId),
  );
  if (!selected.length) throw new Error("No pages matched --pages.");
  const { detectKoharuPageLayout } = require(
    path.resolve("out/main/bubbleLayout/detector.js"),
  );
  const { disposeCachedKoharuLayoutSessions } = require(
    path.resolve("out/main/bubbleLayout/session.js"),
  );
  await fsp.mkdir(args.output, { recursive: true });
  const summary = [];
  try {
    for (let index = 0; index < selected.length; index += 1) {
      const page = selected[index];
      console.log(`[koharu ${index + 1}/${selected.length}] ${page.pageId}`);
      const result = await detectKoharuPageLayout({
        imagePath: page.imagePath,
        modelPath: args.model,
      });
      const record = {
        schemaVersion: 2,
        pageId: page.pageId,
        imagePath: page.imagePath,
        imageWidth: result.imageWidth,
        imageHeight: result.imageHeight,
        executionProvider: result.executionProvider ?? null,
        geometryRaster: result.geometryRaster
          ? {
              height: result.geometryRaster.height,
              luminanceBase64: Buffer.from(
                result.geometryRaster.luminance,
              ).toString("base64"),
              width: result.geometryRaster.width,
            }
          : null,
        detections: result.detections.map((detection) => ({
          box: detection.box,
          label: detection.label,
          labelId: detection.labelId,
          score: detection.score,
          mask: detection.mask ? packMask(detection.mask) : null,
        })),
      };
      const outputPath = path.join(args.output, `${page.pageId}.json`);
      await fsp.writeFile(outputPath, `${JSON.stringify(record)}\n`, "utf8");
      const counts = Object.fromEntries(
        ["text", "onomatopoeia", "bubble", "panel"].map((label) => [
          label,
          record.detections.filter((detection) => detection.label === label)
            .length,
        ]),
      );
      summary.push({
        pageId: page.pageId,
        counts,
        outputPath,
        provider: record.executionProvider,
      });
    }
  } finally {
    await disposeCachedKoharuLayoutSessions();
  }
  await fsp.writeFile(
    path.join(args.output, "capture-summary.json"),
    `${JSON.stringify({ schemaVersion: 1, pages: summary }, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`${JSON.stringify({ pages: summary }, null, 2)}\n`);
}

app
  .whenReady()
  .then(run)
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error?.stack || error);
    app.exit(1);
  });
