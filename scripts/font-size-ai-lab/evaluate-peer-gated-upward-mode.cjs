#!/usr/bin/env node
/* eslint-disable -- isolated experiment/audit utility, not a production module */
// @ts-nocheck -- laboratory artifact generator; production types remain checked.
"use strict";

/**
 * Campaign 004 upward-recovery preflight.
 *
 * The visual audit is loaded only after every prediction is fixed. A page
 * peer center can accept or reject a candidate, but the predicted face is the
 * candidate's own repeated component + major-axis mode and never the peer.
 */

const fsp = require("node:fs/promises");
const path = require("node:path");

const SOURCE_FACE_SCALE = 1.02;
const PEER_RADIUS_RATIO = 1.18;
const MODE_RADIUS_RATIO = 1.14;
const MINIMUM_COMPONENT_MASS_SHARE = 0.5;
const MINIMUM_GLYPHS = 8;
const MINIMUM_STABLE_PEERS = 3;
const MINIMUM_BASELINE_TO_PEER_RATIO = 1.12;
const MINIMUM_UPWARD_RATIO = 1.08;
const MAXIMUM_UPWARD_RATIO = 1.25;
const MINIMUM_MODE_TO_PEER_RATIO = 0.82;
const MAXIMUM_MODE_TO_PEER_RATIO = 1.16;
const MAXIMUM_PROJECTION_LINE_FILL = 0.55;
const MINIMUM_MODE_WEIGHT = 2.8;
const MINIMUM_MAJOR_TRIAL_COUNT = 2;

function parseArgs(argv) {
  const args = {
    audit: null,
    baseEvaluation: null,
    candidates: null,
    output: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--audit") args.audit = path.resolve(argv[++index]);
    else if (value === "--base-evaluation")
      args.baseEvaluation = path.resolve(argv[++index]);
    else if (value === "--candidates")
      args.candidates = path.resolve(argv[++index]);
    else if (value === "--output") args.output = path.resolve(argv[++index]);
    else if (value === "--help") {
      console.log(
        "Usage: node scripts/font-size-ai-lab/evaluate-peer-gated-upward-mode.cjs " +
          "--candidates PATH --audit PATH --output PATH [--base-evaluation PATH]",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${value}`);
  }
  if (!args.audit || !args.candidates || !args.output) {
    throw new Error("--candidates, --audit and --output are required.");
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

function ratio(first, second) {
  return Math.max(first / Math.max(1, second), second / Math.max(1, first));
}

function maximumValueRatio(values) {
  return values.length >= 2
    ? Math.max(...values) / Math.max(1, Math.min(...values))
    : 1;
}

function formulaTrial(candidate) {
  return candidate.trials.find(
    (trial) => trial.lineCount === candidate.formulaLineCount,
  );
}

function hasStableMajorBandCore(bandFaces) {
  if (!bandFaces?.length) return false;
  if (bandFaces.length <= 2) return maximumValueRatio(bandFaces) <= 1.8;
  const required = Math.ceil(bandFaces.length * 0.75);
  return bandFaces.some(
    (center) =>
      bandFaces.filter((face) => ratio(face, center) <= 1.35).length >=
      required,
  );
}

function isStablePeerCandidate(candidate) {
  if (
    !candidate.consensus ||
    candidate.consensus.confidence < 0.75 ||
    candidate.glyphCount < MINIMUM_GLYPHS
  ) {
    return false;
  }
  const trial = formulaTrial(candidate);
  if (
    !trial?.estimate ||
    !trial.component ||
    trial.component.primaryMassShare < 0.25 ||
    !trial.majorPitch
  ) {
    return false;
  }
  return (
    maximumValueRatio([
      candidate.consensus.facePx,
      trial.component.primaryFace * SOURCE_FACE_SCALE,
      trial.majorPitch.face * SOURCE_FACE_SCALE,
    ]) <= 1.2 && hasStableMajorBandCore(trial.majorPitch.bandFaces)
  );
}

function selectPagePeerCenter(candidates) {
  const stable = candidates.filter(isStablePeerCandidate);
  const clusters = stable.map((center) => {
    const members = stable.filter(
      (candidate) =>
        ratio(candidate.consensus.facePx, center.consensus.facePx) <=
        PEER_RADIUS_RATIO,
    );
    return {
      center: median(members.map((candidate) => candidate.consensus.facePx)),
      members,
    };
  });
  const selected = clusters.sort(
    (left, right) =>
      right.members.length - left.members.length ||
      median(right.members.map((candidate) => candidate.consensus.confidence)) -
        median(left.members.map((candidate) => candidate.consensus.confidence)),
  )[0];
  return selected?.members.length >= MINIMUM_STABLE_PEERS
    ? selected.center
    : null;
}

function buildPagePeerCenters(candidates) {
  const pages = new Map();
  for (const candidate of candidates) {
    const page = pages.get(candidate.pageId) ?? [];
    page.push(candidate);
    pages.set(candidate.pageId, page);
  }
  return new Map(
    [...pages.entries()].map(([pageId, pageCandidates]) => [
      pageId,
      selectPagePeerCenter(pageCandidates),
    ]),
  );
}

function collectIndependentPoints(candidate) {
  const minimum = Math.max(1, candidate.formulaLineCount - 1);
  const maximum = candidate.formulaLineCount + 2;
  return candidate.trials.flatMap((trial) => {
    if (trial.lineCount < minimum || trial.lineCount > maximum) return [];
    const points = [];
    if (
      trial.component &&
      trial.component.primaryMassShare >= MINIMUM_COMPONENT_MASS_SHARE
    ) {
      const massWeight = Math.min(1, 0.5 + trial.component.primaryMassShare);
      points.push({
        confidence: trial.component.confidence,
        face: trial.component.primaryFace * SOURCE_FACE_SCALE,
        lineCount: trial.lineCount,
        source: "component",
        weight: trial.component.confidence * massWeight,
      });
    }
    if (trial.majorPitch?.bandFaces?.length) {
      const bandWeight =
        trial.majorPitch.confidence /
        Math.sqrt(trial.majorPitch.bandFaces.length);
      for (const face of trial.majorPitch.bandFaces) {
        points.push({
          confidence: trial.majorPitch.confidence,
          face: face * SOURCE_FACE_SCALE,
          lineCount: trial.lineCount,
          source: "major-band",
          weight: bandWeight,
        });
      }
    }
    return points.filter(
      (point) =>
        Number.isFinite(point.face) && point.face >= 4 && point.face <= 512,
    );
  });
}

function weightedMedian(points) {
  const sorted = [...points].sort((left, right) => left.face - right.face);
  const totalWeight = sorted.reduce((sum, point) => sum + point.weight, 0);
  let running = 0;
  for (const point of sorted) {
    running += point.weight;
    if (running >= totalWeight / 2) return point.face;
  }
  return sorted.at(-1)?.face ?? null;
}

function describeMode(candidate, peerCenter, points, center) {
  const members = points.filter(
    (point) => ratio(point.face, center.face) <= MODE_RADIUS_RATIO,
  );
  const componentTrials = new Set(
    members
      .filter((point) => point.source === "component")
      .map((point) => point.lineCount),
  );
  const majorTrials = new Set(
    members
      .filter((point) => point.source === "major-band")
      .map((point) => point.lineCount),
  );
  if (
    componentTrials.size < 1 ||
    majorTrials.size < MINIMUM_MAJOR_TRIAL_COUNT
  ) {
    return null;
  }
  const facePx = weightedMedian(members);
  if (!facePx) return null;
  const baseline = candidate.consensus.facePx;
  const upwardRatio = facePx / baseline;
  const modeToPeer = facePx / peerCenter;
  const totalWeight = members.reduce((sum, point) => sum + point.weight, 0);
  if (
    upwardRatio < MINIMUM_UPWARD_RATIO ||
    upwardRatio > MAXIMUM_UPWARD_RATIO ||
    modeToPeer < MINIMUM_MODE_TO_PEER_RATIO ||
    modeToPeer > MAXIMUM_MODE_TO_PEER_RATIO ||
    totalWeight < MINIMUM_MODE_WEIGHT
  ) {
    return null;
  }
  const logDispersion = mean(
    members.map((point) => Math.abs(Math.log(point.face / facePx))),
  );
  return {
    confidence: Math.max(
      0.5,
      Math.min(
        0.9,
        mean(members.map((point) => point.confidence)) - logDispersion * 0.25,
      ),
    ),
    facePx,
    logDispersion,
    majorTrialCount: majorTrials.size,
    memberCount: members.length,
    score:
      totalWeight +
      majorTrials.size * 0.12 +
      componentTrials.size * 0.08 -
      logDispersion,
    totalWeight,
  };
}

function selectUpwardMode(candidate, peerCenter) {
  if (
    !candidate.consensus ||
    !Number.isFinite(peerCenter) ||
    candidate.glyphCount < MINIMUM_GLYPHS ||
    peerCenter / candidate.consensus.facePx < MINIMUM_BASELINE_TO_PEER_RATIO
  ) {
    return null;
  }
  const projectionLineFill =
    candidate.consensus.facePx /
    Math.max(1, candidate.cross / Math.max(1, candidate.formulaLineCount));
  if (projectionLineFill >= MAXIMUM_PROJECTION_LINE_FILL) return null;
  const points = collectIndependentPoints(candidate);
  return (
    points
      .flatMap((center) => {
        const mode = describeMode(candidate, peerCenter, points, center);
        return mode ? [mode] : [];
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.logDispersion - right.logDispersion ||
          left.facePx - right.facePx,
      )[0] ?? null
  );
}

function resolveCandidate(candidate, peerCenter) {
  if (!candidate.consensus) return null;
  const mode = selectUpwardMode(candidate, peerCenter);
  if (!mode) {
    return {
      confidence: candidate.consensus.confidence,
      facePx: candidate.consensus.facePx,
      reason: "production-consensus-preserved",
    };
  }
  return {
    confidence: mode.confidence,
    evidence: {
      logDispersion: round(mode.logDispersion),
      majorTrialCount: mode.majorTrialCount,
      memberCount: mode.memberCount,
      totalWeight: round(mode.totalWeight),
    },
    facePx: mode.facePx,
    reason: "peer-gated-candidate-owned-upward-mode",
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
  const input = JSON.parse(await fsp.readFile(args.candidates, "utf8"));
  const baseEvaluation = args.baseEvaluation
    ? JSON.parse(await fsp.readFile(args.baseEvaluation, "utf8"))
    : null;
  const baseByKey = new Map(
    (baseEvaluation?.predictions ?? []).map((prediction) => [
      prediction.key,
      prediction.selected,
    ]),
  );
  const candidates = input.candidates.map((candidate) => {
    if (!baseEvaluation) return candidate;
    return {
      ...candidate,
      consensus:
        baseByKey.get(candidateKey(candidate.pageId, candidate.candidateId)) ??
        null,
    };
  });
  const pagePeerCenters = buildPagePeerCenters(candidates);
  const baselinePredictions = new Map();
  const predictions = new Map();
  const changed = [];
  for (const candidate of candidates) {
    const key = candidateKey(candidate.pageId, candidate.candidateId);
    if (candidate.consensus) baselinePredictions.set(key, candidate.consensus);
    const selected = resolveCandidate(
      candidate,
      pagePeerCenters.get(candidate.pageId),
    );
    if (selected) predictions.set(key, selected);
    if (
      candidate.consensus &&
      selected &&
      Math.abs(Math.log(selected.facePx / candidate.consensus.facePx)) >=
        Math.log(1.01)
    ) {
      changed.push({
        baseline: candidate.consensus,
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
  }

  // The locked visual audit is opened only after all predictions are sealed.
  const audit = JSON.parse(await fsp.readFile(args.audit, "utf8"));
  const baselineScores = summarizeScores(audit, baselinePredictions);
  const candidateScores = summarizeScores(audit, predictions);
  const output = {
    schemaVersion: 1,
    experiment: "campaign-004-exp-02-peer-gated-upward-mode-preflight",
    createdAt: new Date().toISOString(),
    selectionContract: {
      auditUsedForPrediction: false,
      candidateFaceSource:
        "weighted median of the candidate's own component and major-axis evidence",
      baseEvaluation: args.baseEvaluation
        ? path
            .relative(process.cwd(), args.baseEvaluation)
            .replaceAll("\\", "/")
        : null,
      peerRole:
        "acceptance gate only; the page peer center is never copied into the result",
      constants: {
        maximumModeToPeerRatio: MAXIMUM_MODE_TO_PEER_RATIO,
        maximumProjectionLineFill: MAXIMUM_PROJECTION_LINE_FILL,
        maximumUpwardRatio: MAXIMUM_UPWARD_RATIO,
        minimumBaselineToPeerRatio: MINIMUM_BASELINE_TO_PEER_RATIO,
        minimumComponentMassShare: MINIMUM_COMPONENT_MASS_SHARE,
        minimumMajorTrialCount: MINIMUM_MAJOR_TRIAL_COUNT,
        minimumModeToPeerRatio: MINIMUM_MODE_TO_PEER_RATIO,
        minimumModeWeight: MINIMUM_MODE_WEIGHT,
        minimumStablePeers: MINIMUM_STABLE_PEERS,
        minimumUpwardRatio: MINIMUM_UPWARD_RATIO,
        modeRadiusRatio: MODE_RADIUS_RATIO,
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
    pagePeerCenters: Object.fromEntries(
      [...pagePeerCenters.entries()].map(([pageId, center]) => [
        pageId,
        round(center),
      ]),
    ),
    changed,
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
