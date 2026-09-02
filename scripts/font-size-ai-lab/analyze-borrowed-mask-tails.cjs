#!/usr/bin/env node
/* eslint-disable -- isolated mask hypothesis analysis utility */
// @ts-nocheck -- experiment utility; production types remain checked.
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
const BORROWED_TAIL_GAP_RATIO = 0.02;
const DETECTOR_OWNED_TAIL_AREA_RATIO = 0.2;

function parseArgs(argv) {
  const args = { captures: [], output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--capture") {
      const spec = String(argv[++index]);
      const separator = spec.indexOf("=");
      if (separator <= 0) throw new Error("--capture must be NAME=PATH.");
      args.captures.push({
        name: spec.slice(0, separator),
        root: path.resolve(spec.slice(separator + 1)),
      });
    } else if (value === "--output") {
      args.output = path.resolve(argv[++index]);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (!args.output || args.captures.length === 0) {
    throw new Error(
      "At least one --capture NAME=PATH and --output are required.",
    );
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

function intersection(first, second, predicate = () => true) {
  let area = 0;
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] && second[index] && predicate(index)) area += 1;
  }
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
  const read = (values, ratio) =>
    values[Math.floor((values.length - 1) * ratio)] ?? 0;
  return [
    read(xs, OUTLIER_RATIO),
    read(ys, OUTLIER_RATIO),
    read(xs, 1 - OUTLIER_RATIO) + 1,
    read(ys, 1 - OUTLIER_RATIO) + 1,
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

function currentPreprocess(mask, width, height, pageWidth, pageHeight) {
  const rawBox = maskBox(mask, width, height);
  const robustBox = quantileBox(mask, width, height);
  let current =
    boxArea(rawBox) / Math.max(1, boxArea(robustBox)) >= OUTLIER_AREA_GAIN
      ? clearOutside(mask, width, height, robustBox)
      : new Uint8Array(mask);
  let currentBox = maskBox(current, width, height);
  const pageBox = [
    (currentBox[0] / width) * pageWidth,
    (currentBox[1] / height) * pageHeight,
    (currentBox[2] / width) * pageWidth,
    (currentBox[3] / height) * pageHeight,
  ];
  const pageBoxWidth = Math.max(1, pageBox[2] - pageBox[0]);
  const pageBoxHeight = Math.max(1, pageBox[3] - pageBox[1]);
  if (
    pageBoxHeight / Math.max(1, pageHeight) >= PAGE_STRIP_HEIGHT_RATIO &&
    pageBoxHeight / pageBoxWidth >= PAGE_STRIP_ASPECT
  ) {
    const minimumGap = Math.max(2, Math.ceil(height * PAGE_STRIP_GAP_RATIO));
    while (true) {
      const split = largestGap(current, width, height, 1);
      if (!split || split.gap < minimumGap) break;
      const total = split.lowArea + split.highArea;
      const weakArea = Math.min(split.lowArea, split.highArea);
      if (weakArea / Math.max(1, total) > WEAK_TAIL_AREA_RATIO) break;
      const removeLow = split.lowArea <= split.highArea;
      current = filterSide(current, width, height, 1, split, !removeLow);
    }
    currentBox = maskBox(current, width, height);
  }
  return { area: count(current), box: currentBox, mask: current };
}

function occupiedAxis(mask, width, height, axis) {
  const length = axis === 0 ? width : height;
  const areas = new Int32Array(length);
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const coordinate = axis === 0 ? index % width : Math.floor(index / width);
    areas[coordinate] += 1;
  }
  return areas;
}

function axisGaps(mask, width, height, axis) {
  const areas = occupiedAxis(mask, width, height, axis);
  const occupied = [];
  for (let coordinate = 0; coordinate < areas.length; coordinate += 1) {
    if (areas[coordinate] > 0) occupied.push(coordinate);
  }
  const gaps = [];
  for (let index = 1; index < occupied.length; index += 1) {
    const before = occupied[index - 1];
    const after = occupied[index];
    const gap = after - before - 1;
    if (gap <= 0) continue;
    let lowArea = 0;
    let highArea = 0;
    for (let coordinate = 0; coordinate <= before; coordinate += 1) {
      lowArea += areas[coordinate];
    }
    for (let coordinate = after; coordinate < areas.length; coordinate += 1) {
      highArea += areas[coordinate];
    }
    gaps.push({ before, after, gap, lowArea, highArea });
  }
  return gaps.sort((left, right) => right.gap - left.gap);
}

function largestGap(mask, width, height, axis) {
  return axisGaps(mask, width, height, axis)[0] ?? null;
}

function onSide(index, width, axis, split, low) {
  const coordinate = axis === 0 ? index % width : Math.floor(index / width);
  return low ? coordinate <= split.before : coordinate >= split.after;
}

function filterSide(mask, width, height, axis, split, keepLow) {
  const output = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] && onSide(index, width, axis, split, keepLow)) {
      output[index] = 1;
    }
  }
  return output;
}

function pointInBox(x, y, box) {
  return x >= box[0] && y >= box[1] && x < box[2] && y < box[3];
}

function axisGap(firstLow, firstHigh, secondLow, secondHigh) {
  return Math.max(
    0,
    Math.max(firstLow, secondLow) - Math.min(firstHigh, secondHigh),
  );
}

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}

async function analyzeCapture(capture) {
  const files = fs
    .readdirSync(capture.root)
    .filter((name) => /^P\d+\.json$/u.test(name))
    .sort();
  const rows = [];
  let textCount = 0;
  for (const fileName of files) {
    const record = JSON.parse(
      await fsp.readFile(path.join(capture.root, fileName), "utf8"),
    );
    const text = record.detections.flatMap((detection, index) => {
      if (detection.label !== "text") return [];
      const mask = unpack(detection.mask);
      const refined = currentPreprocess(
        mask,
        detection.mask.width,
        detection.mask.height,
        record.imageWidth,
        record.imageHeight,
      );
      return [
        {
          area: refined.area,
          id: `T${String(index + 1).padStart(3, "0")}`,
          mask: refined.mask,
          score: detection.score,
          detectorBox: detection.box,
          pageWidth: record.imageWidth,
          pageHeight: record.imageHeight,
          width: detection.mask.width,
          height: detection.mask.height,
        },
      ];
    });
    textCount += text.length;
    for (const subject of text) {
      for (const axis of [0, 1]) {
        const minimumGap = Math.max(
          2,
          Math.ceil(
            (axis === 0 ? subject.width : subject.height) *
              BORROWED_TAIL_GAP_RATIO,
          ),
        );
        for (const split of axisGaps(
          subject.mask,
          subject.width,
          subject.height,
          axis,
        )) {
          if (split.gap < minimumGap) continue;
          const totalArea = split.lowArea + split.highArea;
          const weakLow = split.lowArea <= split.highArea;
          const weakArea = Math.min(split.lowArea, split.highArea);
          const weakRatio = weakArea / Math.max(1, totalArea);
          if (weakRatio > DETECTOR_OWNED_TAIL_AREA_RATIO) continue;
          let weakInsideSubjectDetector = 0;
          let bodyInsideSubjectDetector = 0;
          for (let index = 0; index < subject.mask.length; index += 1) {
            if (!subject.mask[index]) continue;
            const x =
              ((index % subject.width) + 0.5) *
              (subject.pageWidth / subject.width);
            const y =
              (Math.floor(index / subject.width) + 0.5) *
              (subject.pageHeight / subject.height);
            if (!pointInBox(x, y, subject.detectorBox)) continue;
            if (onSide(index, subject.width, axis, split, weakLow)) {
              weakInsideSubjectDetector += 1;
            } else {
              bodyInsideSubjectDetector += 1;
            }
          }
          const peers = text
            .filter((peer) => peer !== subject)
            .map((peer) => {
              const weakIntersection = intersection(
                subject.mask,
                peer.mask,
                (index) => onSide(index, subject.width, axis, split, weakLow),
              );
              const strongIntersection = intersection(
                subject.mask,
                peer.mask,
                (index) => onSide(index, subject.width, axis, split, !weakLow),
              );
              let weakInsidePeerDetector = 0;
              for (let index = 0; index < subject.mask.length; index += 1) {
                if (
                  !subject.mask[index] ||
                  !onSide(index, subject.width, axis, split, weakLow)
                ) {
                  continue;
                }
                const x =
                  ((index % subject.width) + 0.5) *
                  (subject.pageWidth / subject.width);
                const y =
                  (Math.floor(index / subject.width) + 0.5) *
                  (subject.pageHeight / subject.height);
                if (pointInBox(x, y, peer.detectorBox)) {
                  weakInsidePeerDetector += 1;
                }
              }
              const detectorGapGrid =
                axis === 0
                  ? axisGap(
                      subject.detectorBox[0],
                      subject.detectorBox[2],
                      peer.detectorBox[0],
                      peer.detectorBox[2],
                    ) *
                    (subject.width / subject.pageWidth)
                  : axisGap(
                      subject.detectorBox[1],
                      subject.detectorBox[3],
                      peer.detectorBox[1],
                      peer.detectorBox[3],
                    ) *
                    (subject.height / subject.pageHeight);
              return {
                id: peer.id,
                score: round(peer.score),
                area: peer.area,
                weakIntersection,
                weakOwned: weakIntersection / Math.max(1, weakArea),
                peerUsedByWeak: weakIntersection / Math.max(1, peer.area),
                strongPeerOverlap:
                  strongIntersection /
                  Math.max(1, Math.min(totalArea - weakArea, peer.area)),
                detectorGapGrid,
                weakInsidePeerDetector,
              };
            })
            .filter((peer) => peer.weakIntersection > 0)
            .sort(
              (left, right) =>
                right.weakOwned - left.weakOwned ||
                left.strongPeerOverlap - right.strongPeerOverlap,
            );
          const bestPeer = peers[0] ?? null;
          if (!bestPeer) continue;
          const strongMask = filterSide(
            subject.mask,
            subject.width,
            subject.height,
            axis,
            split,
            !weakLow,
          );
          const subjectBox = maskBox(
            subject.mask,
            subject.width,
            subject.height,
          );
          const strongBox = maskBox(strongMask, subject.width, subject.height);
          const bboxAreaGain =
            boxArea(subjectBox) / Math.max(1, boxArea(strongBox));
          const primarySpan = subjectBox[axis + 2] - subjectBox[axis];
          const strongPrimarySpan = strongBox[axis + 2] - strongBox[axis];
          rows.push({
            capture: capture.name,
            pageId: record.pageId,
            subjectId: subject.id,
            subjectScore: round(subject.score),
            subjectArea: subject.area,
            axis: axis === 0 ? "x" : "y",
            gap: split.gap,
            minimumGap,
            weakSide: weakLow ? "low" : "high",
            weakArea,
            weakRatio: round(weakRatio),
            bboxAreaGain: round(bboxAreaGain),
            primarySpanGain: round(
              primarySpan / Math.max(1, strongPrimarySpan),
            ),
            bestPeer: {
              ...bestPeer,
              detectorGapGrid: round(bestPeer.detectorGapGrid),
              weakOwned: round(bestPeer.weakOwned),
              weakInsidePeerDetector: round(
                bestPeer.weakInsidePeerDetector / Math.max(1, weakArea),
              ),
              peerUsedByWeak: round(bestPeer.peerUsedByWeak),
              strongPeerOverlap: round(bestPeer.strongPeerOverlap),
            },
            weakInsideSubjectDetector: round(
              weakInsideSubjectDetector / Math.max(1, weakArea),
            ),
            bodyInsideSubjectDetector: round(
              bodyInsideSubjectDetector / Math.max(1, totalArea - weakArea),
            ),
            qualifies:
              subject.score >= 0.85 &&
              weakRatio <= WEAK_TAIL_AREA_RATIO &&
              bestPeer.weakOwned >= 0.9 &&
              bestPeer.strongPeerOverlap <= 0.1 &&
              bestPeer.area >= weakArea * 2 &&
              bboxAreaGain >= 1.25,
            detectorOwnedQualifies:
              subject.score >= 0.8 &&
              bestPeer.score >= 0.75 &&
              bestPeer.weakOwned >= 0.9 &&
              bestPeer.weakInsidePeerDetector / Math.max(1, weakArea) >= 0.9 &&
              weakInsideSubjectDetector / Math.max(1, weakArea) <= 0.1 &&
              bodyInsideSubjectDetector / Math.max(1, totalArea - weakArea) >=
                0.85 &&
              bestPeer.detectorGapGrid >= 2 &&
              bboxAreaGain >= 1.25,
          });
          break;
        }
      }
    }
  }
  return { fileCount: files.length, rows, textCount };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const analyses = [];
  for (const capture of args.captures) {
    analyses.push({ capture, analysis: await analyzeCapture(capture) });
  }
  const rows = analyses.flatMap(({ analysis }) => analysis.rows);
  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    policy: {
      borrowedTailMinimumGapRatio: BORROWED_TAIL_GAP_RATIO,
      maximumWeakTailAreaRatio: WEAK_TAIL_AREA_RATIO,
      minimumWeakOwnership: 0.9,
      maximumStrongPeerOverlap: 0.1,
      minimumPeerToWeakAreaRatio: 2,
    },
    summary: {
      captureCount: analyses.length,
      pageCount: analyses.reduce(
        (sum, { analysis }) => sum + analysis.fileCount,
        0,
      ),
      textCount: analyses.reduce(
        (sum, { analysis }) => sum + analysis.textCount,
        0,
      ),
      candidateCount: rows.length,
      qualifyingCount: rows.filter((row) => row.qualifies).length,
      detectorOwnedQualifyingCount: rows.filter(
        (row) => row.detectorOwnedQualifies,
      ).length,
    },
    qualifying: rows.filter((row) => row.qualifies),
    detectorOwnedQualifying: rows.filter((row) => row.detectorOwnedQualifies),
    candidates: rows,
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
