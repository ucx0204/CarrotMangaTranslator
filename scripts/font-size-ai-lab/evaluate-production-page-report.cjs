#!/usr/bin/env node
/* eslint-disable -- isolated experiment evaluator */
// @ts-nocheck -- audit artifact generator; production code remains checked.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

function parseArgs(argv) {
  const args = {
    audit: null,
    baseline: null,
    candidate: null,
    expected: null,
    output: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--audit") args.audit = path.resolve(argv[++index]);
    else if (value === "--baseline")
      args.baseline = path.resolve(argv[++index]);
    else if (value === "--candidate")
      args.candidate = path.resolve(argv[++index]);
    else if (value === "--expected")
      args.expected = path.resolve(argv[++index]);
    else if (value === "--output") args.output = path.resolve(argv[++index]);
    else if (value === "--help") {
      console.log(
        "Usage: node scripts/font-size-ai-lab/evaluate-production-page-report.cjs " +
          "--baseline PATH --candidate PATH --audit PATH --expected PATH --output PATH",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${value}`);
  }
  for (const key of Object.keys(args)) {
    if (!args[key]) throw new Error(`--${key} is required.`);
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function key(pageId, candidateId) {
  return `${pageId}/${candidateId}`;
}

function reportMap(report) {
  return new Map(
    report.pages.flatMap((page) =>
      page.candidates.map((candidate) => [
        key(page.pageId, candidate.candidateId),
        { ...candidate, pageId: page.pageId },
      ]),
    ),
  );
}

function predictionMap(report) {
  return new Map(
    [...reportMap(report)].flatMap(([id, candidate]) =>
      candidate.estimate ? [[id, candidate.estimate]] : [],
    ),
  );
}

function expectedMap(evaluation) {
  return new Map(
    evaluation.predictions.map((prediction) => [
      prediction.key,
      prediction.selected,
    ]),
  );
}

function scoreGroup(group, predictions) {
  const values = group.candidateIds.flatMap((candidateId) => {
    const prediction = predictions.get(key(group.pageId, candidateId));
    return prediction ? [prediction.facePx] : [];
  });
  const pairwise = [];
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      pairwise.push(Math.abs(Math.log(values[left] / values[right])));
    }
  }
  const missing = group.candidateIds.length - values.length;
  const disagreement = mean(pairwise);
  return {
    coverage: round(values.length / group.candidateIds.length),
    disagreementAbsLog: round(disagreement),
    id: group.id,
    missingCount: missing,
    score: round(disagreement + (missing / group.candidateIds.length) * 0.45),
  };
}

function scoreSentinel(sentinel, predictions, kind) {
  const prediction = predictions.get(
    key(sentinel.pageId, sentinel.candidateId),
  );
  const ratio = prediction ? prediction.facePx / sentinel.baselineFacePx : null;
  return {
    baselineFacePx: sentinel.baselineFacePx,
    candidateId: sentinel.candidateId,
    facePx: round(prediction?.facePx),
    pageId: sentinel.pageId,
    regressionPenalty:
      ratio === null
        ? 0
        : round(
            kind === "small"
              ? Math.max(0, ratio - 1.15)
              : Math.max(0, 0.85 - ratio),
          ),
  };
}

function summarizeScores(audit, predictions) {
  const groups = audit.sameVisualFontGroups.map((group) =>
    scoreGroup(group, predictions),
  );
  const smallSentinels = audit.hierarchyMustRemainSmall.map((sentinel) =>
    scoreSentinel(sentinel, predictions, "small"),
  );
  const largeSentinels = (audit.hierarchyMustRemainLarge ?? []).map(
    (sentinel) => scoreSentinel(sentinel, predictions, "large"),
  );
  return {
    groups,
    largeSentinels,
    smallSentinels,
    summary: {
      hierarchyRegressionPenalty: round(
        mean(
          [...smallSentinels, ...largeSentinels].map(
            (sentinel) => sentinel.regressionPenalty,
          ),
        ),
      ),
      sameFontGroupScore: round(mean(groups.map((group) => group.score))),
      sameFontMeanCoverage: round(mean(groups.map((group) => group.coverage))),
    },
  };
}

function sha256(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function evidenceMismatches(baseline, candidate, baselinePath, candidatePath) {
  const before = reportMap(baseline);
  const after = reportMap(candidate);
  return [...before].flatMap(([id, left]) => {
    const right = after.get(id);
    const matches =
      right &&
      left.sourceText === right.sourceText &&
      JSON.stringify(left.bbox) === JSON.stringify(right.bbox) &&
      sha256(path.join(path.dirname(baselinePath), left.cropPath)) ===
        sha256(path.join(path.dirname(candidatePath), right.cropPath));
    return matches ? [] : [id];
  });
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const baseline = readJson(args.baseline);
  const candidate = readJson(args.candidate);
  const audit = readJson(args.audit);
  const expected = readJson(args.expected);
  const before = predictionMap(baseline);
  const after = predictionMap(candidate);
  const expectedPredictions = expectedMap(expected);
  const changed = [...after].flatMap(([id, selected]) => {
    const original = before.get(id);
    if (
      !original ||
      Math.abs(Math.log(selected.facePx / original.facePx)) < Math.log(1.01)
    ) {
      return [];
    }
    const record = reportMap(candidate).get(id);
    return [
      {
        id,
        before: original,
        after: selected,
        sourceText: record?.sourceText ?? "",
      },
    ];
  });
  const expectedMismatches = [...after].flatMap(([id, selected]) => {
    const predicted = expectedPredictions.get(id);
    return predicted && Math.abs(predicted.facePx - selected.facePx) <= 0.0001
      ? []
      : [
          {
            id,
            expectedFacePx: round(predicted?.facePx),
            actualFacePx: round(selected.facePx),
          },
        ];
  });
  const sourceEvidenceMismatches = evidenceMismatches(
    baseline,
    candidate,
    args.baseline,
    args.candidate,
  );
  const baselineScores = summarizeScores(audit, before);
  const candidateScores = summarizeScores(audit, after);
  const output = {
    schemaVersion: 1,
    experiment: "campaign-003-exp-04-production-page-peer-gated",
    createdAt: new Date().toISOString(),
    summary: {
      candidateCount: reportMap(candidate).size,
      baselineEstimated: before.size,
      estimated: after.size,
      changedCount: changed.length,
      baselineSameFontGroupScore: baselineScores.summary.sameFontGroupScore,
      sameFontGroupScore: candidateScores.summary.sameFontGroupScore,
      baselineHierarchyRegressionPenalty:
        baselineScores.summary.hierarchyRegressionPenalty,
      hierarchyRegressionPenalty:
        candidateScores.summary.hierarchyRegressionPenalty,
      expectedPredictionMismatchCount: expectedMismatches.length,
      sourceEvidenceMismatchCount: sourceEvidenceMismatches.length,
    },
    changed,
    targetFindings: (audit.fontSizeFindings ?? []).map((finding) => ({
      pageId: finding.pageId,
      candidateId: finding.candidateId,
      baselineFacePx: round(
        before.get(key(finding.pageId, finding.candidateId))?.facePx,
      ),
      facePx: round(
        after.get(key(finding.pageId, finding.candidateId))?.facePx,
      ),
      severity: finding.severity,
    })),
    expectedMismatches,
    sourceEvidenceMismatches,
    baselineScores,
    candidateScores,
  };
  await fsp.writeFile(
    args.output,
    `${JSON.stringify(output, null, 2)}\n`,
    "utf8",
  );
  console.log(JSON.stringify({ output: args.output, ...output.summary }));
}

function mean(values) {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
