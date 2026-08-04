/* eslint-disable complexity, max-lines, max-lines-per-function -- fixed feature parity is intentionally kept together */
import {
  FONT_MATCHING_SELECTION_CALIBRATION_SCHEMA_V2,
  FONT_MATCHING_SELECTION_CONTINUOUS_FEATURES,
  isSupportedFontMatchingSelectionCandidateCount,
  type FontMatchingSelectionCalibration,
} from "./fontMatchingSelectionCalibrationContract";

const ROLE_COUNT = 14;
const STYLE_COUNT = 10;
const ORIENTATION_COUNT = 4;
const VIEW_COUNT = 3;
const SHORTLIST_SIZE = 3;
const LOG_EPSILON = 1e-8;
const Z_STANDARD_DEVIATION_FLOOR = 1e-6;
const PROTOTYPE_LME_SCALE = 10;

type NumericValues = ArrayLike<number>;

export type FontMatchingPrototypeBag = Readonly<{
  candidateId: string;
  start: number;
  count: number;
}>;

export type FontMatchingSelectionRawFeatures = Readonly<{
  candidateIds: readonly string[];
  candidateScores: NumericValues;
  runtimeTemperature: number;
  noneLogit: number;
  roleLogits: NumericValues;
  styleLogits: NumericValues;
  orientationLogits: NumericValues;
  viewGateWeights: NumericValues;
  viewFeatures: NumericValues;
  featureDim: number;
  prototypeFeatures: NumericValues;
  prototypeBags: readonly FontMatchingPrototypeBag[];
}>;

type FontMatchingSelectionFeatureRow = Readonly<{
  candidateId: string;
  originalRank: number;
  values: readonly number[];
}>;

export type FontMatchingSelectionFeatureSet = Readonly<{
  rows: readonly FontMatchingSelectionFeatureRow[];
  originalCandidateOrder: readonly string[];
  noneProbability: number;
  top1RawScore: number;
  top1RawMargin: number;
}>;

type PrototypeSummary = Readonly<{
  means: readonly [number, number, number];
  lmes: readonly [number, number, number];
  gateWeightedMean: number;
  bagCountFraction: number;
}>;

/**
 * Construct the exact 45 continuous values and active-catalog candidate
 * one-hot values used by the supervised validation calibrator. Invalid tensor
 * boundaries return null so runtime inference can abstain without partial
 * features. The v1 contract supports legacy15 and student22 catalogs.
 */
export function buildFontMatchingSelectionFeatureSet(
  raw: FontMatchingSelectionRawFeatures,
  calibration: FontMatchingSelectionCalibration,
): FontMatchingSelectionFeatureSet | null {
  if (
    calibration.schemaVersion === FONT_MATCHING_SELECTION_CALIBRATION_SCHEMA_V2
  ) {
    return buildRankPreservingConfidenceFeatureSet(raw, calibration);
  }
  if (!validBoundary(raw, calibration)) return null;
  const candidateIds = raw.candidateIds;
  const scores = toNumbers(raw.candidateScores);
  const probabilities = softmax(scores, raw.runtimeTemperature);
  const roleProbabilities = softmax(toNumbers(raw.roleLogits), 1);
  const orientationProbabilities = softmax(toNumbers(raw.orientationLogits), 1);
  const styleProbabilities = toNumbers(raw.styleLogits).map(sigmoid);
  const viewGates = toNumbers(raw.viewGateWeights);
  const originalOrder = candidateIds
    .map((candidateId, index) => ({
      candidateId,
      index,
      score: scores[index] ?? 0,
    }))
    .sort(
      (left, right) => right.score - left.score || left.index - right.index,
    );
  const rankByIndex = new Array<number>(candidateIds.length);
  originalOrder.forEach(({ index }, rank) => {
    rankByIndex[index] = rank;
  });
  const prototypeSummaries = buildPrototypeSummaries(raw, viewGates);
  if (!prototypeSummaries) return null;
  const prototypeOrder = prototypeSummaries
    .map((summary, index) => ({ index, score: summary.gateWeightedMean }))
    .sort(
      (left, right) => right.score - left.score || left.index - right.index,
    );
  const prototypeRankByIndex = new Array<number>(candidateIds.length);
  prototypeOrder.forEach(({ index }, rank) => {
    prototypeRankByIndex[index] = rank;
  });

  const meanScore = mean(scores);
  const scoreStd = Math.max(
    populationStandardDeviation(scores),
    Z_STANDARD_DEVIATION_FLOOR,
  );
  const maxScore = Math.max(...scores);
  const rankerEntropy = normalizedEntropy(probabilities);
  const top3Mass = originalOrder
    .slice(0, SHORTLIST_SIZE)
    .reduce((sum, row) => sum + (probabilities[row.index] ?? 0), 0);
  const first = originalOrder[0];
  const second = originalOrder[1];
  if (!first || !second) return null;
  const rankerMargin =
    (probabilities[first.index] ?? 0) - (probabilities[second.index] ?? 0);
  const noneProbability = sigmoid(raw.noneLogit);
  const roleBodyMass = sumSlice(roleProbabilities, 0, 3);
  const roleVariantMass = sumSlice(roleProbabilities, 3, 13);
  const roleMax = Math.max(...roleProbabilities);
  const roleEntropy = normalizedEntropy(roleProbabilities);
  const orientationEntropy = normalizedEntropy(orientationProbabilities);
  const viewGateEntropy = normalizedEntropy(viewGates);
  const bestPrototypeScore = prototypeOrder[0]?.score;
  if (!Number.isFinite(bestPrototypeScore)) return null;

  const rows = originalOrder
    .slice(0, SHORTLIST_SIZE)
    .map(({ candidateId, index }) => {
      const rank = rankByIndex[index] ?? 0;
      const summary = prototypeSummaries[index];
      if (!summary) return null;
      const crossViewStd = populationStandardDeviation(summary.means);
      const continuous = [
        (scores[index] ?? 0) - meanScore,
        ((scores[index] ?? 0) - meanScore) / scoreStd,
        probabilities[index] ?? 0,
        Math.log((probabilities[index] ?? 0) + LOG_EPSILON),
        rank / Math.max(1, candidateIds.length - 1),
        (scores[index] ?? 0) - maxScore,
        rank === 0 ? 1 : 0,
        rank < SHORTLIST_SIZE ? 1 : 0,
        rankerEntropy,
        top3Mass,
        rankerMargin,
        raw.noneLogit,
        noneProbability,
        roleBodyMass,
        roleVariantMass,
        roleMax,
        roleEntropy,
        styleProbabilities[0] ?? 0,
        styleProbabilities[1] ?? 0,
        styleProbabilities[2] ?? 0,
        styleProbabilities[8] ?? 0,
        styleProbabilities[5] ?? 0,
        styleProbabilities[7] ?? 0,
        styleProbabilities[9] ?? 0,
        orientationProbabilities[0] ?? 0,
        orientationProbabilities[1] ?? 0,
        orientationProbabilities[2] ?? 0,
        orientationProbabilities[3] ?? 0,
        orientationEntropy,
        viewGates[0] ?? 0,
        viewGates[1] ?? 0,
        viewGates[2] ?? 0,
        viewGateEntropy,
        summary.means[0],
        summary.means[1],
        summary.means[2],
        summary.lmes[0],
        summary.lmes[1],
        summary.lmes[2],
        summary.gateWeightedMean,
        Math.min(...summary.means),
        crossViewStd,
        (prototypeRankByIndex[index] ?? 0) /
          Math.max(1, candidateIds.length - 1),
        summary.gateWeightedMean - (bestPrototypeScore as number),
        summary.bagCountFraction,
      ];
      if (
        continuous.length !==
          FONT_MATCHING_SELECTION_CONTINUOUS_FEATURES.length ||
        continuous.some((value) => !Number.isFinite(value))
      ) {
        return null;
      }
      const oneHot = candidateIds.map((_unused, candidateIndex) =>
        candidateIndex === index ? 1 : 0,
      );
      return {
        candidateId,
        originalRank: rank + 1,
        values: [...continuous, ...oneHot],
      };
    });
  if (rows.some((row) => row === null)) return null;
  return {
    rows: rows as FontMatchingSelectionFeatureRow[],
    originalCandidateOrder: originalOrder.map(({ candidateId }) => candidateId),
    noneProbability,
    top1RawScore: first.score,
    top1RawMargin: first.score - second.score,
  };
}

/** v2 deliberately materializes only pixel-ranker top1 confidence inputs. */
function buildRankPreservingConfidenceFeatureSet(
  raw: FontMatchingSelectionRawFeatures,
  calibration: FontMatchingSelectionCalibration,
): FontMatchingSelectionFeatureSet | null {
  if (!validRankPreservingBoundary(raw, calibration)) return null;
  const originalOrder = raw.candidateIds
    .map((candidateId, index) => ({
      candidateId,
      index,
      score: raw.candidateScores[index] as number,
    }))
    .sort(
      (left, right) => right.score - left.score || left.index - right.index,
    );
  const first = originalOrder[0];
  const second = originalOrder[1];
  if (!first || !second) return null;
  return {
    rows: originalOrder.slice(0, SHORTLIST_SIZE).map((entry, index) => ({
      candidateId: entry.candidateId,
      originalRank: index + 1,
      values: [],
    })),
    originalCandidateOrder: originalOrder.map(({ candidateId }) => candidateId),
    noneProbability: sigmoid(raw.noneLogit),
    top1RawScore: first.score,
    top1RawMargin: first.score - second.score,
  };
}

function buildPrototypeSummaries(
  raw: FontMatchingSelectionRawFeatures,
  viewGates: readonly number[],
): readonly PrototypeSummary[] | null {
  const prototypeCount = raw.prototypeFeatures.length / raw.featureDim;
  const maxBagCount = Math.max(...raw.prototypeBags.map(({ count }) => count));
  const viewNorms = Array.from({ length: VIEW_COUNT }, (_unused, view) =>
    vectorNorm(raw.viewFeatures, view * raw.featureDim, raw.featureDim),
  );
  if (viewNorms.some((norm) => !Number.isFinite(norm))) return null;
  const prototypeNorms = Array.from(
    { length: prototypeCount },
    (_unused, index) =>
      vectorNorm(raw.prototypeFeatures, index * raw.featureDim, raw.featureDim),
  );
  if (prototypeNorms.some((norm) => !Number.isFinite(norm))) return null;
  return raw.prototypeBags.map((bag) => {
    const perView = Array.from({ length: VIEW_COUNT }, (_unused, view) => {
      const similarities = Array.from(
        { length: bag.count },
        (_entry, offset) => {
          const prototypeIndex = bag.start + offset;
          return cosineAt(
            raw.viewFeatures,
            view * raw.featureDim,
            Math.max(viewNorms[view] ?? 0, LOG_EPSILON),
            raw.prototypeFeatures,
            prototypeIndex * raw.featureDim,
            Math.max(prototypeNorms[prototypeIndex] ?? 0, LOG_EPSILON),
            raw.featureDim,
          );
        },
      );
      return { mean: mean(similarities), lme: logMeanExp(similarities) };
    });
    const means = [
      perView[0]?.mean ?? 0,
      perView[1]?.mean ?? 0,
      perView[2]?.mean ?? 0,
    ] as const;
    const lmes = [
      perView[0]?.lme ?? 0,
      perView[1]?.lme ?? 0,
      perView[2]?.lme ?? 0,
    ] as const;
    return {
      means,
      lmes,
      gateWeightedMean: means.reduce(
        (sum, value, index) => sum + value * (viewGates[index] ?? 0),
        0,
      ),
      bagCountFraction: bag.count / maxBagCount,
    };
  });
}

function validBoundary(
  raw: FontMatchingSelectionRawFeatures,
  calibration: FontMatchingSelectionCalibration,
): boolean {
  const candidateCount = raw.candidateIds.length;
  const prototypeCount = raw.prototypeFeatures.length / raw.featureDim;
  return Boolean(
    isSupportedFontMatchingSelectionCandidateCount(candidateCount) &&
    sameStrings(raw.candidateIds, calibration.candidateIds) &&
    raw.candidateScores.length === candidateCount &&
    allFinite(raw.candidateScores) &&
    Number.isFinite(raw.runtimeTemperature) &&
    raw.runtimeTemperature > 0 &&
    Number.isFinite(raw.noneLogit) &&
    raw.roleLogits.length === ROLE_COUNT &&
    allFinite(raw.roleLogits) &&
    raw.styleLogits.length === STYLE_COUNT &&
    allFinite(raw.styleLogits) &&
    raw.orientationLogits.length === ORIENTATION_COUNT &&
    allFinite(raw.orientationLogits) &&
    validProbabilityDistribution(raw.viewGateWeights, VIEW_COUNT) &&
    Number.isInteger(raw.featureDim) &&
    raw.featureDim > 0 &&
    raw.viewFeatures.length === VIEW_COUNT * raw.featureDim &&
    allFinite(raw.viewFeatures) &&
    Number.isInteger(prototypeCount) &&
    prototypeCount > 0 &&
    allFinite(raw.prototypeFeatures) &&
    validPrototypeBags(raw.prototypeBags, raw.candidateIds, prototypeCount),
  );
}

function validRankPreservingBoundary(
  raw: FontMatchingSelectionRawFeatures,
  calibration: FontMatchingSelectionCalibration,
): boolean {
  return Boolean(
    isSupportedFontMatchingSelectionCandidateCount(raw.candidateIds.length) &&
    sameStrings(raw.candidateIds, calibration.candidateIds) &&
    raw.candidateScores.length === raw.candidateIds.length &&
    allFinite(raw.candidateScores) &&
    Number.isFinite(raw.noneLogit),
  );
}

function validPrototypeBags(
  bags: readonly FontMatchingPrototypeBag[],
  candidateIds: readonly string[],
  prototypeCount: number,
): boolean {
  if (bags.length !== candidateIds.length) return false;
  let expectedStart = 0;
  for (const [index, bag] of bags.entries()) {
    if (
      bag.candidateId !== candidateIds[index] ||
      bag.start !== expectedStart ||
      !Number.isInteger(bag.count) ||
      bag.count <= 0
    ) {
      return false;
    }
    expectedStart += bag.count;
  }
  return expectedStart === prototypeCount;
}

function softmax(values: readonly number[], temperature: number): number[] {
  const maximum = Math.max(...values.map((value) => value / temperature));
  const exponentials = values.map((value) =>
    Math.exp(value / temperature - maximum),
  );
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  return exponentials.map((value) => value / total);
}

function normalizedEntropy(probabilities: readonly number[]): number {
  if (probabilities.length <= 1) return 0;
  return (
    -probabilities.reduce((sum, probability) => {
      const clipped = Math.max(LOG_EPSILON, Math.min(1, probability));
      return sum + clipped * Math.log(clipped);
    }, 0) / Math.log(probabilities.length)
  );
}

function logMeanExp(values: readonly number[]): number {
  const scaled = values.map((value) => value * PROTOTYPE_LME_SCALE);
  const maximum = Math.max(...scaled);
  const meanExponential =
    scaled.reduce((sum, value) => sum + Math.exp(value - maximum), 0) /
    scaled.length;
  return (maximum + Math.log(meanExponential)) / PROTOTYPE_LME_SCALE;
}

function cosineAt(
  left: NumericValues,
  leftOffset: number,
  leftNorm: number,
  right: NumericValues,
  rightOffset: number,
  rightNorm: number,
  length: number,
): number {
  let dot = 0;
  for (let index = 0; index < length; index += 1) {
    dot += (left[leftOffset + index] ?? 0) * (right[rightOffset + index] ?? 0);
  }
  return dot / (leftNorm * rightNorm);
}

function vectorNorm(
  values: NumericValues,
  offset: number,
  length: number,
): number {
  let squared = 0;
  for (let index = 0; index < length; index += 1) {
    squared += (values[offset + index] ?? 0) ** 2;
  }
  return Math.sqrt(squared);
}

function populationStandardDeviation(values: readonly number[]): number {
  const average = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      values.length,
  );
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sumSlice(
  values: readonly number[],
  start: number,
  end: number,
): number {
  return values.slice(start, end).reduce((sum, value) => sum + value, 0);
}

function sigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

function validProbabilityDistribution(
  values: NumericValues,
  length: number,
): boolean {
  if (values.length !== length || !allFinite(values)) return false;
  const probabilities = toNumbers(values);
  return (
    probabilities.every((value) => value >= 0 && value <= 1) &&
    Math.abs(probabilities.reduce((sum, value) => sum + value, 0) - 1) <= 1e-4
  );
}

function allFinite(values: NumericValues): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (!Number.isFinite(values[index])) return false;
  }
  return true;
}

function toNumbers(values: NumericValues): number[] {
  return Array.from(
    { length: values.length },
    (_unused, index) => values[index] ?? 0,
  );
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
