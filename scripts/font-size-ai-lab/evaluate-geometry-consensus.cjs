#!/usr/bin/env node
/* eslint-disable -- isolated experiment/audit utility, not a production module */
// @ts-nocheck -- isolated experiment utility; production types remain checked.
"use strict";

/**
 * Campaign 002 Experiment 2: triangulate cross-axis projection, connected
 * components, and writing-axis glyph runs. No page labels or peer medians are
 * used to produce a prediction; the manual audit is read only after selection
 * to score locked same-font groups and intentional-small sentinels.
 */

const fsp = require("node:fs/promises");
const path = require("node:path");

const MAX_INDEPENDENT_RATIO = 1.3;
const MAX_UPWARD_INDEPENDENT_RATIO = 1.12;
const MAX_MAJOR_BAND_RATIO = 2;
const MINIMUM_REPEATED_GLYPHS = 8;
const MAX_UPWARD_PROJECTION_LINE_FILL = 0.55;

function parseArgs(argv) {
  const args = { audit: null, candidates: null, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--audit") args.audit = path.resolve(argv[++index]);
    else if (value === "--candidates")
      args.candidates = path.resolve(argv[++index]);
    else if (value === "--output") args.output = path.resolve(argv[++index]);
    else if (value === "--help") {
      console.log(
        "Usage: node scripts/font-size-ai-lab/evaluate-geometry-consensus.cjs " +
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

function candidateKey(pageId, candidateId) {
  return `${pageId}/${candidateId}`;
}

function hypothesisValues(trial) {
  return {
    component: trial.component
      ? {
          confidence: trial.component.confidence,
          face: trial.component.primaryFace,
        }
      : null,
    major: trial.majorPitch
      ? {
          confidence: trial.majorPitch.confidence,
          face: trial.majorPitch.face,
        }
      : null,
    projection: trial.estimate
      ? {
          confidence: trial.estimate.confidence,
          face: trial.estimate.facePx,
        }
      : null,
  };
}

function ratio(values) {
  return Math.max(...values) / Math.max(1, Math.min(...values));
}

function resolveCandidate(candidate) {
  const formulaTrial = candidate.trials.find(
    (trial) => trial.lineCount === candidate.formulaLineCount,
  );
  const formula = formulaTrial?.estimate ?? null;
  if (candidate.glyphCount < MINIMUM_REPEATED_GLYPHS) {
    return formula
      ? {
          confidence: formula.confidence,
          facePx: formula.facePx,
          lineCount: formulaTrial.lineCount,
          reason: "short-text-projection-preserved",
        }
      : null;
  }
  if (formula) {
    const hypotheses = hypothesisValues(formulaTrial);
    const independent = [hypotheses.component, hypotheses.major].filter(
      Boolean,
    );
    if (
      formulaTrial.majorPitch &&
      ratio(formulaTrial.majorPitch.bandFaces) > MAX_MAJOR_BAND_RATIO
    ) {
      return {
        confidence: formula.confidence,
        facePx: formula.facePx,
        lineCount: formulaTrial.lineCount,
        reason: "multi-scale-major-bands-preserved-projection",
      };
    }
    if (
      independent.length === 2 &&
      ratio(independent.map((value) => value.face)) <= MAX_INDEPENDENT_RATIO
    ) {
      const consensus =
        Math.sqrt(independent[0].face * independent[1].face) * 1.02;
      const independentRatio = ratio(independent.map((value) => value.face));
      const projectionRatio = Math.max(
        formula.facePx / consensus,
        consensus / formula.facePx,
      );
      if (projectionRatio > MAX_INDEPENDENT_RATIO) {
        const projectionLineFill =
          formula.facePx /
          Math.max(1, candidate.cross / formulaTrial.lineCount);
        if (
          consensus > formula.facePx &&
          (independentRatio > MAX_UPWARD_INDEPENDENT_RATIO ||
            projectionLineFill >= MAX_UPWARD_PROJECTION_LINE_FILL)
        ) {
          return {
            confidence: formula.confidence,
            facePx: formula.facePx,
            lineCount: formulaTrial.lineCount,
            reason: "upward-consensus-rejected-by-line-fill",
          };
        }
        return {
          confidence: Math.max(
            0.5,
            Math.min(independent[0].confidence, independent[1].confidence) -
              Math.abs(Math.log(independent[0].face / independent[1].face)) *
                0.12,
          ),
          facePx: consensus,
          lineCount: formulaTrial.lineCount,
          reason: "component-major-consensus-overrode-projection",
        };
      }
    }
    return {
      confidence: formula.confidence,
      facePx: formula.facePx,
      lineCount: formulaTrial.lineCount,
      reason: "projection-preserved",
    };
  }

  const recoveries = candidate.trials.flatMap((trial) => {
    const hypotheses = hypothesisValues(trial);
    const all = [
      hypotheses.projection,
      hypotheses.component
        ? { ...hypotheses.component, face: hypotheses.component.face * 1.02 }
        : null,
      hypotheses.major
        ? { ...hypotheses.major, face: hypotheses.major.face * 1.02 }
        : null,
    ];
    if (
      all.some((value) => !value) ||
      !trial.majorPitch ||
      ratio(trial.majorPitch.bandFaces) > MAX_MAJOR_BAND_RATIO ||
      ratio(all.map((value) => value.face)) > MAX_INDEPENDENT_RATIO
    ) {
      return [];
    }
    const faces = all.map((value) => value.face);
    return [
      {
        confidence: Math.min(...all.map((value) => value.confidence)),
        facePx: median(faces),
        lineCount: trial.lineCount,
        lineDistance: Math.abs(trial.lineCount - candidate.formulaLineCount),
        ratio: ratio(faces),
      },
    ];
  });
  const recovered = recoveries.sort(
    (left, right) =>
      left.ratio - right.ratio ||
      right.confidence - left.confidence ||
      left.lineDistance - right.lineDistance,
  )[0];
  return recovered
    ? {
        confidence: recovered.confidence,
        facePx: recovered.facePx,
        lineCount: recovered.lineCount,
        reason: "three-way-alternative-line-recovery",
      }
    : null;
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

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const [input, audit] = await Promise.all([
    fsp.readFile(args.candidates, "utf8").then(JSON.parse),
    fsp.readFile(args.audit, "utf8").then(JSON.parse),
  ]);
  const predictions = new Map();
  const changed = [];
  let baselineEstimated = 0;
  for (const candidate of input.candidates) {
    const formulaTrial = candidate.trials.find(
      (trial) => trial.lineCount === candidate.formulaLineCount,
    );
    if (formulaTrial?.estimate) baselineEstimated += 1;
    const selected = resolveCandidate(candidate);
    if (selected) {
      predictions.set(
        candidateKey(candidate.pageId, candidate.candidateId),
        selected,
      );
    }
    const baselineFace = formulaTrial?.estimate?.facePx ?? null;
    const materiallyChanged =
      baselineFace === null
        ? Boolean(selected)
        : !selected ||
          Math.abs(Math.log(selected.facePx / baselineFace)) >= Math.log(1.01);
    if (materiallyChanged) {
      changed.push({
        baseline: formulaTrial?.estimate ?? null,
        candidateId: candidate.candidateId,
        pageId: candidate.pageId,
        selected,
        sourceText: candidate.sourceText,
      });
    }
  }
  const sameFontGroups = audit.sameVisualFontGroups.map((group) =>
    scoreGroup(group, predictions),
  );
  const smallSentinels = audit.hierarchyMustRemainSmall.map((sentinel) => {
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
          : round(Math.max(0, ratioToBaseline - 1.15)),
    };
  });
  const estimated = predictions.size;
  const output = {
    schemaVersion: 1,
    experiment: "campaign-002-exp-02-three-geometry-consensus",
    createdAt: new Date().toISOString(),
    selectionContract: {
      auditUsedForPrediction: false,
      maximumIndependentRatio: MAX_INDEPENDENT_RATIO,
      maximumUpwardIndependentRatio: MAX_UPWARD_INDEPENDENT_RATIO,
      maximumMajorBandRatio: MAX_MAJOR_BAND_RATIO,
      minimumRepeatedGlyphs: MINIMUM_REPEATED_GLYPHS,
      maximumUpwardProjectionLineFill: MAX_UPWARD_PROJECTION_LINE_FILL,
      measuredRule:
        "preserve projection unless component and major-axis glyph runs agree and projection differs by more than 1.3x",
      recoveryRule:
        "an alternative line count requires projection, component and major-axis glyph runs all within 1.3x",
    },
    summary: {
      baselineEstimated,
      baselineCoverage: round(baselineEstimated / input.candidates.length),
      candidateCount: input.candidates.length,
      changedCount: changed.filter((item) => item.baseline).length,
      estimated,
      coverage: round(estimated / input.candidates.length),
      recoveredCount: changed.filter((item) => !item.baseline && item.selected)
        .length,
      sameFontGroupScore: round(
        mean(sameFontGroups.map((group) => group.score)),
      ),
      sameFontMeanCoverage: round(
        mean(sameFontGroups.map((group) => group.coverage)),
      ),
      smallTextRegressionPenalty: round(
        mean(smallSentinels.map((item) => item.regressionPenalty)),
      ),
    },
    changed,
    sameFontGroups,
    smallSentinels,
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
