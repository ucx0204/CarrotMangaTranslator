import type { RankedFontCandidateV2 } from "../../shared/fontMatchingProfileTypes";
import type { VerifiedAutomaticFontPixelInferenceV2 } from "./fontMatchingPagePixelInferenceTypes";

const MAXIMUM_PIXEL_MORPHOLOGY_DISTANCE = 0.68;
const MINIMUM_PAGE_ANCHOR_SUPPORT = 2;
const MINIMUM_PAGE_ANCHOR_SUPPORT_SHARE = 0.6;
const MINIMUM_PAGE_ANCHOR_AGGREGATE_GAP = 0.08;
const MINIMUM_STABLE_MEAN_ANCHOR_PROBABILITY = 0.15;
const MINIMUM_STABLE_MAJORITY_ANCHOR_PROBABILITY = 0.1;
const MINIMUM_STABLE_MEAN_SUPPORT_SHARE = 0.6;

export type AutomaticFontPrintedFamily = "sans" | "serif";

/** Deliberately conservative body faces for visually ordinary text. */
export const STABLE_BALLOON_BODY_FONT_IDS = new Set([
  "nanum-gothic",
  "nanum-myeongjo",
  "nanum-barun-gothic",
  "seoul-namsan",
  "seoul-namsan-vertical",
  "seoul-hangang",
  "ridi-batang",
]);

export const STABLE_BALLOON_SANS_FONT_IDS = new Set([
  "nanum-gothic",
  "nanum-barun-gothic",
  "seoul-namsan",
  "seoul-namsan-vertical",
]);

export const STABLE_BALLOON_SERIF_FONT_IDS = new Set([
  "nanum-myeongjo",
  "seoul-hangang",
  "ridi-batang",
]);

/**
 * Return the rank-preserving pixel winner, not the semantic/style heads.
 * When calibration declines a verified row, automatic mode deliberately uses
 * its best renderable rank instead of falling back to the formatting font.
 */
export function resolveAutomaticFontCalibratedPixelWinner(
  inference: Pick<
    VerifiedAutomaticFontPixelInferenceV2,
    "localEvidence" | "selectionCalibration"
  >,
): RankedFontCandidateV2 | null {
  const bestAvailableSelection =
    !inference.selectionCalibration.applied &&
    inference.localEvidence.rankedCandidates.some(
      (candidate) => candidate.renderStatus === "rendered",
    );
  if (!inference.selectionCalibration.applied && !bestAvailableSelection) {
    return null;
  }
  return (
    [...inference.localEvidence.rankedCandidates]
      .filter(
        (candidate) =>
          candidate.renderStatus === "rendered" &&
          (candidate.confidence > 0 || bestAvailableSelection),
      )
      .sort(
        (left, right) =>
          right.confidence - left.confidence ||
          left.rank - right.rank ||
          compareStrings(left.fontId, right.fontId),
      )[0] ?? null
  );
}

/**
 * Select the stable body face supported by a clear page majority and return
 * only the rows that independently kept that face in their raw top three.
 * Outliers remain local instead of vetoing or inheriting the page choice.
 */
export function selectAutomaticFontStableMajorityPageAnchor(
  rows: readonly VerifiedAutomaticFontPixelInferenceV2[],
): {
  fontId: string;
  evidenceCount: number;
  supportShare: number;
  supportedBlockIds: readonly string[];
} | null {
  if (rows.length < MINIMUM_PAGE_ANCHOR_SUPPORT) return null;
  const minimumSupport = Math.max(
    MINIMUM_PAGE_ANCHOR_SUPPORT,
    Math.ceil(rows.length * MINIMUM_STABLE_MEAN_SUPPORT_SHARE),
  );
  const ranked = [...STABLE_BALLOON_BODY_FONT_IDS]
    .flatMap((fontId) => {
      const supported = rows.flatMap((row) => {
        const score = resolveStrictStableMeanCandidateScore(
          row,
          fontId,
          MINIMUM_STABLE_MAJORITY_ANCHOR_PROBABILITY,
        );
        return score === null ? [] : [{ blockId: row.blockId, score }];
      });
      // This is the partial-majority fallback. A candidate present on every
      // row must satisfy the stricter unanimous 0.15 floor above instead of
      // entering through this relaxed 0.10 boundary.
      if (
        supported.length < minimumSupport ||
        supported.length === rows.length
      ) {
        return [];
      }
      return [
        {
          fontId,
          supported,
          meanScore:
            supported.reduce((sum, entry) => sum + entry.score, 0) /
            supported.length,
        },
      ];
    })
    .sort(
      (left, right) =>
        right.supported.length - left.supported.length ||
        right.meanScore - left.meanScore ||
        compareStrings(left.fontId, right.fontId),
    );
  const winner = ranked[0];
  return winner
    ? {
        fontId: winner.fontId,
        evidenceCount: winner.supported.length,
        supportShare: winner.supported.length / rows.length,
        supportedBlockIds: winner.supported.map(({ blockId }) => blockId),
      }
    : null;
}

/** The calibrated winner itself is the reliable body-family signal. */
export function resolveAutomaticFontCalibratedBodyFamily(
  inference: Pick<
    VerifiedAutomaticFontPixelInferenceV2,
    "localEvidence" | "selectionCalibration"
  >,
): AutomaticFontPrintedFamily | null {
  const winner = resolveAutomaticFontCalibratedPixelWinner(inference);
  if (!winner) return null;
  if (STABLE_BALLOON_SANS_FONT_IDS.has(winner.fontId)) return "sans";
  return STABLE_BALLOON_SERIF_FONT_IDS.has(winner.fontId) ? "serif" : null;
}

/** Connect body rows by the verified font-score morphology, never semantic heads. */
export function clusterAutomaticFontPrintedRows(
  rows: readonly VerifiedAutomaticFontPixelInferenceV2[],
): VerifiedAutomaticFontPixelInferenceV2[][] {
  const parents = rows.map((_row, index) => index);
  for (let left = 0; left < rows.length; left += 1) {
    for (let right = left + 1; right < rows.length; right += 1) {
      const leftRow = rows[left];
      const rightRow = rows[right];
      if (
        leftRow &&
        rightRow &&
        pixelMorphologyDistance(leftRow, rightRow) <=
          MAXIMUM_PIXEL_MORPHOLOGY_DISTANCE
      ) {
        union(parents, left, right);
      }
    }
  }
  const clusters = new Map<number, VerifiedAutomaticFontPixelInferenceV2[]>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row) continue;
    const root = find(parents, index);
    const cluster = clusters.get(root) ?? [];
    cluster.push(row);
    clusters.set(root, cluster);
  }
  return [...clusters.values()];
}

export function selectAutomaticFontPageAnchor(
  rows: readonly VerifiedAutomaticFontPixelInferenceV2[],
  printedFamily: AutomaticFontPrintedFamily,
  minimumAggregateGap = MINIMUM_PAGE_ANCHOR_AGGREGATE_GAP,
): {
  fontId: string;
  evidenceCount: number;
  supportShare: number;
} | null {
  const values = collectFamilyCandidateValues(rows, printedFamily);
  const minimumSupport = Math.max(
    MINIMUM_PAGE_ANCHOR_SUPPORT,
    Math.ceil(rows.length * MINIMUM_PAGE_ANCHOR_SUPPORT_SHARE),
  );
  const ranked = [...values]
    .filter(([, scores]) => scores.length >= minimumSupport)
    .map(([fontId, scores]) => ({
      fontId,
      scores,
      aggregateScore:
        (scores.length / rows.length) * 0.55 + trimmedMean(scores) * 0.45,
    }))
    .sort((left, right) => {
      return (
        right.aggregateScore - left.aggregateScore ||
        right.scores.length - left.scores.length ||
        compareStrings(left.fontId, right.fontId)
      );
    });
  const winner = ranked[0];
  const runnerUp = ranked[1];
  if (
    !winner ||
    (runnerUp &&
      winner.aggregateScore - runnerUp.aggregateScore < minimumAggregateGap)
  ) {
    return null;
  }
  return winner
    ? {
        fontId: winner.fontId,
        evidenceCount: winner.scores.length,
        supportShare: winner.scores.length / rows.length,
      }
    : null;
}

/**
 * Select one conservative body face only when every row independently keeps
 * it inside the raw pixel top three with meaningful probability. Unlike the
 * older seed vote, this uses the mean raw model probability across the whole
 * page group so one noisy local top-one cannot fragment ordinary balloons.
 */
export function selectAutomaticFontStableMeanPageAnchor(
  rows: readonly VerifiedAutomaticFontPixelInferenceV2[],
): {
  fontId: string;
  evidenceCount: number;
  supportShare: number;
} | null {
  if (rows.length < MINIMUM_PAGE_ANCHOR_SUPPORT) return null;
  const ranked = [...STABLE_BALLOON_BODY_FONT_IDS]
    .flatMap((fontId) => {
      const scores = rows.map((row) =>
        resolveStrictStableMeanCandidateScore(row, fontId),
      );
      if (scores.some((score) => score === null)) return [];
      const values = scores.filter((score): score is number => score !== null);
      return [
        {
          fontId,
          meanScore:
            values.reduce((sum, score) => sum + score, 0) / values.length,
        },
      ];
    })
    .sort(
      (left, right) =>
        right.meanScore - left.meanScore ||
        compareStrings(left.fontId, right.fontId),
    );
  const winner = ranked[0];
  return winner
    ? {
        fontId: winner.fontId,
        evidenceCount: rows.length,
        supportShare: 1,
      }
    : null;
}

function resolveStrictStableMeanCandidateScore(
  row: VerifiedAutomaticFontPixelInferenceV2,
  fontId: string,
  minimumProbability = MINIMUM_STABLE_MEAN_ANCHOR_PROBABILITY,
): number | null {
  const candidate = row.localEvidence.rankedCandidates.find(
    (entry) => entry.fontId === fontId,
  );
  if (!candidate || !isAutomaticFontPageTransferEligible(candidate)) {
    return null;
  }
  const score = candidate.rawPixelScore;
  return typeof score === "number" &&
    Number.isFinite(score) &&
    score >= minimumProbability
    ? score
    : null;
}

export function isAutomaticFontPageTransferEligible(
  candidate: Pick<RankedFontCandidateV2, "rawPixelRank" | "renderStatus">,
): boolean {
  if (candidate.renderStatus !== "rendered") return false;
  const rawRank = candidate.rawPixelRank;
  return Boolean(
    Number.isInteger(rawRank) && Number(rawRank) >= 1 && Number(rawRank) <= 3,
  );
}

export function isStableAutomaticFontBodyCandidate(
  candidate: Pick<RankedFontCandidateV2, "fontId" | "renderStatus">,
  printedFamily: AutomaticFontPrintedFamily | null,
): boolean {
  if (candidate.renderStatus !== "rendered") return false;
  if (printedFamily === "sans") {
    return STABLE_BALLOON_SANS_FONT_IDS.has(candidate.fontId);
  }
  if (printedFamily === "serif") {
    return STABLE_BALLOON_SERIF_FONT_IDS.has(candidate.fontId);
  }
  return STABLE_BALLOON_BODY_FONT_IDS.has(candidate.fontId);
}

function collectFamilyCandidateValues(
  rows: readonly VerifiedAutomaticFontPixelInferenceV2[],
  printedFamily: AutomaticFontPrintedFamily,
): Map<string, number[]> {
  const values = new Map<string, number[]>();
  for (const row of rows) {
    const candidates = row.localEvidence.rankedCandidates.filter(
      (candidate) =>
        isStableAutomaticFontBodyCandidate(candidate, printedFamily) &&
        isAutomaticFontPageTransferEligible(candidate),
    );
    const rawTotal = candidates.reduce(
      (sum, candidate) =>
        sum + Math.max(0, candidate.rawPixelScore ?? candidate.totalScore),
      0,
    );
    const rankTotal = candidates.reduce(
      (sum, candidate) =>
        sum + 1 / Math.max(1, candidate.rawPixelRank ?? candidate.rank),
      0,
    );
    for (const candidate of candidates) {
      const value = resolveCandidateValue(candidate, rawTotal, rankTotal);
      const candidateValues = values.get(candidate.fontId) ?? [];
      candidateValues.push(value);
      values.set(candidate.fontId, candidateValues);
    }
  }
  return values;
}

function resolveCandidateValue(
  candidate: RankedFontCandidateV2,
  rawTotal: number,
  rankTotal: number,
): number {
  if (rawTotal > 0) {
    return (
      Math.max(0, candidate.rawPixelScore ?? candidate.totalScore) / rawTotal
    );
  }
  return (
    1 /
    Math.max(1, candidate.rawPixelRank ?? candidate.rank) /
    Math.max(Number.EPSILON, rankTotal)
  );
}

function pixelMorphologyDistance(
  left: VerifiedAutomaticFontPixelInferenceV2,
  right: VerifiedAutomaticFontPixelInferenceV2,
): number {
  const leftScores = topPixelScores(left);
  const rightScores = topPixelScores(right);
  const fontIds = new Set([...leftScores.keys(), ...rightScores.keys()]);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const fontId of fontIds) {
    const leftValue = leftScores.get(fontId) ?? 0;
    const rightValue = rightScores.get(fontId) ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm <= 0 || rightNorm <= 0) return 1;
  return 1 - dot / Math.sqrt(leftNorm * rightNorm);
}

function topPixelScores(
  inference: VerifiedAutomaticFontPixelInferenceV2,
): ReadonlyMap<string, number> {
  return new Map(
    inference.localEvidence.rankedCandidates
      .filter(
        (candidate) =>
          candidate.renderStatus === "rendered" &&
          (candidate.rawPixelRank ?? candidate.rank) <= 5,
      )
      .map((candidate) => [
        candidate.fontId,
        Math.max(0, candidate.rawPixelScore ?? candidate.totalScore),
      ]),
  );
}

function trimmedMean(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const selected = sorted.length >= 5 ? sorted.slice(1, -1) : sorted;
  return selected.length > 0
    ? selected.reduce((sum, value) => sum + value, 0) / selected.length
    : 0;
}

function find(parents: number[], index: number): number {
  let root = index;
  while (parents[root] !== root) root = parents[root] ?? root;
  let cursor = index;
  while (parents[cursor] !== root) {
    const next = parents[cursor] ?? root;
    parents[cursor] = root;
    cursor = next;
  }
  return root;
}

function union(parents: number[], left: number, right: number): void {
  const leftRoot = find(parents, left);
  const rightRoot = find(parents, right);
  if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
