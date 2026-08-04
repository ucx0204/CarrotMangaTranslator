import type { RankedFontCandidateV2 } from "../../shared/fontMatchingProfileTypes";
import {
  isAutomaticFontPageTransferEligible,
  isStableAutomaticFontBodyCandidate,
  resolveAutomaticFontCalibratedPixelWinner,
  type AutomaticFontPrintedFamily,
} from "./automaticFontMatchingV2PageFamily";
import {
  candidatePixelScore,
  comparePixelCandidates,
  compareStrings,
  find,
  isDefined,
  normalizeBbox,
  resolveBestEligibleBodyCandidate,
  resolveVariantMass,
  union,
  type PageEvidenceRow,
} from "./automaticFontMatchingV2PageConsistencyShared";
import { isLikelySplitGeometryPair } from "./automaticFontMatchingV2PageConsistencyGeometryMetrics";

const MAXIMUM_COMPONENT_VARIANT_MASS = 0.65;
const MINIMUM_ULTRA_VARIANT_MASS = 0.95;
const MINIMUM_ULTRA_VARIANT_BODY_GAP = 0.45;

type ComponentAnchor = { fontId: string; evidenceCount: number };

export function applySplitGeometryComponents(rows: PageEvidenceRow[]): void {
  const components = buildSplitGeometryComponents(rows);
  let componentId = 0;
  for (const members of components.values()) {
    if (members.length < 2) continue;
    const componentRows = resolveComponentRows(rows, members);
    const family = resolveComponentBodyFamily(componentRows);
    if (!family) continue;
    const anchor = resolveComponentBodyAnchor(componentRows, family);
    if (!anchor) continue;
    applyComponentBodyFamily(componentRows, family, anchor, componentId);
    componentId += 1;
  }
}

function buildSplitGeometryComponents(
  rows: readonly PageEvidenceRow[],
): Map<number, number[]> {
  const parents = rows.map((_row, index) => index);
  for (let left = 0; left < rows.length; left += 1) {
    connectSplitGeometryPairs(rows, parents, left);
  }
  return collectGeometryComponents(rows.length, parents);
}

function connectSplitGeometryPairs(
  rows: readonly PageEvidenceRow[],
  parents: number[],
  left: number,
): void {
  for (let right = left + 1; right < rows.length; right += 1) {
    if (isLikelySplitGeometryPair(rows[left]?.item, rows[right]?.item)) {
      union(parents, left, right);
    }
  }
}

function collectGeometryComponents(
  rowCount: number,
  parents: number[],
): Map<number, number[]> {
  const components = new Map<number, number[]>();
  for (let index = 0; index < rowCount; index += 1) {
    const root = find(parents, index);
    const members = components.get(root) ?? [];
    members.push(index);
    components.set(root, members);
  }
  return components;
}

function resolveComponentRows(
  rows: readonly PageEvidenceRow[],
  members: readonly number[],
): PageEvidenceRow[] {
  return members.map((index) => rows[index]).filter(isDefined);
}

function applyComponentBodyFamily(
  rows: readonly PageEvidenceRow[],
  family: AutomaticFontPrintedFamily,
  anchor: ComponentAnchor,
  componentId: number,
): void {
  for (const row of rows) {
    if (!isEligibleForComponentBodyFamily(row, family, anchor.fontId)) continue;
    row.geometryComponentId = componentId;
    row.geometryComponentAnchorFontId = anchor.fontId;
    row.geometryComponentEvidenceCount = anchor.evidenceCount;
    row.geometryComponentForced = row.directBodyFamily !== family;
    row.recoveredBody =
      row.recoveredBody ||
      row.directBodyFamily === null ||
      row.directBodyFamily !== family;
    row.family = family;
  }
}

function isEligibleForComponentBodyFamily(
  row: PageEvidenceRow,
  family: AutomaticFontPrintedFamily,
  anchorFontId: string,
): boolean {
  if (!resolveBestEligibleBodyCandidate(row.inference, family)) return false;
  return row.inference.localEvidence.rankedCandidates.some(
    (candidate) =>
      candidate.fontId === anchorFontId &&
      isAutomaticFontPageTransferEligible(candidate),
  );
}

function resolveComponentBodyAnchor(
  rows: readonly PageEvidenceRow[],
  family: AutomaticFontPrintedFamily,
): ComponentAnchor | null {
  const votes = new Map<string, { count: number; score: number }>();
  for (const row of rows) {
    const winner = resolveComponentVoteCandidate(row, family);
    if (!winner) continue;
    const vote = votes.get(winner.fontId) ?? { count: 0, score: 0 };
    vote.count += 1;
    vote.score += candidatePixelScore(winner);
    votes.set(winner.fontId, vote);
  }
  const selected = [...votes].sort(compareComponentVotes)[0];
  return selected
    ? { fontId: selected[0], evidenceCount: selected[1].count }
    : null;
}

function resolveComponentVoteCandidate(
  row: PageEvidenceRow,
  family: AutomaticFontPrintedFamily,
): RankedFontCandidateV2 | null {
  if (!row.strongBodySeed || row.directBodyFamily !== family) return null;
  const winner = resolveBestEligibleBodyCandidate(row.inference, family);
  if (!winner) return null;
  if (!isStableAutomaticFontBodyCandidate(winner, family)) return null;
  return isAutomaticFontPageTransferEligible(winner) ? winner : null;
}

function compareComponentVotes(
  [leftFontId, left]: [string, { count: number; score: number }],
  [rightFontId, right]: [string, { count: number; score: number }],
): number {
  return (
    right.count - left.count ||
    right.score - left.score ||
    compareStrings(leftFontId, rightFontId)
  );
}

function resolveComponentBodyFamily(
  rows: readonly PageEvidenceRow[],
): AutomaticFontPrintedFamily | null {
  if (rows.some((row) => hasUltraLocalVariantEvidence(row.inference))) {
    return null;
  }
  if (resolveComponentVariantMass(rows) > MAXIMUM_COMPONENT_VARIANT_MASS) {
    return null;
  }
  const votes = collectComponentFamilyVotes(rows);
  return [...votes].sort(compareComponentFamilyVotes)[0]?.[0] ?? null;
}

function collectComponentFamilyVotes(
  rows: readonly PageEvidenceRow[],
): Map<AutomaticFontPrintedFamily, { count: number; score: number }> {
  const votes = new Map<
    AutomaticFontPrintedFamily,
    { count: number; score: number }
  >();
  for (const row of rows) {
    if (!row.directBodyFamily) continue;
    const winner = resolveAutomaticFontCalibratedPixelWinner(row.inference);
    const current = votes.get(row.directBodyFamily) ?? { count: 0, score: 0 };
    current.count += 1;
    current.score += candidatePixelScore(winner);
    votes.set(row.directBodyFamily, current);
  }
  return votes;
}

function compareComponentFamilyVotes(
  [leftFamily, left]: [
    AutomaticFontPrintedFamily,
    { count: number; score: number },
  ],
  [rightFamily, right]: [
    AutomaticFontPrintedFamily,
    { count: number; score: number },
  ],
): number {
  return (
    right.count - left.count ||
    right.score - left.score ||
    compareStrings(leftFamily, rightFamily)
  );
}

function resolveComponentVariantMass(rows: readonly PageEvidenceRow[]): number {
  let weightedMass = 0;
  let totalWeight = 0;
  for (const row of rows) {
    const bbox = normalizeBbox(row.item?.bbox);
    const weight = bbox ? Math.sqrt(bbox.w * bbox.h) : 1;
    weightedMass += resolveVariantMass(row.inference) * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? weightedMass / totalWeight : 1;
}

function hasUltraLocalVariantEvidence(
  inference: PageEvidenceRow["inference"],
): boolean {
  const bestVariant = resolveBestVariantCandidate(inference);
  const bestBody = resolveBestEligibleBodyCandidate(inference);
  return Boolean(
    resolveVariantMass(inference) >= MINIMUM_ULTRA_VARIANT_MASS &&
    candidatePixelScore(bestVariant) - candidatePixelScore(bestBody) >=
      MINIMUM_ULTRA_VARIANT_BODY_GAP,
  );
}

function resolveBestVariantCandidate(
  inference: PageEvidenceRow["inference"],
): RankedFontCandidateV2 | null {
  return (
    [...inference.localEvidence.rankedCandidates]
      .filter(
        (candidate) =>
          candidate.renderStatus === "rendered" &&
          !isStableAutomaticFontBodyCandidate(candidate, null),
      )
      .sort(comparePixelCandidates)[0] ?? null
  );
}
