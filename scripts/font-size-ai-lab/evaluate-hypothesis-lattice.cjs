#!/usr/bin/env node
/* eslint-disable -- isolated experiment/audit utility, not a production module */
// @ts-nocheck -- isolated experiment utility; production types remain checked.
"use strict";

/**
 * Campaign 003 Experiment 2: search a small lattice of plausible line-count
 * hypotheses, then find a repeated face mode supported by projection and at
 * least one independent geometry source. The visual audit is never used to
 * select a prediction; it is opened only after predictions are fixed so the
 * locked groups and hierarchy sentinels can be scored.
 */

const fsp = require("node:fs/promises");
const path = require("node:path");

const SOURCE_FACE_SCALE = 1.02;
const MAXIMUM_LINE_DISTANCE = 2;
const MODE_RADIUS_RATIO = 1.18;
const MINIMUM_COMPONENT_MASS_SHARE = 0.18;
const MINIMUM_DOWNWARD_RATIO = 1.22;
const MINIMUM_MODE_WEIGHT = 1.45;

function parseArgs(argv) {
  const args = {
    audit: null,
    candidates: null,
    output: null,
    peerGated: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--audit") args.audit = path.resolve(argv[++index]);
    else if (value === "--candidates")
      args.candidates = path.resolve(argv[++index]);
    else if (value === "--output") args.output = path.resolve(argv[++index]);
    else if (value === "--peer-gated") args.peerGated = true;
    else if (value === "--help") {
      console.log(
        "Usage: node scripts/font-size-ai-lab/evaluate-hypothesis-lattice.cjs " +
          "--candidates PATH --audit PATH --output PATH",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${value}`);
  }
  if (!args.audit || !args.candidates || !args.output) {
    throw new Error("--candidates, --audit and --output are required.");
  }
  return args;
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
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function ratio(first, second) {
  return Math.max(first / Math.max(1, second), second / Math.max(1, first));
}

function candidateKey(pageId, candidateId) {
  return `${pageId}/${candidateId}`;
}

function collectHypothesisPoints(candidate) {
  return candidate.trials.flatMap((trial) => {
    if (
      Math.abs(trial.lineCount - candidate.formulaLineCount) >
      MAXIMUM_LINE_DISTANCE
    ) {
      return [];
    }
    const points = [];
    if (trial.estimate) {
      points.push({
        confidence: trial.estimate.confidence,
        face: trial.estimate.facePx,
        lineCount: trial.lineCount,
        source: "projection",
        weight: trial.estimate.confidence,
      });
    }
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

function weightedLogMedian(points) {
  const sorted = [...points].sort((left, right) => left.face - right.face);
  const total = sorted.reduce((sum, point) => sum + point.weight, 0);
  let running = 0;
  for (const point of sorted) {
    running += point.weight;
    if (running >= total / 2) return point.face;
  }
  return sorted.at(-1)?.face ?? null;
}

function selectRepeatedFaceMode(candidate) {
  const baseline = candidate.consensus;
  if (!baseline || candidate.glyphCount < 8) return null;
  const points = collectHypothesisPoints(candidate);
  const modes = points.flatMap((center) => {
    const members = points.filter(
      (point) => ratio(point.face, center.face) <= MODE_RADIUS_RATIO,
    );
    const sources = new Set(members.map((point) => point.source));
    const trialSources = new Set(
      members.map((point) => `${point.lineCount}:${point.source}`),
    );
    if (
      !sources.has("projection") ||
      sources.size < 2 ||
      trialSources.size < 3
    ) {
      return [];
    }
    const face = weightedLogMedian(members);
    if (!face || baseline.facePx / face < MINIMUM_DOWNWARD_RATIO) return [];
    const totalWeight = members.reduce((sum, point) => sum + point.weight, 0);
    if (totalWeight < MINIMUM_MODE_WEIGHT) return [];
    const logDispersion = mean(
      members.map((point) => Math.abs(Math.log(point.face / face))),
    );
    return [
      {
        confidence: Math.max(
          0.5,
          Math.min(
            0.9,
            mean(members.map((point) => point.confidence)) -
              logDispersion * 0.25,
          ),
        ),
        facePx: face,
        logDispersion,
        members,
        score:
          totalWeight +
          sources.size * 0.22 +
          trialSources.size * 0.035 -
          logDispersion,
        sources: [...sources].sort(),
        totalWeight,
        trialSourceCount: trialSources.size,
      },
    ];
  });
  return (
    modes.sort(
      (left, right) =>
        right.score - left.score ||
        left.logDispersion - right.logDispersion ||
        right.facePx - left.facePx,
    )[0] ?? null
  );
}

function maximumValueRatio(values) {
  return values.length >= 2
    ? Math.max(...values) / Math.max(1, Math.min(...values))
    : 1;
}

function formulaSuspicion(candidate) {
  const trial = candidate.trials.find(
    (item) => item.lineCount === candidate.formulaLineCount,
  );
  if (!trial) return { bandRatio: 1, geometryRatio: 1 };
  const values = [
    trial.estimate?.facePx,
    trial.component?.primaryFace
      ? trial.component.primaryFace * SOURCE_FACE_SCALE
      : null,
    trial.majorPitch?.face ? trial.majorPitch.face * SOURCE_FACE_SCALE : null,
  ].filter(Number.isFinite);
  return {
    bandRatio: maximumValueRatio(trial.majorPitch?.bandFaces ?? []),
    geometryRatio: maximumValueRatio(values),
  };
}

function isStablePeerCandidate(candidate) {
  if (
    !candidate.consensus ||
    candidate.consensus.confidence < 0.75 ||
    candidate.glyphCount < 8
  ) {
    return false;
  }
  const trial = candidate.trials.find(
    (item) => item.lineCount === candidate.formulaLineCount,
  );
  if (
    !trial?.estimate ||
    !trial.component ||
    trial.component.primaryMassShare < 0.25 ||
    !trial.majorPitch
  ) {
    return false;
  }
  const stableValues = [
    candidate.consensus.facePx,
    trial.component.primaryFace * SOURCE_FACE_SCALE,
    trial.majorPitch.face * SOURCE_FACE_SCALE,
  ];
  return (
    maximumValueRatio(stableValues) <= 1.2 &&
    maximumValueRatio(trial.majorPitch.bandFaces) <= 1.8
  );
}

function selectPagePeerCenter(candidates) {
  const stable = candidates.filter(isStablePeerCandidate);
  const clusters = stable.map((center) => {
    const members = stable.filter(
      (candidate) =>
        ratio(candidate.consensus.facePx, center.consensus.facePx) <= 1.18,
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
  return selected?.members.length >= 3 ? selected.center : null;
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

function peerGateAccepts(candidate, mode, peerCenter) {
  if (!Number.isFinite(peerCenter) || !candidate.consensus) return false;
  const baselineToPeer = candidate.consensus.facePx / peerCenter;
  const modeToPeer = mode.facePx / peerCenter;
  const suspicion = formulaSuspicion(candidate);
  const sources = new Set(mode.sources);
  const hasAllGeometrySources =
    sources.has("projection") &&
    sources.has("component") &&
    sources.has("major-band");
  const geometryIsSuspect =
    suspicion.geometryRatio >= 1.3 || suspicion.bandRatio > 2;
  const partialEvidenceAllowed =
    suspicion.geometryRatio >= 2 && mode.totalWeight >= 2.4;
  return Boolean(
    baselineToPeer >= 1.24 &&
    modeToPeer >= 0.82 &&
    modeToPeer <= 1.32 &&
    geometryIsSuspect &&
    (hasAllGeometrySources || partialEvidenceAllowed),
  );
}

function resolveCandidate(candidate, peerCenter, peerGated) {
  const mode = selectRepeatedFaceMode(candidate);
  if (!mode || (peerGated && !peerGateAccepts(candidate, mode, peerCenter))) {
    return candidate.consensus
      ? {
          confidence: candidate.consensus.confidence,
          facePx: candidate.consensus.facePx,
          reason: "production-consensus-preserved",
        }
      : null;
  }
  return {
    confidence: mode.confidence,
    facePx: mode.facePx,
    reason: "repeated-cross-hypothesis-face-mode",
    evidence: {
      logDispersion: round(mode.logDispersion),
      sources: mode.sources,
      totalWeight: round(mode.totalWeight),
      trialSourceCount: mode.trialSourceCount,
    },
  };
}

function scoreGroup(group, predictions) {
  const values = group.candidateIds
    .map((candidateId) =>
      predictions.get(candidateKey(group.pageId, candidateId)),
    )
    .filter(Boolean)
    .map((value) => value.facePx);
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
  const groups = audit.sameVisualFontGroups.map((group) =>
    scoreGroup(group, predictions),
  );
  const smallSentinels = audit.hierarchyMustRemainSmall.map((sentinel) =>
    scoreHierarchySentinel(sentinel, predictions, "small"),
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
  const [input, audit] = await Promise.all([
    fsp.readFile(args.candidates, "utf8").then(JSON.parse),
    fsp.readFile(args.audit, "utf8").then(JSON.parse),
  ]);
  const baselinePredictions = new Map();
  const predictions = new Map();
  const changed = [];
  const pagePeerCenters = buildPagePeerCenters(input.candidates);
  for (const candidate of input.candidates) {
    const key = candidateKey(candidate.pageId, candidate.candidateId);
    if (candidate.consensus) baselinePredictions.set(key, candidate.consensus);
    const selected = resolveCandidate(
      candidate,
      pagePeerCenters.get(candidate.pageId),
      args.peerGated,
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
    experiment: args.peerGated
      ? "campaign-003-exp-03-peer-gated-hypothesis-lattice"
      : "campaign-003-exp-02-cross-hypothesis-lattice",
    createdAt: new Date().toISOString(),
    selectionContract: {
      auditUsedForPrediction: false,
      maximumLineDistance: MAXIMUM_LINE_DISTANCE,
      modeRadiusRatio: MODE_RADIUS_RATIO,
      minimumComponentMassShare: MINIMUM_COMPONENT_MASS_SHARE,
      minimumDownwardRatio: MINIMUM_DOWNWARD_RATIO,
      minimumModeWeight: MINIMUM_MODE_WEIGHT,
      pagePeerGate: args.peerGated
        ? {
            baselineMinimumRatio: 1.24,
            candidatePeerRatioRange: [0.82, 1.32],
            minimumStablePeers: 3,
            predictionRole:
              "peer center is an acceptance gate only; it is never copied as the predicted face",
          }
        : null,
      rule: "preserve production unless a lower face repeats across nearby line-count hypotheses with projection plus independent geometry support",
    },
    summary: {
      baselineEstimated: baselinePredictions.size,
      baselineCoverage: round(
        baselinePredictions.size / input.candidates.length,
      ),
      candidateCount: input.candidates.length,
      changedCount: changed.length,
      estimated: predictions.size,
      coverage: round(predictions.size / input.candidates.length),
      baselineSameFontGroupScore: baselineScores.summary.sameFontGroupScore,
      sameFontGroupScore: candidateScores.summary.sameFontGroupScore,
      baselineHierarchyRegressionPenalty:
        baselineScores.summary.hierarchyRegressionPenalty,
      hierarchyRegressionPenalty:
        candidateScores.summary.hierarchyRegressionPenalty,
    },
    pagePeerCenters: Object.fromEntries(
      [...pagePeerCenters.entries()].map(([pageId, center]) => [
        pageId,
        round(center),
      ]),
    ),
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
