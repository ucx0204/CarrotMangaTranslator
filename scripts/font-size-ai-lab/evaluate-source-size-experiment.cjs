#!/usr/bin/env node
/* eslint-disable -- isolated experiment/audit utility, not a production module */
// @ts-nocheck -- isolated experiment/audit utility; production types remain checked.
"use strict";

/**
 * Re-run the compiled production source-size estimator over a sealed baseline
 * chapter and score the manually locked same-font and small-text sentinels.
 *
 * This evaluator deliberately does not invent absolute pixel gold. Its primary
 * score is within-group disagreement for crops judged to share a visual font;
 * the two genuinely-small sentinels prevent a global-minimum pseudo-fix.
 */

const fsp = require("node:fs/promises");
const path = require("node:path");
const { app, nativeImage } = require("electron");

function parseArgs(argv) {
  const args = {
    audit: path.resolve(
      "artifacts/font-size-ai-lab/campaign-001/exp-01-production-baseline/visual-audit.json",
    ),
    label: "unnamed",
    output: null,
    report: path.resolve(
      "artifacts/font-size-ai-lab/campaign-001/exp-01-production-baseline/baseline-report.json",
    ),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--audit") args.audit = path.resolve(argv[++index]);
    else if (value === "--label") args.label = String(argv[++index]);
    else if (value === "--output") args.output = path.resolve(argv[++index]);
    else if (value === "--report") args.report = path.resolve(argv[++index]);
    else if (value === "--help") {
      console.log(
        "Usage: electron scripts/font-size-ai-lab/evaluate-source-size-experiment.cjs " +
          "--label NAME --output PATH [--report PATH] [--audit PATH]",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${value}`);
  }
  if (!args.output) throw new Error("--output is required.");
  return args;
}

async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

function loadRaster(imagePath) {
  const image = nativeImage.createFromPath(imagePath);
  if (image.isEmpty()) throw new Error(`Could not decode image: ${imagePath}`);
  const { width, height } = image.getSize();
  return { bgra: Uint8Array.from(image.toBitmap()), height, width };
}

function normalizeBbox(bbox, page) {
  const x = Number(bbox.x ?? bbox.x1);
  const y = Number(bbox.y ?? bbox.y1);
  const w = Number(bbox.w ?? Number(bbox.x2) - x);
  const h = Number(bbox.h ?? Number(bbox.y2) - y);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
    throw new Error(`Invalid bbox: ${JSON.stringify(bbox)}`);
  }
  return {
    h: (h / page.height) * 1_000,
    w: (w / page.width) * 1_000,
    x: (x / page.width) * 1_000,
    y: (y / page.height) * 1_000,
  };
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mean(values) {
  return values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : 0;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function pairwiseAbsLogRatios(values) {
  const ratios = [];
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      ratios.push(Math.abs(Math.log(values[left] / values[right])));
    }
  }
  return ratios;
}

function candidateKey(pageId, candidateId) {
  return `${pageId}/${candidateId}`;
}

function scoreSameFontGroup(group, predictions) {
  const members = group.candidateIds.map((candidateId) => {
    const prediction = predictions.get(candidateKey(group.pageId, candidateId));
    return {
      candidateId,
      confidence: prediction?.estimate?.confidence ?? null,
      facePx: prediction?.estimate?.facePx ?? null,
    };
  });
  const faces = members
    .map((member) => member.facePx)
    .filter((value) => Number.isFinite(value));
  const missingCount = members.length - faces.length;
  const pairwise = pairwiseAbsLogRatios(faces);
  const disagreement = pairwise.length ? mean(pairwise) : 0;
  const missingPenalty = (missingCount / members.length) * 0.45;
  return {
    id: group.id,
    pageId: group.pageId,
    members,
    coverage: round(faces.length / members.length),
    disagreementAbsLog: round(disagreement),
    maxMinRatio:
      faces.length >= 2 ? round(Math.max(...faces) / Math.min(...faces)) : null,
    medianFacePx: round(median(faces)),
    missingCount,
    score: round(disagreement + missingPenalty),
  };
}

function scoreSmallSentinel(sentinel, predictions) {
  const prediction = predictions.get(
    candidateKey(sentinel.pageId, sentinel.candidateId),
  );
  const facePx = prediction?.estimate?.facePx ?? null;
  const ratioToBaseline = Number.isFinite(facePx)
    ? facePx / sentinel.baselineFacePx
    : null;
  return {
    pageId: sentinel.pageId,
    candidateId: sentinel.candidateId,
    baselineFacePx: sentinel.baselineFacePx,
    facePx: round(facePx),
    ratioToBaseline: round(ratioToBaseline),
    regressionPenalty:
      ratioToBaseline === null ? 0 : round(Math.max(0, ratioToBaseline - 1.15)),
  };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const [report, audit] = await Promise.all([
    readJson(args.report),
    readJson(args.audit),
  ]);
  const { estimateSourceFontSizeForItem } = require(
    path.resolve("out/main/pipeline/sourceFontSizeEstimator.js"),
  );
  const predictions = new Map();
  let dialogueCount = 0;
  let estimatedCount = 0;
  for (const page of report.pages) {
    const raster = loadRaster(page.imagePath);
    if (raster.width !== page.width || raster.height !== page.height) {
      throw new Error(`Raster dimensions changed for ${page.pageId}.`);
    }
    for (const candidate of page.candidates) {
      dialogueCount += 1;
      const item = {
        angle: 0,
        bbox: normalizeBbox(candidate.bbox, page),
        direction: candidate.direction,
        id: Number(candidate.hintId ?? dialogueCount),
        jp: candidate.sourceText,
        sourceText: candidate.sourceText,
        textRole: "ordinary",
      };
      const estimate = estimateSourceFontSizeForItem(raster, item);
      if (estimate) estimatedCount += 1;
      predictions.set(candidateKey(page.pageId, candidate.candidateId), {
        candidateId: candidate.candidateId,
        direction: candidate.direction,
        estimate: estimate
          ? {
              confidence: round(estimate.confidence),
              facePx: round(estimate.facePx),
              method: estimate.method,
            }
          : null,
        pageId: page.pageId,
        sourceText: candidate.sourceText,
      });
    }
  }
  const sameFontGroups = audit.sameVisualFontGroups.map((group) =>
    scoreSameFontGroup(group, predictions),
  );
  const smallSentinels = audit.hierarchyMustRemainSmall.map((sentinel) =>
    scoreSmallSentinel(sentinel, predictions),
  );
  const summary = {
    abstainedCount: dialogueCount - estimatedCount,
    dialogueCount,
    estimatedCount,
    coverage: round(estimatedCount / dialogueCount),
    sameFontGroupScore: round(mean(sameFontGroups.map((group) => group.score))),
    sameFontMeanDisagreementAbsLog: round(
      mean(sameFontGroups.map((group) => group.disagreementAbsLog)),
    ),
    sameFontMeanCoverage: round(
      mean(sameFontGroups.map((group) => group.coverage)),
    ),
    smallTextRegressionPenalty: round(
      mean(smallSentinels.map((sentinel) => sentinel.regressionPenalty)),
    ),
  };
  const output = {
    schemaVersion: 1,
    experimentLabel: args.label,
    createdAt: new Date().toISOString(),
    sourceReport: path
      .relative(process.cwd(), args.report)
      .replaceAll("\\", "/"),
    sourceAudit: path.relative(process.cwd(), args.audit).replaceAll("\\", "/"),
    scoreDirection:
      "lower sameFontGroupScore is better; smallTextRegressionPenalty must stay zero",
    summary,
    sameFontGroups,
    smallSentinels,
    predictions: [...predictions.values()],
  };
  await fsp.mkdir(path.dirname(args.output), { recursive: true });
  await fsp.writeFile(
    args.output,
    `${JSON.stringify(output, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `${JSON.stringify({ output: args.output, summary }, null, 2)}\n`,
  );
}

app
  .whenReady()
  .then(run)
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error?.stack || error);
    app.exit(1);
  });
