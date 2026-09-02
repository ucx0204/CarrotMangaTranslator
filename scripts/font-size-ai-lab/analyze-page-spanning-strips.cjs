#!/usr/bin/env node
/* eslint-disable -- deterministic campaign audit utility */
// @ts-nocheck -- one-off laboratory capture analyzer.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function unpackMask(packed) {
  const bits = Buffer.from(packed.bitsBase64, "base64");
  const mask = new Uint8Array(packed.bitLength);
  for (let index = 0; index < mask.length; index += 1) {
    mask[index] = (bits[index >> 3] >> (index & 7)) & 1;
  }
  return mask;
}

function occupiedRuns(mask, width, height) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    let area = 0;
    let x1 = width;
    let x2 = -1;
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      area += 1;
      x1 = Math.min(x1, x);
      x2 = Math.max(x2, x);
    }
    if (area) rows.push({ area, x1, x2: x2 + 1, y });
  }
  const runs = [];
  for (const row of rows) {
    const previous = runs.at(-1);
    if (!previous || row.y > previous.y2) {
      runs.push({
        area: row.area,
        x1: row.x1,
        x2: row.x2,
        y1: row.y,
        y2: row.y + 1,
      });
      continue;
    }
    previous.area += row.area;
    previous.x1 = Math.min(previous.x1, row.x1);
    previous.x2 = Math.max(previous.x2, row.x2);
    previous.y2 = row.y + 1;
  }
  return runs.map((run, index) => ({
    ...run,
    gapAfter: index + 1 < runs.length ? runs[index + 1].y1 - run.y2 : null,
  }));
}

function maskBox(mask, width, height) {
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

for (const input of process.argv.slice(2)) {
  for (const name of fs
    .readdirSync(input)
    .filter((value) => /^P\d+\.json$/.test(value))
    .sort()) {
    const record = JSON.parse(fs.readFileSync(path.join(input, name), "utf8"));
    record.detections.forEach((detection, index) => {
      if (detection.label !== "text" || !detection.mask) return;
      const mask = unpackMask(detection.mask);
      const box = maskBox(mask, detection.mask.width, detection.mask.height);
      if (!box) return;
      const width = box[2] - box[0];
      const height = box[3] - box[1];
      if (
        height / detection.mask.height < 0.4 ||
        height / Math.max(1, width) < 12
      )
        return;
      const id = `T${String(index + 1).padStart(3, "0")}`;
      process.stdout.write(
        `${JSON.stringify({
          capture: path.basename(path.dirname(path.join(input, name))),
          pageId: record.pageId,
          id,
          score: detection.score,
          box,
          runs: occupiedRuns(mask, detection.mask.width, detection.mask.height),
        })}\n`,
      );
    });
  }
}
