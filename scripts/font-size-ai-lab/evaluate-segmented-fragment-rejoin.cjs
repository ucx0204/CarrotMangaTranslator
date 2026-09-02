#!/usr/bin/env node
/* eslint-disable -- sealed laboratory comparison across captured app outputs */
// @ts-nocheck -- isolated audit utility; production types remain checked.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../..");
const campaignRoot = path.join(
  repoRoot,
  "artifacts",
  "font-size-ai-lab",
  "campaign-006",
);
const roots = {
  baseline: path.join(campaignRoot, "exp-01-v0.5.0-baseline"),
  naive: path.join(campaignRoot, "exp-02-fragment-rejoin", "actual"),
  segmented: path.join(
    campaignRoot,
    "exp-03-segmented-fragment-rejoin",
    "actual",
  ),
  regression: path.join(
    campaignRoot,
    "exp-03-segmented-fragment-rejoin",
    "campaign-001-regression",
  ),
};

const fragmentSpecs = [
  { pageId: "P005", oldRegionIds: ["D004", "D005"] },
  { pageId: "P009", oldRegionIds: ["D011", "D012"] },
  { pageId: "P011", oldRegionIds: ["D010", "D012"] },
];

function parseArgs(argv) {
  let output = path.join(
    campaignRoot,
    "exp-03-segmented-fragment-rejoin",
    "evaluation.json",
  );
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--output") output = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  return { output };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function pageBundle(root, pageId) {
  const pageRoot = path.join(root, "pages", pageId);
  return {
    manifest: readJson(path.join(pageRoot, "ocr", "hayai-regions.json")),
    hints: readJson(path.join(pageRoot, "ocr", "ocr-bbox-hints.json")),
    page: readJson(path.join(pageRoot, "page.json")),
  };
}

function regionRecord(bundle, region) {
  const hint = bundle.hints.items.find((item) => item.id === region.id);
  const candidate = bundle.page.candidates.find(
    (item) => item.hintId === region.id,
  );
  if (!hint || !candidate) {
    throw new Error(
      `Missing hint/candidate for ${bundle.page.pageId}/${region.regionId}`,
    );
  }
  return {
    bbox: region.bbox,
    candidateId: candidate.candidateId,
    estimate: candidate.estimate,
    ocrText: hint.ocrText,
    regionId: region.regionId,
    recognitionBboxes: region.recognitionBboxes ?? [],
    sourceDetectionIds: region.sourceDetectionIds,
  };
}

function signature(region) {
  return [...region.sourceDetectionIds].sort().join("+");
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function evaluateFragment(spec) {
  const baseline = pageBundle(roots.baseline, spec.pageId);
  const naive = pageBundle(roots.naive, spec.pageId);
  const segmented = pageBundle(roots.segmented, spec.pageId);
  const oldRegions = spec.oldRegionIds.map((regionId) => {
    const region = baseline.manifest.dialogueRegions.find(
      (item) => item.regionId === regionId,
    );
    requireCondition(region, `Missing baseline ${spec.pageId}/${regionId}`);
    return region;
  });
  const sourceIds = oldRegions.flatMap((region) => region.sourceDetectionIds);
  const sourceSignature = [...sourceIds].sort().join("+");
  const findMerged = (bundle) =>
    bundle.manifest.dialogueRegions.find(
      (region) => signature(region) === sourceSignature,
    );
  const naiveRegion = findMerged(naive);
  const segmentedRegion = findMerged(segmented);
  requireCondition(naiveRegion, `Missing naive merge on ${spec.pageId}`);
  requireCondition(
    segmentedRegion,
    `Missing segmented merge on ${spec.pageId}`,
  );
  const old = oldRegions.map((region) => regionRecord(baseline, region));
  const naiveRecord = regionRecord(naive, naiveRegion);
  const segmentedRecord = regionRecord(segmented, segmentedRegion);
  const expectedText = old.map((item) => item.ocrText).join("");
  const expectedRecognitionBboxes = old.map((item) => item.bbox);
  requireCondition(
    same(segmentedRecord.recognitionBboxes, expectedRecognitionBboxes),
    `Recognition bbox order mismatch on ${spec.pageId}`,
  );
  requireCondition(
    segmentedRecord.ocrText === expectedText,
    `Segmented OCR mismatch on ${spec.pageId}`,
  );
  return {
    pageId: spec.pageId,
    old,
    expectedText,
    naive: {
      ...naiveRecord,
      exactText: naiveRecord.ocrText === expectedText,
    },
    segmented: {
      ...segmentedRecord,
      exactText: true,
    },
  };
}

function evaluateUnchanged(fragmentResults) {
  const consumedByPage = new Map(
    fragmentResults.map((result) => [
      result.pageId,
      new Set(result.old.flatMap((item) => item.sourceDetectionIds)),
    ]),
  );
  const mismatches = [];
  let matched = 0;
  for (let page = 1; page <= 18; page += 1) {
    const pageId = `P${String(page).padStart(3, "0")}`;
    const consumed = consumedByPage.get(pageId) ?? new Set();
    const baseline = pageBundle(roots.baseline, pageId);
    const segmented = pageBundle(roots.segmented, pageId);
    for (const oldRegion of baseline.manifest.dialogueRegions) {
      if (oldRegion.sourceDetectionIds.some((id) => consumed.has(id))) continue;
      const nextRegion = segmented.manifest.dialogueRegions.find(
        (region) => signature(region) === signature(oldRegion),
      );
      if (!nextRegion) {
        mismatches.push({
          pageId,
          signature: signature(oldRegion),
          kind: "missing",
        });
        continue;
      }
      matched += 1;
      const before = regionRecord(baseline, oldRegion);
      const after = regionRecord(segmented, nextRegion);
      if (
        !same(before.bbox, after.bbox) ||
        before.ocrText !== after.ocrText ||
        !same(before.estimate, after.estimate)
      ) {
        mismatches.push({
          pageId,
          signature: signature(oldRegion),
          before,
          after,
        });
      }
    }
  }
  return { matched, mismatches };
}

function evaluateRegression() {
  const evaluation = readJson(
    path.join(roots.regression, "geometry-evaluation.json"),
  );
  const changed = evaluation.pages.flatMap((page) => {
    const manifest = readJson(
      path.join(roots.regression, "pages", page.pageId, "hayai-regions.json"),
    );
    return manifest.dialogueRegions
      .filter((region) => Array.isArray(region.recognitionBboxes))
      .map((region) => ({
        pageId: page.pageId,
        regionId: region.regionId,
        bbox: region.bbox,
        recognitionBboxes: region.recognitionBboxes,
        sourceDetectionIds: region.sourceDetectionIds,
      }));
  });
  return {
    pageCount: evaluation.pages.length,
    fragmentMergeCount: changed.length,
    changed,
  };
}

function main() {
  const { output } = parseArgs(process.argv.slice(2));
  const fragments = fragmentSpecs.map(evaluateFragment);
  const unchanged = evaluateUnchanged(fragments);
  const regression = evaluateRegression();
  requireCondition(
    unchanged.mismatches.length === 0,
    "Unchanged output drifted.",
  );
  requireCondition(
    regression.fragmentMergeCount === 1,
    "Unexpected prior merge count.",
  );
  const baselineReport = readJson(
    path.join(roots.baseline, "baseline-report.json"),
  );
  const segmentedReport = readJson(
    path.join(roots.segmented, "baseline-report.json"),
  );
  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    experiment: "segmented-same-balloon-fragment-rejoin",
    summary: {
      pageCount: segmentedReport.summary.pageCount,
      baselineDialogueCount: baselineReport.summary.dialogueCount,
      segmentedDialogueCount: segmentedReport.summary.dialogueCount,
      logicalFragmentMerges: fragments.length,
      segmentedOcrExactCount: fragments.filter(
        (item) => item.segmented.exactText,
      ).length,
      naiveUnionOcrExactCount: fragments.filter((item) => item.naive.exactText)
        .length,
      unchangedLogicalRegionCount: unchanged.matched,
      unchangedMismatchCount: unchanged.mismatches.length,
      priorCapturedPageCount: regression.pageCount,
      priorFragmentMergeCount: regression.fragmentMergeCount,
    },
    fragments,
    unchanged,
    regression,
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(payload.summary, null, 2));
}

main();
