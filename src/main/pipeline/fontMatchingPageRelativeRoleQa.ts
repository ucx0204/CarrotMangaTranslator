/* eslint-disable max-lines -- the isolated QA policy keeps its full pixel-only contract auditable in one module */
import type {
  FontMatchingSemanticRole,
  FontMatchRolePredictionV2,
  FontMatchingTreatmentV2,
} from "../../shared/fontMatchingProfileTypes";
import { STABLE_BALLOON_BODY_FONT_IDS } from "./automaticFontMatchingV2PageFamily";
import {
  FONT_MATCHING_GLYPH_MORPHOLOGY_CONTRACT_VERSION,
  type FontMatchingGlyphMorphologyV1,
} from "./fontMatchingPagePixelPreprocessing";
import {
  readFontMatchingOcrGeometryDirection,
  type FontMatchingOcrGeometryDirectionV2,
} from "./fontMatchingOcrGeometryDirection";
import type {
  FontMatchingOcrCandidateMembershipV2,
  OverlayItem,
} from "./types";

const DIALOGUE_ROLE = "dialogue";
const EMPHASIS_ROLE = "emphasis_dialogue";
const SINGLE_DAY_FONT_ID = "single-day";
const BODY_ROLES = new Set<FontMatchingSemanticRole>([
  "dialogue",
  "narration",
  "thought",
]);

/**
 * Evaluation-only policy. It is reachable only through an explicit page
 * inference request flag; normal application requests never enable it.
 */
export const FONT_MATCHING_PAGE_RELATIVE_ROLE_QA_POLICY = Object.freeze({
  version: "font-matching-page-relative-role-qa-v2",
  minimumStrongDialogueProbability: 0.62,
  minimumSeedCount: 2,
  minimumSelfAnchoredClusterSize: 4,
  minimumSelfAnchoredSubstantiveRows: 3,
  minimumDominantClusterShare: 0.5,
  minimumSelfAnchorMedianDialogueProbability: 0.1,
  maximumSelfAnchorMedianGlobalDistance: 1.7,
  maximumSelfAnchorMedianComponentDistance: 1.65,
  minimumSelfAnchorMedianForegroundLuma: 42,
  minimumRecoveryDialogueProbability: 0.025,
  maximumCompleteLinkMorphologyDistance: 1,
  morphologyScales: Object.freeze({
    globalDistance: 0.34,
    componentDistance: 0.42,
    componentFill: 0.24,
    foregroundLuma: 28,
  }),
  fragmentMaximumLongEdge: 100,
  fragmentMaximumComponentCount: 10,
  fragmentMaximumShortEdge: 60,
  transferMaximumRawRank: 3,
  splitPeerMaximumEdgeGap: 34,
  splitPeerMaximumCenterDistanceRatio: 1.75,
  minimumStrongVariantWinnerProbability: 0.4,
  minimumStrongVariantBodyGap: 0.28,
  minimumStrongBodyWinnerProbability: 0.55,
  minimumStrongBodyTop2Gap: 0.18,
  peerScoreMinimumLift: 0.0001,
});

export function assertPageRelativeQaPolicyVersions(
  audits: readonly Readonly<{ policyVersion?: unknown }>[],
): void {
  for (const audit of audits) {
    const version = audit.policyVersion;
    if (version === FONT_MATCHING_PAGE_RELATIVE_ROLE_QA_POLICY.version) {
      continue;
    }
    throw new Error(
      `Page-relative QA consistency policy version mismatch: ${String(version ?? "missing")}`,
    );
  }
}

type ScoreFamily = "body" | "variant";
type PageRelativeGeometryItem = Pick<
  OverlayItem,
  "id" | "bbox" | "candidateIds"
>;

export type FontMatchingPageRelativeRoleQaInputRow = Readonly<{
  blockId: string;
  item?: PageRelativeGeometryItem;
  pixelRole: FontMatchRolePredictionV2;
  dialogueProbability: number;
  emphasisProbability: number;
  glyphMorphology?: FontMatchingGlyphMorphologyV1;
  sourceGeometryDirection?: FontMatchingOcrGeometryDirectionV2;
  sourceCandidateMembership?: FontMatchingOcrCandidateMembershipV2;
  treatment: Pick<FontMatchingTreatmentV2, "distortion" | "orientation">;
  candidateIds: readonly string[];
  bodyScores: ArrayLike<number>;
  variantScores: ArrayLike<number>;
  temperature: number;
  baselineCalibrationApplied: boolean;
  baselineSelectedFontId: string | null;
}>;

export type FontMatchingPageRelativeRoleQaPlanRow = Readonly<{
  blockId: string;
  originalRole: FontMatchingSemanticRole;
  projectedRole: FontMatchingSemanticRole;
  routeFamily: ScoreFamily;
  sourceGeometryDirection: FontMatchingOcrGeometryDirectionV2 | null;
  clusterId: string | null;
  clusterBodyAnchorFontId: string | null;
  preferredPeerFontId: string | null;
  peerBlockId: string | null;
  reasonCodes: readonly string[];
  applied: boolean;
}>;

type MutablePlanRow = {
  input: FontMatchingPageRelativeRoleQaInputRow;
  projectedRole: FontMatchingSemanticRole;
  routeFamily: ScoreFamily;
  clusterId: string | null;
  clusterBodyAnchorFontId: string | null;
  preferredPeerFontId: string | null;
  peerBlockId: string | null;
  reasonCodes: string[];
};

/**
 * Build a page-local route plan from pixel evidence plus code-owned OCR bbox
 * direction. The input type does not expose OCR/translation text, Gemma roles,
 * work id, or genre.
 */
export function buildFontMatchingPageRelativeRoleQaPlan(
  inputRows: readonly FontMatchingPageRelativeRoleQaInputRow[],
): ReadonlyMap<string, FontMatchingPageRelativeRoleQaPlanRow> {
  const rows = inputRows.map<MutablePlanRow>((input) => ({
    input,
    projectedRole: input.pixelRole.primary,
    routeFamily: BODY_ROLES.has(input.pixelRole.primary) ? "body" : "variant",
    clusterId: null,
    clusterBodyAnchorFontId: null,
    preferredPeerFontId: null,
    peerBlockId: null,
    reasonCodes: [],
  }));
  recoverDominantOrdinaryRows(rows);
  applySplitFragmentPeerPreferences(rows);
  return new Map(
    rows.map((row) => {
      const applied =
        row.projectedRole !== row.input.pixelRole.primary ||
        row.preferredPeerFontId !== null;
      return [
        row.input.blockId,
        {
          blockId: row.input.blockId,
          originalRole: row.input.pixelRole.primary,
          projectedRole: row.projectedRole,
          routeFamily: row.routeFamily,
          sourceGeometryDirection: readFontMatchingOcrGeometryDirection(
            row.input.sourceGeometryDirection,
            row.input.item,
            row.input.sourceCandidateMembership,
          ),
          clusterId: row.clusterId,
          clusterBodyAnchorFontId: row.clusterBodyAnchorFontId,
          preferredPeerFontId: row.preferredPeerFontId,
          peerBlockId: row.peerBlockId,
          reasonCodes: [...row.reasonCodes],
          applied,
        },
      ];
    }),
  );
}

/**
 * Apply a peer preference after the existing role-based eligibility mask.
 * Every candidate remains eligible/ineligible exactly as the existing mask
 * decided; only an already-top3 peer candidate can become rank one.
 */
export function applyFontMatchingPageRelativePeerScorePreference(
  candidateIds: readonly string[],
  eligibleScores: ArrayLike<number>,
  eligibleMask: ArrayLike<number>,
  plan: FontMatchingPageRelativeRoleQaPlanRow | undefined,
): Float32Array {
  if (
    candidateIds.length !== eligibleScores.length ||
    candidateIds.length !== eligibleMask.length
  ) {
    throw new Error("Page-relative QA candidate score boundary drifted.");
  }
  const scores = Float32Array.from(eligibleScores);
  const preferredFontId = plan?.preferredPeerFontId;
  if (!preferredFontId) return scores;
  const preferredIndex = candidateIds.indexOf(preferredFontId);
  if (preferredIndex < 0) return scores;
  if (eligibleMask[preferredIndex] !== 1) return scores;
  const bestCompetitor = maximumCompetingScore(scores, preferredIndex);
  if (!Number.isFinite(bestCompetitor)) return scores;
  const current = scores[preferredIndex] ?? -Infinity;
  if (current > bestCompetitor) return scores;
  const lift = Math.max(
    FONT_MATCHING_PAGE_RELATIVE_ROLE_QA_POLICY.peerScoreMinimumLift,
    Math.abs(bestCompetitor) *
      FONT_MATCHING_PAGE_RELATIVE_ROLE_QA_POLICY.peerScoreMinimumLift,
  );
  scores[preferredIndex] = Math.fround(bestCompetitor + lift);
  return scores;
}

function maximumCompetingScore(
  scores: ArrayLike<number>,
  excludedIndex: number,
): number {
  let maximum = -Infinity;
  for (let index = 0; index < scores.length; index += 1) {
    if (index === excludedIndex) continue;
    maximum = Math.max(maximum, scores[index] ?? -Infinity);
  }
  return maximum;
}

/** Preserve the raw pixel confidence as the strength of the gated projection. */
export function projectFontMatchingPageRelativeRole(
  pixelRole: FontMatchRolePredictionV2,
  plan: FontMatchingPageRelativeRoleQaPlanRow | undefined,
): FontMatchRolePredictionV2 {
  if (!plan?.applied || plan.projectedRole === pixelRole.primary) {
    return pixelRole;
  }
  const alternatives = [
    { role: pixelRole.primary, confidence: pixelRole.confidence },
    ...pixelRole.alternatives.filter(
      (entry) =>
        entry.role !== plan.projectedRole && entry.role !== pixelRole.primary,
    ),
  ].slice(0, 2);
  return {
    primary: plan.projectedRole,
    confidence: pixelRole.confidence,
    alternatives,
  };
}

/** Never let the opt-in route turn an accepted selector row into abstention. */
export function shouldRevertPageRelativeQaForApplyRate(
  baselineCalibrationApplied: boolean,
  candidateCalibrationApplied: boolean,
): boolean {
  return baselineCalibrationApplied && !candidateCalibrationApplied;
}

function recoverDominantOrdinaryRows(rows: MutablePlanRow[]): void {
  const groups = groupMorphologyRows(rows);
  let clusterSequence = 0;
  for (const [direction, directionRows] of groups) {
    const clusters = clusterMorphologyRows(directionRows);
    const dominant = chooseDominantCluster(direction, directionRows, clusters);
    if (!dominant) continue;
    const clusterBodyAnchorFontId = resolveClusterBodyAnchor(dominant);
    if (!clusterBodyAnchorFontId) continue;
    clusterSequence += 1;
    const clusterId = `${direction}:dominant-${clusterSequence}`;
    for (const row of dominant) {
      row.clusterId = clusterId;
      row.clusterBodyAnchorFontId = clusterBodyAnchorFontId;
      if (row.projectedRole !== EMPHASIS_ROLE) continue;
      if (!isSubstantiveRow(row)) {
        row.reasonCodes.push("preserve_structural_fragment_variant");
        continue;
      }
      if (
        row.input.dialogueProbability <
        FONT_MATCHING_PAGE_RELATIVE_ROLE_QA_POLICY.minimumRecoveryDialogueProbability
      ) {
        row.reasonCodes.push("preserve_near_zero_dialogue_probability");
        continue;
      }
      if (hasUnopposedStrongVariantEvidence(row)) {
        row.reasonCodes.push("preserve_strong_local_variant_pixel_gap");
        continue;
      }
      if (!bestStableBodyCandidate(row.input, "body")) {
        row.reasonCodes.push("preserve_no_top3_body_transfer_target");
        continue;
      }
      row.projectedRole = DIALOGUE_ROLE;
      row.routeFamily = "body";
      row.reasonCodes.push("page_relative_dominant_ordinary_morphology");
    }
  }
}

function groupMorphologyRows(
  rows: readonly MutablePlanRow[],
): ReadonlyMap<"horizontal" | "vertical", MutablePlanRow[]> {
  const groups = new Map<"horizontal" | "vertical", MutablePlanRow[]>();
  for (const row of rows) {
    if (
      !isValidMorphology(row.input.glyphMorphology) ||
      row.input.treatment.distortion !== "none"
    ) {
      continue;
    }
    const direction = resolveRowDirection(row);
    if (!direction) continue;
    const group = groups.get(direction) ?? [];
    group.push(row);
    groups.set(direction, group);
  }
  return groups;
}

function clusterMorphologyRows(
  rows: readonly MutablePlanRow[],
): MutablePlanRow[][] {
  const clusters = [...rows]
    .sort((left, right) =>
      compareStrings(left.input.blockId, right.input.blockId),
    )
    .map((row) => [row]);
  while (mergeClosestClusters(clusters)) {
    // Complete-link merges until every remaining pair exceeds the gate.
  }
  return clusters.sort(
    (left, right) =>
      right.length - left.length ||
      compareStrings(
        left[0]?.input.blockId ?? "",
        right[0]?.input.blockId ?? "",
      ),
  );
}

// eslint-disable-next-line complexity -- deterministic complete-link tie breaking is intentionally explicit
function mergeClosestClusters(clusters: MutablePlanRow[][]): boolean {
  let winner: {
    left: number;
    right: number;
    distance: number;
    key: string;
  } | null = null;
  for (let left = 0; left < clusters.length; left += 1) {
    for (let right = left + 1; right < clusters.length; right += 1) {
      const distance = completeLinkDistance(
        clusters[left] ?? [],
        clusters[right] ?? [],
      );
      if (
        distance >
        FONT_MATCHING_PAGE_RELATIVE_ROLE_QA_POLICY.maximumCompleteLinkMorphologyDistance
      ) {
        continue;
      }
      const key = `${clusters[left]?.[0]?.input.blockId}:${clusters[right]?.[0]?.input.blockId}`;
      if (
        !winner ||
        distance < winner.distance ||
        (distance === winner.distance && key < winner.key)
      ) {
        winner = { left, right, distance, key };
      }
    }
  }
  if (!winner) return false;
  const merged = [
    ...(clusters[winner.left] ?? []),
    ...(clusters[winner.right] ?? []),
  ].sort((left, right) =>
    compareStrings(left.input.blockId, right.input.blockId),
  );
  clusters.splice(winner.right, 1);
  clusters.splice(winner.left, 1, merged);
  return true;
}

function completeLinkDistance(
  left: readonly MutablePlanRow[],
  right: readonly MutablePlanRow[],
): number {
  let maximum = 0;
  for (const leftRow of left) {
    for (const rightRow of right) {
      maximum = Math.max(
        maximum,
        morphologyDistance(
          leftRow.input.glyphMorphology,
          rightRow.input.glyphMorphology,
        ),
      );
    }
  }
  return maximum;
}

// eslint-disable-next-line complexity -- every self-anchor measurement is a fail-closed gate
function chooseDominantCluster(
  direction: "horizontal" | "vertical",
  directionRows: readonly MutablePlanRow[],
  clusters: readonly MutablePlanRow[][],
): MutablePlanRow[] | null {
  const winner = clusters[0];
  if (!winner || winner.length === clusters[1]?.length) return null;
  if (
    winner.length / directionRows.length <
    FONT_MATCHING_PAGE_RELATIVE_ROLE_QA_POLICY.minimumDominantClusterShare
  ) {
    return null;
  }
  const substantive = winner.filter(isSubstantiveRow);
  const seedCount = substantive.filter(
    (row) =>
      row.input.dialogueProbability >=
      FONT_MATCHING_PAGE_RELATIVE_ROLE_QA_POLICY.minimumStrongDialogueProbability,
  ).length;
  const selfAnchored =
    direction === "vertical" &&
    winner.length >=
      FONT_MATCHING_PAGE_RELATIVE_ROLE_QA_POLICY.minimumSelfAnchoredClusterSize &&
    substantive.length >=
      FONT_MATCHING_PAGE_RELATIVE_ROLE_QA_POLICY.minimumSelfAnchoredSubstantiveRows &&
    median(substantive.map((row) => row.input.dialogueProbability)) >=
      FONT_MATCHING_PAGE_RELATIVE_ROLE_QA_POLICY.minimumSelfAnchorMedianDialogueProbability &&
    median(
      substantive.map(
        (row) =>
          row.input.glyphMorphology?.globalForegroundDistanceMean ?? Infinity,
      ),
    ) <=
      FONT_MATCHING_PAGE_RELATIVE_ROLE_QA_POLICY.maximumSelfAnchorMedianGlobalDistance &&
    median(
      substantive.map(
        (row) =>
          row.input.glyphMorphology?.medianComponentDistanceMean ?? Infinity,
      ),
    ) <=
      FONT_MATCHING_PAGE_RELATIVE_ROLE_QA_POLICY.maximumSelfAnchorMedianComponentDistance &&
    median(
      substantive.map(
        (row) => row.input.glyphMorphology?.foregroundMeanLuma ?? -Infinity,
      ),
    ) >=
      FONT_MATCHING_PAGE_RELATIVE_ROLE_QA_POLICY.minimumSelfAnchorMedianForegroundLuma;
  return seedCount >=
    FONT_MATCHING_PAGE_RELATIVE_ROLE_QA_POLICY.minimumSeedCount || selfAnchored
    ? winner
    : null;
}

function resolveClusterBodyAnchor(
  cluster: readonly MutablePlanRow[],
): string | null {
  const votes = new Map<string, { support: number; value: number }>();
  for (const row of cluster) {
    for (const candidate of rankedCandidates(row.input, "body").slice(
      0,
      FONT_MATCHING_PAGE_RELATIVE_ROLE_QA_POLICY.transferMaximumRawRank,
    )) {
      if (!STABLE_BALLOON_BODY_FONT_IDS.has(candidate.fontId)) continue;
      const vote = votes.get(candidate.fontId) ?? { support: 0, value: 0 };
      vote.support += 1;
      vote.value += candidate.probability / candidate.rank;
      votes.set(candidate.fontId, vote);
    }
  }
  const winner = [...votes.entries()].sort(
    ([leftId, left], [rightId, right]) =>
      right.support - left.support ||
      right.value - left.value ||
      compareStrings(leftId, rightId),
  )[0];
  return winner && winner[1].support >= Math.min(2, cluster.length)
    ? winner[0]
    : null;
}

// eslint-disable-next-line complexity -- dual-head corroboration stays explicit for QA audit
function hasUnopposedStrongVariantEvidence(row: MutablePlanRow): boolean {
  if (
    row.input.baselineCalibrationApplied &&
    row.input.baselineSelectedFontId &&
    STABLE_BALLOON_BODY_FONT_IDS.has(row.input.baselineSelectedFontId)
  ) {
    return false;
  }
  const variant = rankedCandidates(row.input, "variant");
  const winner = variant[0];
  if (!winner || STABLE_BALLOON_BODY_FONT_IDS.has(winner.fontId)) return false;
  const bodyInVariant = variant.find((candidate) =>
    STABLE_BALLOON_BODY_FONT_IDS.has(candidate.fontId),
  );
  const strongVariant =
    winner.probability >=
      FONT_MATCHING_PAGE_RELATIVE_ROLE_QA_POLICY.minimumStrongVariantWinnerProbability &&
    winner.probability - (bodyInVariant?.probability ?? 0) >=
      FONT_MATCHING_PAGE_RELATIVE_ROLE_QA_POLICY.minimumStrongVariantBodyGap;
  if (!strongVariant) return false;
  const body = rankedCandidates(row.input, "body");
  const bodyWinner = body[0];
  const bodyRunner = body[1];
  const strongBodyCounter =
    Boolean(
      bodyWinner && STABLE_BALLOON_BODY_FONT_IDS.has(bodyWinner.fontId),
    ) &&
    (bodyWinner?.probability ?? 0) >=
      FONT_MATCHING_PAGE_RELATIVE_ROLE_QA_POLICY.minimumStrongBodyWinnerProbability &&
    (bodyWinner?.probability ?? 0) - (bodyRunner?.probability ?? 0) >=
      FONT_MATCHING_PAGE_RELATIVE_ROLE_QA_POLICY.minimumStrongBodyTop2Gap;
  return !strongBodyCounter;
}

function bestStableBodyCandidate(
  row: FontMatchingPageRelativeRoleQaInputRow,
  family: ScoreFamily,
): string | null {
  return (
    rankedCandidates(row, family)
      .slice(
        0,
        FONT_MATCHING_PAGE_RELATIVE_ROLE_QA_POLICY.transferMaximumRawRank,
      )
      .find((candidate) => STABLE_BALLOON_BODY_FONT_IDS.has(candidate.fontId))
      ?.fontId ?? null
  );
}

function applySplitFragmentPeerPreferences(rows: MutablePlanRow[]): void {
  for (const row of rows) {
    if (!isEligibleSingleDayFragment(row)) continue;
    const peer = nearestSplitPeer(row, rows);
    if (!peer) {
      row.reasonCodes.push("preserve_isolated_single_day_variant");
      continue;
    }
    row.preferredPeerFontId = peer.fontId;
    row.peerBlockId = peer.row.input.blockId;
    row.reasonCodes.push("split_fragment_peer_rank");
  }
}

function isEligibleSingleDayFragment(row: MutablePlanRow): boolean {
  return Boolean(
    row.input.baselineCalibrationApplied &&
    row.input.baselineSelectedFontId === SINGLE_DAY_FONT_ID &&
    row.projectedRole === EMPHASIS_ROLE &&
    isFragmentGeometry(row) &&
    row.input.emphasisProbability >= 0.9,
  );
}

// eslint-disable-next-line complexity -- peer geometry/rank gates are deliberately conjunctive
function nearestSplitPeer(
  row: MutablePlanRow,
  rows: readonly MutablePlanRow[],
): { row: MutablePlanRow; fontId: string; value: number } | null {
  const left = normalizedBbox(row.input.item);
  if (!left) return null;
  let winner: { row: MutablePlanRow; fontId: string; value: number } | null =
    null;
  for (const peer of rows) {
    if (!isEligiblePeer(row, peer)) continue;
    const peerFontId = peer.input.baselineSelectedFontId;
    if (!peerFontId || peerFontId === SINGLE_DAY_FONT_ID) continue;
    const targetRank = rankedCandidates(row.input, "variant").find(
      (candidate) => candidate.fontId === peerFontId,
    )?.rank;
    if (
      !targetRank ||
      targetRank >
        FONT_MATCHING_PAGE_RELATIVE_ROLE_QA_POLICY.transferMaximumRawRank
    ) {
      continue;
    }
    const right = normalizedBbox(peer.input.item);
    if (!right) continue;
    const xGap = axisGap(left.x, left.x + left.w, right.x, right.x + right.w);
    const yGap = axisGap(left.y, left.y + left.h, right.y, right.y + right.h);
    const edgeGap = Math.hypot(xGap, yGap);
    const centerDistance = Math.hypot(
      left.x + left.w / 2 - (right.x + right.w / 2),
      left.y + left.h / 2 - (right.y + right.h / 2),
    );
    const maximumEdge = Math.max(left.w, left.h, right.w, right.h);
    const morphology = morphologyDistance(
      row.input.glyphMorphology,
      peer.input.glyphMorphology,
    );
    if (
      edgeGap >
        FONT_MATCHING_PAGE_RELATIVE_ROLE_QA_POLICY.splitPeerMaximumEdgeGap ||
      centerDistance / maximumEdge >
        FONT_MATCHING_PAGE_RELATIVE_ROLE_QA_POLICY.splitPeerMaximumCenterDistanceRatio ||
      morphology > 1.15
    ) {
      continue;
    }
    const value = edgeGap + centerDistance / maximumEdge + morphology;
    if (!winner || value < winner.value) {
      winner = { row: peer, fontId: peerFontId, value };
    }
  }
  return winner;
}

function isEligiblePeer(row: MutablePlanRow, peer: MutablePlanRow): boolean {
  const direction = resolveRowDirection(row);
  return Boolean(
    peer !== row &&
    peer.input.baselineCalibrationApplied &&
    peer.projectedRole === EMPHASIS_ROLE &&
    direction !== null &&
    resolveRowDirection(peer) === direction &&
    isFragmentGeometry(peer) &&
    peer.input.emphasisProbability >= 0.9,
  );
}

function resolveRowDirection(
  row: MutablePlanRow,
): "horizontal" | "vertical" | null {
  return (
    readFontMatchingOcrGeometryDirection(
      row.input.sourceGeometryDirection,
      row.input.item,
      row.input.sourceCandidateMembership,
    )?.direction ?? null
  );
}

function rankedCandidates(
  row: FontMatchingPageRelativeRoleQaInputRow,
  family: ScoreFamily,
): Array<{ fontId: string; probability: number; rank: number }> {
  const scores = family === "body" ? row.bodyScores : row.variantScores;
  const probabilities = softmax(scores, row.temperature);
  return row.candidateIds
    .map((fontId, index) => ({
      fontId,
      probability: probabilities[index] ?? 0,
      index,
    }))
    .sort(
      (left, right) =>
        right.probability - left.probability || left.index - right.index,
    )
    .map(({ fontId, probability }, index) => ({
      fontId,
      probability,
      rank: index + 1,
    }));
}

function softmax(values: ArrayLike<number>, temperature: number): number[] {
  const divisor =
    Number.isFinite(temperature) && temperature > 0 ? temperature : 1;
  const scaled = Array.from(values, (value) => Number(value) / divisor);
  const maximum = Math.max(...scaled);
  const exponentials = scaled.map((value) => Math.exp(value - maximum));
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  return exponentials.map((value) => value / Math.max(Number.EPSILON, total));
}

function isSubstantiveRow(row: MutablePlanRow): boolean {
  return Boolean(
    !isFragmentGeometry(row) &&
    row.input.treatment.distortion === "none" &&
    isValidMorphology(row.input.glyphMorphology),
  );
}

function isFragmentGeometry(row: MutablePlanRow): boolean {
  const bbox = normalizedBbox(row.input.item);
  if (!bbox) return true;
  if ((row.input.item?.candidateIds?.length ?? 0) > 1) return false;
  const morphology = row.input.glyphMorphology;
  if (!morphology) return true;
  const longEdge = Math.max(bbox.w, bbox.h);
  const shortEdge = Math.min(bbox.w, bbox.h);
  return (
    longEdge <=
      FONT_MATCHING_PAGE_RELATIVE_ROLE_QA_POLICY.fragmentMaximumLongEdge ||
    (shortEdge <=
      FONT_MATCHING_PAGE_RELATIVE_ROLE_QA_POLICY.fragmentMaximumShortEdge &&
      morphology.connectedComponentCount <=
        FONT_MATCHING_PAGE_RELATIVE_ROLE_QA_POLICY.fragmentMaximumComponentCount)
  );
}

function normalizedBbox(
  item: PageRelativeGeometryItem | undefined,
): { x: number; y: number; w: number; h: number } | null {
  const bbox = item?.bbox;
  if (!bbox || ![bbox.x, bbox.y, bbox.w, bbox.h].every(Number.isFinite))
    return null;
  return bbox.w > 0 && bbox.h > 0 ? bbox : null;
}

function isValidMorphology(
  morphology: FontMatchingGlyphMorphologyV1 | undefined,
): morphology is FontMatchingGlyphMorphologyV1 {
  return Boolean(
    morphology?.contractVersion ===
      FONT_MATCHING_GLYPH_MORPHOLOGY_CONTRACT_VERSION &&
    morphology.maskSource === "raw_grayscale_otsu_minority_area3" &&
    morphology.distanceTransform === "opencv_dist_l2_mask5" &&
    morphology.connectivity === 8 &&
    Number.isInteger(morphology.connectedComponentCount) &&
    [
      morphology.globalForegroundDistanceMean,
      morphology.medianComponentDistanceMean,
      morphology.medianComponentFill,
      morphology.foregroundMeanLuma,
    ].every(Number.isFinite),
  );
}

function morphologyDistance(
  left: FontMatchingGlyphMorphologyV1 | undefined,
  right: FontMatchingGlyphMorphologyV1 | undefined,
): number {
  if (!isValidMorphology(left) || !isValidMorphology(right)) return Infinity;
  const scale = FONT_MATCHING_PAGE_RELATIVE_ROLE_QA_POLICY.morphologyScales;
  return Math.max(
    Math.abs(
      left.globalForegroundDistanceMean - right.globalForegroundDistanceMean,
    ) / scale.globalDistance,
    Math.abs(
      left.medianComponentDistanceMean - right.medianComponentDistanceMean,
    ) / scale.componentDistance,
    Math.abs(left.medianComponentFill - right.medianComponentFill) /
      scale.componentFill,
    Math.abs(left.foregroundMeanLuma - right.foregroundMeanLuma) /
      scale.foregroundLuma,
  );
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function axisGap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): number {
  return Math.max(
    0,
    Math.max(leftStart, rightStart) - Math.min(leftEnd, rightEnd),
  );
}

function compareStrings(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}
