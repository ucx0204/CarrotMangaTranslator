#!/usr/bin/env node
/* eslint-disable -- isolated experiment/audit utility, not a production module */
// @ts-nocheck -- laboratory artifact generator; production types remain checked.
"use strict";

/**
 * Campaign 005 narrow-vertical line-count recovery preflight.
 *
 * Predictions are sealed before the visual audit is opened. The recovered
 * face is the geometric mean of one candidate-owned projection and its
 * writing-axis pitch. Page peers are an acceptance gate only and are never
 * copied into the result.
 */

const fsp = require("node:fs/promises");
const path = require("node:path");

const SOURCE_FACE_SCALE = 1.02;
const MINIMUM_GLYPHS = 8;
const MAXIMUM_GLYPHS = 48;
const MINIMUM_VERTICAL_ASPECT_RATIO = 2.5;
const MINIMUM_FORMULA_LINE_COUNT = 2;
const MAXIMUM_FORMULA_LINE_COUNT = 4;
const MAXIMUM_BASELINE_CONFIDENCE = 0.75;
const MINIMUM_PROJECTION_CONFIDENCE = 0.8;
const MINIMUM_MAJOR_CONFIDENCE = 0.69;
const MAXIMUM_PROJECTION_MAJOR_RATIO = 1.1;
const MINIMUM_CONNECTED_MASS_SHARE = 0.9;
const MINIMUM_CONNECTED_COLUMN_RATIO = 1.35;
const MAXIMUM_CONNECTED_COLUMN_RATIO = 2.05;
const MINIMUM_UPWARD_RATIO = 1.3;
const MAXIMUM_UPWARD_RATIO = 1.7;
const MINIMUM_PEER_CONFIDENCE = 0.65;
const MINIMUM_PEER_GLYPHS = 4;
const MINIMUM_SUPPORTING_PEERS = 2;
const MAXIMUM_SUPPORTING_PEER_RATIO = 1.35;
const MINIMUM_PROPOSAL_TO_PEER_CENTER_RATIO = 0.75;
const MAXIMUM_PROPOSAL_TO_PEER_CENTER_RATIO = 1.2;

function parseArgs(argv) {
  const args = {
    audit: null,
    baselineEvaluation: null,
    candidates: null,
    output: null,
    report: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--audit") args.audit = path.resolve(argv[++index]);
    else if (value === "--baseline-evaluation")
      args.baselineEvaluation = path.resolve(argv[++index]);
    else if (value === "--candidates")
      args.candidates = path.resolve(argv[++index]);
    else if (value === "--output") args.output = path.resolve(argv[++index]);
    else if (value === "--report") args.report = path.resolve(argv[++index]);
    else if (value === "--help") {
      console.log(
        "Usage: node scripts/font-size-ai-lab/evaluate-narrow-vertical-line-recovery.cjs " +
          "--candidates PATH --report PATH --audit PATH --output PATH " +
          "[--baseline-evaluation PATH]",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${value}`);
  }
  if (!args.audit || !args.candidates || !args.output || !args.report) {
    throw new Error(
      "--candidates, --report, --audit and --output are required.",
    );
  }
  return args;
}

function candidateKey(pageId, candidateId) {
  return `${pageId}/${candidateId}`;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function mean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function valueRatio(first, second) {
  return Math.max(first / Math.max(1, second), second / Math.max(1, first));
}

function visibleGlyphCount(value) {
  return Array.from(String(value ?? "")).filter(
    (grapheme) => !/^\s$/u.test(grapheme),
  ).length;
}

function semanticGlyphCount(value) {
  return Array.from(String(value ?? "")).filter((grapheme) =>
    /[\p{L}\p{N}]/u.test(grapheme),
  ).length;
}

function reportPredictions(report) {
  return new Map(
    report.pages.flatMap((page) =>
      page.candidates.flatMap((candidate) =>
        candidate.estimate
          ? [
              [
                candidateKey(page.pageId, candidate.candidateId),
                {
                  confidence: candidate.estimate.confidence,
                  facePx: candidate.estimate.facePx,
                  reason: "production-v0.4.0-baseline",
                },
              ],
            ]
          : [],
      ),
    ),
  );
}

function evaluationPredictions(evaluation) {
  return new Map(
    (evaluation.predictions ?? []).map((prediction) => [
      prediction.key,
      prediction.selected,
    ]),
  );
}

function buildPageCandidates(candidates) {
  const pages = new Map();
  for (const candidate of candidates) {
    const members = pages.get(candidate.pageId) ?? [];
    members.push(candidate);
    pages.set(candidate.pageId, members);
  }
  return pages;
}

function supportingPeers(candidate, proposal, pageCandidates) {
  return pageCandidates
    .filter((peer) => peer.candidateId !== candidate.candidateId)
    .flatMap((peer) => {
      if (
        !peer.baseline ||
        peer.baseline.confidence < MINIMUM_PEER_CONFIDENCE ||
        peer.glyphCount < MINIMUM_PEER_GLYPHS ||
        semanticGlyphCount(peer.sourceText) < 2 ||
        peer.baseline.facePx < 6 ||
        peer.baseline.facePx > 96 ||
        valueRatio(peer.baseline.facePx, proposal) >
          MAXIMUM_SUPPORTING_PEER_RATIO
      ) {
        return [];
      }
      return [peer];
    });
}

function selectRecovery(candidate, pageCandidates) {
  if (
    !candidate.baseline ||
    candidate.direction !== "vertical" ||
    candidate.glyphCount < MINIMUM_GLYPHS ||
    candidate.glyphCount > MAXIMUM_GLYPHS ||
    candidate.major / Math.max(1, candidate.cross) <
      MINIMUM_VERTICAL_ASPECT_RATIO ||
    candidate.formulaLineCount < MINIMUM_FORMULA_LINE_COUNT ||
    candidate.formulaLineCount > MAXIMUM_FORMULA_LINE_COUNT ||
    candidate.baseline.confidence >= MAXIMUM_BASELINE_CONFIDENCE
  ) {
    return null;
  }
  const alternativeLineCount = candidate.formulaLineCount - 1;
  const trial = candidate.trials.find(
    (entry) => entry.lineCount === alternativeLineCount,
  );
  if (
    !trial?.estimate ||
    trial.estimate.confidence < MINIMUM_PROJECTION_CONFIDENCE ||
    !trial.majorPitch ||
    trial.majorPitch.confidence < MINIMUM_MAJOR_CONFIDENCE ||
    !trial.component ||
    trial.component.primaryMassShare < MINIMUM_CONNECTED_MASS_SHARE
  ) {
    return null;
  }
  const projectionFace = trial.estimate.facePx;
  const majorFace = trial.majorPitch.face * SOURCE_FACE_SCALE;
  if (valueRatio(projectionFace, majorFace) > MAXIMUM_PROJECTION_MAJOR_RATIO) {
    return null;
  }
  const proposal = Math.sqrt(projectionFace * majorFace);
  const connectedFace = trial.component.primaryFace * SOURCE_FACE_SCALE;
  const connectedColumnRatio = connectedFace / Math.max(1, proposal);
  const upwardRatio = proposal / candidate.baseline.facePx;
  if (
    connectedColumnRatio < MINIMUM_CONNECTED_COLUMN_RATIO ||
    connectedColumnRatio > MAXIMUM_CONNECTED_COLUMN_RATIO ||
    upwardRatio < MINIMUM_UPWARD_RATIO ||
    upwardRatio > MAXIMUM_UPWARD_RATIO
  ) {
    return null;
  }
  const peers = supportingPeers(candidate, proposal, pageCandidates);
  if (peers.length < MINIMUM_SUPPORTING_PEERS) return null;
  const peerCenter = median(peers.map((peer) => peer.baseline.facePx));
  const proposalToPeer = proposal / Math.max(1, Number(peerCenter));
  if (
    proposalToPeer < MINIMUM_PROPOSAL_TO_PEER_CENTER_RATIO ||
    proposalToPeer > MAXIMUM_PROPOSAL_TO_PEER_CENTER_RATIO
  ) {
    return null;
  }
  const geometryDisagreement = Math.abs(
    Math.log(projectionFace / Math.max(1, majorFace)),
  );
  return {
    confidence: Math.max(
      0.5,
      Math.min(
        0.9,
        Math.min(trial.estimate.confidence, trial.majorPitch.confidence) -
          geometryDisagreement * 0.12,
      ),
    ),
    evidence: {
      alternativeLineCount,
      connectedColumnRatio: round(connectedColumnRatio),
      connectedMassShare: round(trial.component.primaryMassShare),
      majorFace: round(majorFace),
      peerCenter: round(peerCenter),
      projectionFace: round(projectionFace),
      proposalToPeer: round(proposalToPeer),
      supportingPeerIds: peers.map((peer) => peer.candidateId),
      upwardRatio: round(upwardRatio),
    },
    facePx: proposal,
    reason: "peer-gated-projection-major-connected-column-recovery",
  };
}

function scoreGroup(group, predictions) {
  const values = group.candidateIds.flatMap((candidateId) => {
    const prediction = predictions.get(candidateKey(group.pageId, candidateId));
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

function scoreHierarchySentinel(sentinel, predictions, kind) {
  const selected = predictions.get(
    candidateKey(sentinel.pageId, sentinel.candidateId),
  );
  const ratioToBaseline = selected
    ? selected.facePx / sentinel.baselineFacePx
    : null;
  return {
    baselineFacePx: sentinel.baselineFacePx,
    candidateId: sentinel.candidateId,
    facePx: round(selected?.facePx),
    pageId: sentinel.pageId,
    regressionPenalty:
      ratioToBaseline === null
        ? 0
        : round(
            kind === "small"
              ? Math.max(0, ratioToBaseline - 1.15)
              : Math.max(0, 0.85 - ratioToBaseline),
          ),
  };
}

function summarizeScores(audit, predictions) {
  const groups = (audit.sameVisualFontGroups ?? []).map((group) =>
    scoreGroup(group, predictions),
  );
  const smallSentinels = (audit.hierarchyMustRemainSmall ?? []).map(
    (sentinel) => scoreHierarchySentinel(sentinel, predictions, "small"),
  );
  const largeSentinels = (audit.hierarchyMustRemainLarge ?? []).map(
    (sentinel) => scoreHierarchySentinel(sentinel, predictions, "large"),
  );
  return {
    groups,
    largeSentinels,
    smallSentinels,
    summary: {
      hierarchyRegressionPenalty: round(
        mean(
          [...smallSentinels, ...largeSentinels].map(
            (item) => item.regressionPenalty,
          ),
        ),
      ),
      sameFontGroupScore: round(mean(groups.map((group) => group.score))),
      sameFontMeanCoverage: round(mean(groups.map((group) => group.coverage))),
    },
  };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const [input, report, baselineEvaluation] = await Promise.all([
    fsp.readFile(args.candidates, "utf8").then(JSON.parse),
    fsp.readFile(args.report, "utf8").then(JSON.parse),
    args.baselineEvaluation
      ? fsp.readFile(args.baselineEvaluation, "utf8").then(JSON.parse)
      : null,
  ]);
  const baselinePredictions = baselineEvaluation
    ? evaluationPredictions(baselineEvaluation)
    : reportPredictions(report);
  const candidates = input.candidates.map((candidate) => ({
    ...candidate,
    baseline:
      baselinePredictions.get(
        candidateKey(candidate.pageId, candidate.candidateId),
      ) ?? null,
    glyphCount: visibleGlyphCount(candidate.sourceText),
  }));
  const pages = buildPageCandidates(candidates);
  const predictions = new Map(baselinePredictions);
  const changed = [];
  for (const candidate of candidates) {
    const selected = selectRecovery(
      candidate,
      pages.get(candidate.pageId) ?? [],
    );
    if (!selected) continue;
    const key = candidateKey(candidate.pageId, candidate.candidateId);
    predictions.set(key, selected);
    changed.push({
      baseline: candidate.baseline,
      candidateId: candidate.candidateId,
      pageId: candidate.pageId,
      selected: {
        ...selected,
        confidence: round(selected.confidence),
        facePx: round(selected.facePx),
      },
      sourceText: candidate.sourceText,
    });
  }

  // The locked visual audit is opened only after all predictions are sealed.
  const audit = JSON.parse(await fsp.readFile(args.audit, "utf8"));
  const baselineScores = summarizeScores(audit, baselinePredictions);
  const candidateScores = summarizeScores(audit, predictions);
  const targetFindings = (audit.fontSizeFindings ?? []).map((finding) => {
    const key = candidateKey(finding.pageId, finding.candidateId);
    return {
      baselineFacePx: round(baselinePredictions.get(key)?.facePx),
      candidateId: finding.candidateId,
      facePx: round(predictions.get(key)?.facePx),
      pageId: finding.pageId,
      severity: finding.severity,
    };
  });
  const output = {
    schemaVersion: 1,
    experiment: "campaign-005-exp-02-narrow-vertical-line-recovery",
    createdAt: new Date().toISOString(),
    selectionContract: {
      auditUsedForPrediction: false,
      candidateFaceSource:
        "geometric mean of the candidate's alternative-line-count projection and writing-axis pitch",
      connectedComponentRole:
        "confirms one dominant connected column whose full span must not be mistaken for one glyph face",
      peerRole:
        "acceptance gate only; peer values are never copied into the result",
      alternativeLineCount: "formulaLineCount - 1 only",
      baselineEvaluation: args.baselineEvaluation
        ? path
            .relative(process.cwd(), args.baselineEvaluation)
            .replaceAll("\\", "/")
        : null,
      constants: {
        maximumBaselineConfidence: MAXIMUM_BASELINE_CONFIDENCE,
        maximumConnectedColumnRatio: MAXIMUM_CONNECTED_COLUMN_RATIO,
        maximumFormulaLineCount: MAXIMUM_FORMULA_LINE_COUNT,
        maximumProjectionMajorRatio: MAXIMUM_PROJECTION_MAJOR_RATIO,
        maximumProposalToPeerCenterRatio: MAXIMUM_PROPOSAL_TO_PEER_CENTER_RATIO,
        maximumSupportingPeerRatio: MAXIMUM_SUPPORTING_PEER_RATIO,
        maximumUpwardRatio: MAXIMUM_UPWARD_RATIO,
        minimumConnectedColumnRatio: MINIMUM_CONNECTED_COLUMN_RATIO,
        minimumConnectedMassShare: MINIMUM_CONNECTED_MASS_SHARE,
        minimumFormulaLineCount: MINIMUM_FORMULA_LINE_COUNT,
        minimumGlyphs: MINIMUM_GLYPHS,
        minimumMajorConfidence: MINIMUM_MAJOR_CONFIDENCE,
        minimumPeerConfidence: MINIMUM_PEER_CONFIDENCE,
        minimumProjectionConfidence: MINIMUM_PROJECTION_CONFIDENCE,
        minimumProposalToPeerCenterRatio: MINIMUM_PROPOSAL_TO_PEER_CENTER_RATIO,
        minimumSupportingPeers: MINIMUM_SUPPORTING_PEERS,
        minimumUpwardRatio: MINIMUM_UPWARD_RATIO,
        minimumVerticalAspectRatio: MINIMUM_VERTICAL_ASPECT_RATIO,
      },
    },
    summary: {
      baselineEstimated: baselinePredictions.size,
      baselineCoverage: round(
        baselinePredictions.size / input.candidates.length,
      ),
      baselineHierarchyRegressionPenalty:
        baselineScores.summary.hierarchyRegressionPenalty,
      baselineSameFontGroupScore: baselineScores.summary.sameFontGroupScore,
      candidateCount: input.candidates.length,
      changedCount: changed.length,
      coverage: round(predictions.size / input.candidates.length),
      estimated: predictions.size,
      hierarchyRegressionPenalty:
        candidateScores.summary.hierarchyRegressionPenalty,
      sameFontGroupScore: candidateScores.summary.sameFontGroupScore,
    },
    changed,
    targetFindings,
    baselineScores,
    candidateScores,
    predictions: [...predictions.entries()].map(([key, selected]) => ({
      key,
      selected: {
        ...selected,
        confidence: round(selected.confidence),
        facePx: round(selected.facePx),
      },
    })),
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
