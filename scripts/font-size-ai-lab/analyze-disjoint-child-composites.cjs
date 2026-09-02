#!/usr/bin/env node
/* eslint-disable -- isolated fixed-suite composite-mask diagnostic */
// @ts-nocheck -- laboratory evidence generator, not production code.
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

function parseArgs(argv) {
  const args = { capture: null, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--capture") args.capture = path.resolve(argv[++index]);
    else if (value === "--output") args.output = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!args.capture || !args.output) {
    throw new Error("--capture DIR and --output FILE are required.");
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

function intersection(first, second) {
  let area = 0;
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] && second[index]) area += 1;
  }
  return area;
}

function tripleIntersection(first, second, third) {
  let area = 0;
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] && second[index] && third[index]) area += 1;
  }
  return area;
}

function maskBox(mask, width, height) {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  return right < left ? null : [left, top, right + 1, bottom + 1];
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

function toPageBox(box, item, record) {
  return [
    (box[0] / item.width) * record.imageWidth,
    (box[1] / item.height) * record.imageHeight,
    (box[2] / item.width) * record.imageWidth,
    (box[3] / item.height) * record.imageHeight,
  ].map(round);
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const files = fs
    .readdirSync(args.capture)
    .filter((name) => /^P\d+\.json$/u.test(name))
    .sort();
  const candidates = [];
  let textCount = 0;
  for (const fileName of files) {
    const record = JSON.parse(
      await fsp.readFile(path.join(args.capture, fileName), "utf8"),
    );
    const text = record.detections.flatMap((detection, index) => {
      if (detection.label !== "text" || !detection.mask) return [];
      const mask = unpack(detection.mask);
      return [
        {
          area: count(mask),
          box: maskBox(mask, detection.mask.width, detection.mask.height),
          detectorBox: detection.box.map(round),
          height: detection.mask.height,
          id: `T${String(index + 1).padStart(3, "0")}`,
          mask,
          score: detection.score,
          width: detection.mask.width,
        },
      ];
    });
    textCount += text.length;
    for (const subject of text) {
      for (let left = 0; left < text.length; left += 1) {
        const first = text[left];
        if (first === subject || first.area >= subject.area) continue;
        for (let right = left + 1; right < text.length; right += 1) {
          const second = text[right];
          if (second === subject || second.area >= subject.area) continue;
          const peerIntersection = intersection(first.mask, second.mask);
          const peerOverlap =
            peerIntersection / Math.max(1, Math.min(first.area, second.area));
          const xGap = axisGap(
            first.box[0],
            first.box[2],
            second.box[0],
            second.box[2],
          );
          const yGap = axisGap(
            first.box[1],
            first.box[3],
            second.box[1],
            second.box[3],
          );
          if (peerOverlap > 0.05 || Math.max(xGap, yGap) < 1) continue;
          const firstIntersection = intersection(subject.mask, first.mask);
          const secondIntersection = intersection(subject.mask, second.mask);
          const shared = tripleIntersection(
            subject.mask,
            first.mask,
            second.mask,
          );
          const covered = firstIntersection + secondIntersection - shared;
          const subjectCoverage = covered / Math.max(1, subject.area);
          const firstCoverage = firstIntersection / Math.max(1, first.area);
          const secondCoverage = secondIntersection / Math.max(1, second.area);
          const firstContribution =
            firstIntersection / Math.max(1, subject.area);
          const secondContribution =
            secondIntersection / Math.max(1, subject.area);
          if (
            subjectCoverage < 0.9 ||
            Math.min(firstCoverage, secondCoverage) < 0.4 ||
            Math.min(firstContribution, secondContribution) < 0.15
          ) {
            continue;
          }
          candidates.push({
            pageId: record.pageId,
            subjectId: subject.id,
            childIds: [first.id, second.id],
            scores: [subject.score, first.score, second.score].map(round),
            areas: [subject.area, first.area, second.area],
            subjectBox: toPageBox(subject.box, subject, record),
            childBoxes: [
              toPageBox(first.box, first, record),
              toPageBox(second.box, second, record),
            ],
            detectorBoxes: [
              subject.detectorBox,
              first.detectorBox,
              second.detectorBox,
            ],
            disjointAxis: xGap >= yGap ? "x" : "y",
            gapGrid: Math.max(xGap, yGap),
            gapPx: round(
              Math.max(
                xGap * (record.imageWidth / subject.width),
                yGap * (record.imageHeight / subject.height),
              ),
            ),
            peerOverlap: round(peerOverlap),
            subjectCoverage: round(subjectCoverage),
            childCoverage: [firstCoverage, secondCoverage].map(round),
            childContributions: [firstContribution, secondContribution].map(
              round,
            ),
          });
        }
      }
    }
  }
  candidates.sort(
    (left, right) =>
      left.pageId.localeCompare(right.pageId) ||
      left.subjectId.localeCompare(right.subjectId) ||
      right.subjectCoverage - left.subjectCoverage,
  );
  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    policy: {
      minimumSubjectCoverage: 0.9,
      minimumChildCoverage: 0.4,
      minimumChildContribution: 0.15,
      maximumChildMaskOverlap: 0.05,
      minimumChildBoxGapGrid: 1,
      childrenMustBeSmallerThanSubject: true,
    },
    summary: {
      pageCount: files.length,
      textCount,
      candidateCount: candidates.length,
      candidatePageCount: new Set(candidates.map((item) => item.pageId)).size,
    },
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

run().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
