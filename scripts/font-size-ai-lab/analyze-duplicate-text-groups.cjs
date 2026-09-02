#!/usr/bin/env node
/* eslint-disable -- sealed duplicate-group diagnostics */
// @ts-nocheck -- laboratory analysis only.
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const OUTLIER_RATIO = 0.005;
const OUTLIER_AREA_GAIN = 1.25;
const PAGE_STRIP_HEIGHT_RATIO = 0.4;
const PAGE_STRIP_ASPECT = 12;
const PAGE_STRIP_GAP_RATIO = 0.04;
const WEAK_TAIL_AREA_RATIO = 0.08;

function parseArgs(argv) {
  const args = { baseline: null, capture: null, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--baseline") args.baseline = path.resolve(argv[++index]);
    else if (value === "--capture") args.capture = path.resolve(argv[++index]);
    else if (value === "--output") args.output = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  for (const key of ["baseline", "capture", "output"]) {
    if (!args[key]) throw new Error(`--${key} is required.`);
  }
  return args;
}

function unpack(packed) {
  const bits = Buffer.from(packed.bitsBase64, "base64");
  const mask = new Uint8Array(packed.bitLength);
  for (let index = 0; index < mask.length; index += 1) {
    mask[index] = (bits[index >> 3] >> (index & 7)) & 1;
  }
  return mask;
}

function count(mask) {
  let area = 0;
  for (const value of mask) area += value ? 1 : 0;
  return area;
}

function maskBox(mask, width, height) {
  let x1 = width;
  let y1 = height;
  let x2 = -1;
  let y2 = -1;
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    x1 = Math.min(x1, x);
    y1 = Math.min(y1, y);
    x2 = Math.max(x2, x);
    y2 = Math.max(y2, y);
  }
  return x2 >= x1 ? [x1, y1, x2 + 1, y2 + 1] : null;
}

function boxArea(box) {
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
}

function boxIntersection(first, second) {
  return (
    Math.max(0, Math.min(first[2], second[2]) - Math.max(first[0], second[0])) *
    Math.max(0, Math.min(first[3], second[3]) - Math.max(first[1], second[1]))
  );
}

function quantileBox(mask, width, height) {
  const xs = [];
  const ys = [];
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    xs.push(index % width);
    ys.push(Math.floor(index / width));
  }
  xs.sort((left, right) => left - right);
  ys.sort((left, right) => left - right);
  const at = (values, ratio) =>
    values[Math.floor((values.length - 1) * ratio)] ?? 0;
  return [
    at(xs, OUTLIER_RATIO),
    at(ys, OUTLIER_RATIO),
    at(xs, 1 - OUTLIER_RATIO) + 1,
    at(ys, 1 - OUTLIER_RATIO) + 1,
  ];
}

function clearOutside(mask, width, height, box) {
  const output = new Uint8Array(mask);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x < box[0] || x >= box[2] || y < box[1] || y >= box[3]) {
        output[y * width + x] = 0;
      }
    }
  }
  return output;
}

function axisAreas(mask, width, height, axis) {
  const areas = new Int32Array(axis === 0 ? width : height);
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const coordinate = axis === 0 ? index % width : Math.floor(index / width);
    areas[coordinate] += 1;
  }
  return areas;
}

function largestGap(mask, width, height, axis) {
  const areas = axisAreas(mask, width, height, axis);
  const occupied = [];
  for (let coordinate = 0; coordinate < areas.length; coordinate += 1) {
    if (areas[coordinate] > 0) occupied.push(coordinate);
  }
  let best = null;
  for (let index = 1; index < occupied.length; index += 1) {
    const before = occupied[index - 1];
    const after = occupied[index];
    const gap = after - before - 1;
    if (gap <= 0 || (best && best.gap >= gap)) continue;
    const lowArea = areas
      .slice(0, before + 1)
      .reduce((sum, value) => sum + value, 0);
    const highArea = areas.slice(after).reduce((sum, value) => sum + value, 0);
    best = { before, after, gap, lowArea, highArea };
  }
  return best;
}

function keepGapSide(mask, width, height, split, keepLow) {
  const output = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const y = Math.floor(index / width);
    if (keepLow ? y <= split.before : y >= split.after) output[index] = 1;
  }
  return output;
}

function preprocess(packed, pageWidth, pageHeight) {
  const width = packed.width;
  const height = packed.height;
  const source = unpack(packed);
  const rawBox = maskBox(source, width, height);
  const robustBox = quantileBox(source, width, height);
  let mask =
    boxArea(rawBox) / Math.max(1, boxArea(robustBox)) >= OUTLIER_AREA_GAIN
      ? clearOutside(source, width, height, robustBox)
      : source;
  let box = maskBox(mask, width, height);
  const toPage = (grid) => [
    (grid[0] / width) * pageWidth,
    (grid[1] / height) * pageHeight,
    (grid[2] / width) * pageWidth,
    (grid[3] / height) * pageHeight,
  ];
  let pageBox = toPage(box);
  if (
    (pageBox[3] - pageBox[1]) / pageHeight >= PAGE_STRIP_HEIGHT_RATIO &&
    (pageBox[3] - pageBox[1]) / Math.max(1, pageBox[2] - pageBox[0]) >=
      PAGE_STRIP_ASPECT
  ) {
    const minimumGap = Math.max(2, Math.ceil(height * PAGE_STRIP_GAP_RATIO));
    while (true) {
      const split = largestGap(mask, width, height, 1);
      if (!split || split.gap < minimumGap) break;
      const total = split.lowArea + split.highArea;
      if (
        Math.min(split.lowArea, split.highArea) / Math.max(1, total) >
        WEAK_TAIL_AREA_RATIO
      )
        break;
      mask = keepGapSide(
        mask,
        width,
        height,
        split,
        split.lowArea > split.highArea,
      );
    }
    box = maskBox(mask, width, height);
    pageBox = toPage(box);
  }
  return { area: count(mask), box: pageBox, mask, width, height };
}

function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function metrics(first, second) {
  let intersection = 0;
  for (let index = 0; index < first.mask.length; index += 1) {
    if (first.mask[index] && second.mask[index]) intersection += 1;
  }
  const smallerMask = Math.max(1, Math.min(first.area, second.area));
  const smallerBox = Math.max(
    1,
    Math.min(boxArea(first.box), boxArea(second.box)),
  );
  const intersectionBox = boxIntersection(first.box, second.box);
  const unionBox = boxArea(first.box) + boxArea(second.box) - intersectionBox;
  const areaRatio =
    smallerBox / Math.max(1, Math.max(boxArea(first.box), boxArea(second.box)));
  const maskOverlap = intersection / smallerMask;
  const bboxIou = intersectionBox / Math.max(1, unionBox);
  const boxContainment = intersectionBox / smallerBox;
  const rules = [
    bboxIou >= 0.65 && maskOverlap >= 0.75 ? "iou+mask" : null,
    boxContainment >= 0.8 && maskOverlap >= 0.9 ? "protruding-child" : null,
    boxContainment >= 0.95 && areaRatio <= 0.01 && maskOverlap >= 0.25
      ? "tiny-nested"
      : null,
  ].filter(Boolean);
  return {
    areaRatio: round(areaRatio),
    bboxIou: round(bboxIou),
    boxContainment: round(boxContainment),
    intersection,
    maskAreaRatio: round(smallerMask / Math.max(first.area, second.area)),
    maskOverlap: round(maskOverlap),
    rules,
  };
}

function baselineManifestPath(root, pageId) {
  return path.join(root, "pages", pageId, "ocr", "hayai-regions.json");
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const pageDirs = fs
    .readdirSync(path.join(args.baseline, "pages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^P\d+$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const rows = [];
  for (const pageId of pageDirs) {
    const baseline = JSON.parse(
      await fsp.readFile(baselineManifestPath(args.baseline, pageId), "utf8"),
    );
    const capture = JSON.parse(
      await fsp.readFile(path.join(args.capture, `${pageId}.json`), "utf8"),
    );
    for (const region of baseline.dialogueRegions) {
      if (
        region.sourceDetectionIds.length < 2 ||
        Array.isArray(region.recognitionBboxes)
      ) {
        continue;
      }
      const members = region.sourceDetectionIds.map((id) => {
        const detectionIndex = Number(id.slice(1)) - 1;
        const detection = capture.detections[detectionIndex];
        if (!detection || detection.label !== "text" || !detection.mask) {
          throw new Error(`Invalid ${pageId}/${id}`);
        }
        return {
          id,
          score: detection.score,
          ...preprocess(
            detection.mask,
            capture.imageWidth,
            capture.imageHeight,
          ),
        };
      });
      for (let left = 0; left < members.length; left += 1) {
        for (let right = left + 1; right < members.length; right += 1) {
          const pair = `${members[left].id}+${members[right].id}`;
          rows.push({
            pageId,
            regionId: region.regionId,
            pair,
            directUserFalseDuplicate:
              (pageId === "P033" && pair === "T016+T018") ||
              (pageId === "P035" && pair === "T006+T011"),
            scores: [round(members[left].score), round(members[right].score)],
            boxes: [
              members[left].box.map(round),
              members[right].box.map(round),
            ],
            areas: [members[left].area, members[right].area],
            ...metrics(members[left], members[right]),
          });
        }
      }
    }
  }
  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    summary: {
      groupedPairCount: rows.length,
      directUserFalseDuplicateCount: rows.filter(
        (row) => row.directUserFalseDuplicate,
      ).length,
      currentRuleEdgeCount: rows.filter((row) => row.rules.length > 0).length,
    },
    directUserFalseDuplicates: rows.filter(
      (row) => row.directUserFalseDuplicate,
    ),
    groupedPairs: rows,
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

run().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
