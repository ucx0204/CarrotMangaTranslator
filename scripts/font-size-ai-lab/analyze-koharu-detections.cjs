#!/usr/bin/env node
/* eslint-disable -- isolated experiment/audit utility, not a production module */
// @ts-nocheck -- isolated experiment/audit utility; production types remain checked.
"use strict";

/** Analyze captured Koharu masks without re-running the model. */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

function parseArgs(argv) {
  const args = { input: null, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--input") args.input = path.resolve(argv[++index]);
    else if (value === "--output") args.output = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!args.input || !args.output)
    throw new Error("--input and --output are required.");
  return args;
}

function unpackMask(packed) {
  const bits = Buffer.from(packed.bitsBase64, "base64");
  const mask = new Uint8Array(packed.bitLength);
  for (let index = 0; index < mask.length; index += 1) {
    mask[index] = (bits[index >> 3] >> (index & 7)) & 1;
  }
  return mask;
}

function prefix(label) {
  return label === "text"
    ? "T"
    : label === "onomatopoeia"
      ? "F"
      : label === "bubble"
        ? "B"
        : "P";
}

function findBox(mask, width, height) {
  let x1 = width;
  let y1 = height;
  let x2 = -1;
  let y2 = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      x1 = Math.min(x1, x);
      y1 = Math.min(y1, y);
      x2 = Math.max(x2, x);
      y2 = Math.max(y2, y);
    }
  }
  return x2 >= x1 ? [x1, y1, x2 + 1, y2 + 1] : null;
}

function toPageBox(box, gridWidth, gridHeight, pageWidth, pageHeight) {
  return [
    (box[0] / gridWidth) * pageWidth,
    (box[1] / gridHeight) * pageHeight,
    (box[2] / gridWidth) * pageWidth,
    (box[3] / gridHeight) * pageHeight,
  ];
}

function intersectionArea(first, second) {
  let total = 0;
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] && second[index]) total += 1;
  }
  return total;
}

function boxIntersection(first, second) {
  return (
    Math.max(0, Math.min(first[2], second[2]) - Math.max(first[0], second[0])) *
    Math.max(0, Math.min(first[3], second[3]) - Math.max(first[1], second[1]))
  );
}

function boxArea(box) {
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
}

function connectedComponents(mask, width, height) {
  const seen = new Uint8Array(mask.length);
  const sizes = [];
  const queue = new Int32Array(mask.length);
  for (let seed = 0; seed < mask.length; seed += 1) {
    if (!mask[seed] || seen[seed]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = seed;
    seen[seed] = 1;
    let size = 0;
    while (head < tail) {
      const pixel = queue[head++];
      size += 1;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      for (const next of [pixel - 1, pixel + 1, pixel - width, pixel + width]) {
        if (next < 0 || next >= mask.length || seen[next] || !mask[next])
          continue;
        const nx = next % width;
        const ny = Math.floor(next / width);
        if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
        seen[next] = 1;
        queue[tail++] = next;
      }
    }
    sizes.push(size);
  }
  return sizes.sort((left, right) => right - left);
}

function quantile(sorted, ratio) {
  if (!sorted.length) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((sorted.length - 1) * ratio)),
  );
  return sorted[index];
}

function robustMaskBox(mask, width, height, tailRatio = 0.005) {
  const xs = [];
  const ys = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      xs.push(x);
      ys.push(y);
    }
  }
  xs.sort((left, right) => left - right);
  ys.sort((left, right) => left - right);
  return [
    quantile(xs, tailRatio),
    quantile(ys, tailRatio),
    quantile(xs, 1 - tailRatio) + 1,
    quantile(ys, 1 - tailRatio) + 1,
  ];
}

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const files = fs.statSync(args.input).isDirectory()
    ? fs
        .readdirSync(args.input)
        .filter((name) => /^P\d+\.json$/.test(name))
        .map((name) => path.join(args.input, name))
    : [args.input];
  const pages = [];
  for (const file of files.sort()) {
    const record = JSON.parse(await fsp.readFile(file, "utf8"));
    const detections = record.detections.map((detection, index) => {
      const mask = unpackMask(detection.mask);
      const gridBox = findBox(
        mask,
        detection.mask.width,
        detection.mask.height,
      );
      const pageBox = toPageBox(
        gridBox,
        detection.mask.width,
        detection.mask.height,
        record.imageWidth,
        record.imageHeight,
      );
      return {
        ...detection,
        id: `${prefix(detection.label)}${String(index + 1).padStart(3, "0")}`,
        mask,
        gridWidth: detection.mask.width,
        gridHeight: detection.mask.height,
        area: detection.mask.area,
        gridBox,
        pageBox,
      };
    });
    const texts = detections.filter((item) => item.label === "text");
    const containers = detections.filter(
      (item) => item.label === "panel" || item.label === "bubble",
    );
    const analysis = texts.map((text) => {
      const support = containers
        .map((container) => {
          const maskSupport =
            intersectionArea(text.mask, container.mask) /
            Math.max(1, text.area);
          const boxSupport =
            boxIntersection(text.pageBox, container.pageBox) /
            Math.max(1, boxArea(text.pageBox));
          return {
            id: container.id,
            kind: container.label,
            maskSupport: round(maskSupport),
            boxSupport: round(boxSupport),
          };
        })
        .filter((item) => item.maskSupport >= 0.03 || item.boxSupport >= 0.1)
        .sort(
          (left, right) =>
            Math.max(right.maskSupport, right.boxSupport) -
            Math.max(left.maskSupport, left.boxSupport),
        );
      const children = texts
        .filter(
          (other) =>
            other !== text &&
            boxArea(other.pageBox) < boxArea(text.pageBox) * 0.8,
        )
        .map((other) => ({
          id: other.id,
          boxContainment:
            boxIntersection(other.pageBox, text.pageBox) /
            Math.max(1, boxArea(other.pageBox)),
          areaRatio:
            boxArea(other.pageBox) / Math.max(1, boxArea(text.pageBox)),
          maskOverlapSmaller:
            intersectionArea(other.mask, text.mask) /
            Math.max(1, Math.min(other.area, text.area)),
        }))
        .filter((item) => item.boxContainment >= 0.85)
        .map((item) => ({
          ...item,
          boxContainment: round(item.boxContainment),
          areaRatio: round(item.areaRatio),
          maskOverlapSmaller: round(item.maskOverlapSmaller),
        }));
      const components = connectedComponents(
        text.mask,
        text.gridWidth,
        text.gridHeight,
      );
      const robustGridBox = robustMaskBox(
        text.mask,
        text.gridWidth,
        text.gridHeight,
      );
      const robustPageBox = toPageBox(
        robustGridBox,
        text.gridWidth,
        text.gridHeight,
        record.imageWidth,
        record.imageHeight,
      );
      return {
        id: text.id,
        score: round(text.score),
        bbox: text.pageBox.map(round),
        boxAreaFraction: round(
          boxArea(text.pageBox) / (record.imageWidth * record.imageHeight),
        ),
        maskArea: text.area,
        maskDensity: round(text.area / Math.max(1, boxArea(text.gridBox))),
        robustBbox005: robustPageBox.map(round),
        rawToRobustAreaRatio005: round(
          boxArea(text.pageBox) / Math.max(1, boxArea(robustPageBox)),
        ),
        componentCount: components.length,
        largestComponents: components.slice(0, 8),
        support,
        nestedChildren: children,
      };
    });
    pages.push({
      pageId: record.pageId,
      imageWidth: record.imageWidth,
      imageHeight: record.imageHeight,
      texts: analysis,
    });
  }
  await fsp.mkdir(path.dirname(args.output), { recursive: true });
  await fsp.writeFile(
    args.output,
    `${JSON.stringify({ schemaVersion: 1, pages }, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `${JSON.stringify({ output: args.output, pages: pages.length, texts: pages.reduce((sum, page) => sum + page.texts.length, 0) }, null, 2)}\n`,
  );
}

run().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
