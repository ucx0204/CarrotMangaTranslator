#!/usr/bin/env node
/* eslint-disable -- fixed user-gold experiment evaluator */
// @ts-nocheck -- isolated laboratory evaluator, not production code.
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

function parseArgs(argv) {
  const args = { candidate: null, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--candidate") args.candidate = path.resolve(argv[++index]);
    else if (value === "--output") args.output = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!args.candidate || !args.output) {
    throw new Error("--candidate DIR and --output FILE are required.");
  }
  return args;
}

const separate = (id, pageId, left, right, note) => ({
  id,
  pageId,
  kind: "separate",
  groups: [left, right],
  note,
});
const merge = (id, pageId, left, right, note) => ({
  id,
  pageId,
  kind: "merge",
  groups: [left, right],
  note,
});

// Source detection ids are stable within the sealed Koharu captures. These
// constraints encode only direct user labels, never inferred OCR semantics.
const constraints = [
  separate("B1#1", "P013", ["T010"], ["T011"], "まだピン… / たとえば…"),
  separate("B1#2", "P015", ["T007"], ["T003"], "言葉だけ… / actor passage"),
  separate(
    "B1#3",
    "P019",
    ["T016"],
    ["T007"],
    "upper/lower blocks stay separate",
  ),
  separate("B1#6", "P032", ["T007"], ["T019"], "touching balloons"),
  separate("B1#7", "P033", ["T011"], ["T005"], "touching balloons"),
  separate("B1#8", "P033", ["T016"], ["T018"], "two clusters in D009"),
  separate("B1#9", "P034", ["T013"], ["T025"], "adjacent boxes"),
  separate("B1#10a", "P035", ["T008"], ["T010"], "upper oversized region"),
  separate("B1#10b", "P035", ["T006"], ["T011"], "lower oversized region"),
  separate("B2#1", "P038", ["T008"], ["T011"], "two narration blocks"),
  separate("B2#2", "P038", ["T028", "T032"], ["T036"], "出来た物から / 運べ"),
  separate(
    "B2#4",
    "P039",
    ["T016", "T017", "T018"],
    ["T015"],
    "touching balloons; repair cut",
  ),
  separate("B2#6a", "P041", ["T010"], ["T007"], "upper touching balloons"),
  separate("B2#6b", "P041", ["T011"], ["T012"], "lower merged clusters"),
  separate("B2#7", "P042", ["T014"], ["T018"], "two clusters in D001"),
  separate("B2#8a", "P042", ["T010"], ["T011"], "two clusters in D003"),
  separate("B2#8b", "P042", ["T016"], ["T017"], "two clusters in D004"),
  separate("B2#9", "P046", ["T002"], ["T012"], "right box must not intrude"),
  separate("B3#1", "P048", ["T001"], ["T002"], "two clusters in D007"),
  separate(
    "CORE-P055",
    "P055",
    ["T006"],
    ["T020"],
    "borrowed tail; touching balloons",
  ),
  separate("B3#2", "P056", ["T015"], ["T010"], "touching balloons"),
  separate("B3#3", "P058", ["T008"], ["T016"], "touching balloons"),
  separate("B3#4", "P059", ["T012"], ["T018"], "ルドルフ / 大変です"),
  separate("B3#5", "P059", ["T006"], ["T008"], "separate and repair boundary"),
  separate("B3#6", "P061", ["T016"], ["T020"], "two clusters in D010"),
  separate("B3#7", "P062", ["T013"], ["T011"], "touching balloons"),
  separate("B3#8", "P065", ["T011"], ["T013"], "touching balloons"),
  separate("B3#9", "P065", ["T012"], ["T015"], "touching balloons"),
  separate("B3#10a", "P066", ["T008"], ["T015"], "undo former v0.8 rejoin"),
  separate("B3#10b", "P066", ["T016"], ["T009"], "おい / 睨んでるぞ"),
  separate("B4#1", "P069", ["T015"], ["T016"], "それも / ラスボス"),
  separate("B4#2", "P070", ["T019"], ["T035"], "undo former v0.8 rejoin"),
  separate("B4#3", "P070", ["T037"], ["T036"], "ま… / まて"),
  separate("B4#4", "P071", ["T005"], ["T008"], "touching balloons"),
  separate("B4#5", "P072", ["T016"], ["T012"], "彼女 / リズベット"),
  separate("B4#6", "P074", ["T012"], ["T009"], "touching balloons"),
  separate("B4#7", "P076", ["T001"], ["T010"], "two clusters in D004"),
  separate("B4#8", "P077", ["T002"], ["T010"], "touching balloons"),
  separate("B4#9", "P078", ["T016"], ["T018"], "undo former v0.8 rejoin"),
  separate("B4#10", "P080", ["T003"], ["T006"], "touching balloons"),
  merge(
    "B5#1",
    "P081",
    ["T023"],
    ["T024", "T025"],
    "single utterance; repair geometry",
  ),
  separate("B5#2", "P081", ["T002"], ["T013"], "touching balloons"),
  separate("B5#3", "P083", ["T010"], ["T007"], "touching balloons"),
  separate("B5#4", "P084", ["T013"], ["T010"], "touching balloons"),
  separate("B5#5", "P085", ["T014"], ["T011"], "touching balloons"),
  separate("B5#6", "P090", ["T017"], ["T010"], "touching balloons"),
  separate("B5#7", "P091", ["T012"], ["T019"], "あれ? / 地下に…"),
  separate("B5#8", "P091", ["T009"], ["T007"], "touching balloons"),
  separate("B5#9", "P091", ["T006"], ["T008"], "model separation"),
];

const manualGeometryTargets = [
  "P019/D006 lower extent",
  "P030/D001 page-spanning extent",
  "P034/D001+D002 local edges",
  "P038/D008+D011 local edges",
  "P039/D001+D002 glyph-cut boundary",
  "P040/D001 lower extent",
  "P046/D002+D003 mutual boundary",
  "P059/D006+D008 mutual boundary",
];

function manifestPath(root, pageId) {
  const direct = path.join(root, "pages", pageId, "hayai-regions.json");
  const nested = path.join(root, "pages", pageId, "ocr", "hayai-regions.json");
  if (fs.existsSync(direct)) return direct;
  if (fs.existsSync(nested)) return nested;
  throw new Error(`Missing Hayai manifest for ${pageId} under ${root}`);
}

function evaluateConstraint(constraint, regions) {
  const sources = regions.map((region) => new Set(region.sourceDetectionIds));
  const expected = new Set(constraint.groups.flat());
  const found = new Set(
    regions.flatMap((region) =>
      region.sourceDetectionIds.filter((id) => expected.has(id)),
    ),
  );
  const missing = [...expected].filter((id) => !found.has(id));
  if (missing.length > 0) {
    return { ...constraint, pass: false, missing, matchedRegions: [] };
  }
  if (constraint.kind === "merge") {
    const matchedRegions = regions
      .filter((region) =>
        [...expected].every((id) => region.sourceDetectionIds.includes(id)),
      )
      .map((region) => region.regionId);
    return {
      ...constraint,
      pass: matchedRegions.length === 1,
      missing,
      matchedRegions,
    };
  }
  const [left, right] = constraint.groups;
  const collisions = regions
    .filter((region, index) => {
      const ids = sources[index];
      return left.some((id) => ids.has(id)) && right.some((id) => ids.has(id));
    })
    .map((region) => region.regionId);
  return {
    ...constraint,
    pass: collisions.length === 0,
    missing,
    matchedRegions: collisions,
  };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const byPage = new Map();
  for (const constraint of constraints) {
    byPage.set(constraint.pageId, [
      ...(byPage.get(constraint.pageId) ?? []),
      constraint,
    ]);
  }
  const results = [];
  for (const [pageId, pageConstraints] of byPage) {
    const manifest = JSON.parse(
      await fsp.readFile(manifestPath(args.candidate, pageId), "utf8"),
    );
    for (const constraint of pageConstraints) {
      results.push(evaluateConstraint(constraint, manifest.dialogueRegions));
    }
  }
  const hardPassCount = results.filter((item) => item.pass).length;
  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    candidate: args.candidate,
    summary: {
      hardConstraintCount: results.length,
      hardPassCount,
      hardFailCount: results.length - hardPassCount,
      separateCount: results.filter((item) => item.kind === "separate").length,
      separatePassCount: results.filter(
        (item) => item.kind === "separate" && item.pass,
      ).length,
      mergeCount: results.filter((item) => item.kind === "merge").length,
      mergePassCount: results.filter(
        (item) => item.kind === "merge" && item.pass,
      ).length,
      missingSourceCount: results.reduce(
        (sum, item) => sum + item.missing.length,
        0,
      ),
      manualGeometryTargetCount: manualGeometryTargets.length,
    },
    failures: results.filter((item) => !item.pass),
    results,
    manualGeometryTargets,
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
