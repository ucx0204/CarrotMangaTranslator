import {
  ANIME_TEXT_EVIDENCE_VERSION,
  ANIME_TEXT_MODEL_REVISION,
  MIN_ANIME_TEXT_CONTAINMENT,
  MIN_ANIME_TEXT_REGION_SCORE,
} from "./animeTextEvidenceContract";
import type { AnimeTextDetection, AnimeTextRegion } from "./animeTextContracts";
import type { OcrBboxResult } from "../pipeline/types";

const AMBIGUOUS_CONTAINMENT_DELTA = 0.03;
// A low-confidence leaf is never retained on score alone. It is considered
// here only so a downstream relation contract can validate an exact,
// geometry-derived partition instead of being masked by its stronger parent.
const MIN_COMPOSITE_CHILD_SCORE = 0.65;
const MIN_COMPOSITE_CHILD_CONTAINMENT = 0.95;
const MAX_COMPOSITE_CHILD_OVERLAP = 0.05;
const EVIDENCE_KEYS = [
  "animeTextRegionId",
  "animeTextRegionScore",
  "animeTextContainment",
  "animeTextRegionBbox",
  "animeTextEvidenceVersion",
  "animeTextModelRevision",
] as const;

type JsonRecord = Record<string, unknown>;
type PixelBox = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};
type NormalizedRegion = {
  id: string;
  region: AnimeTextRegion;
  area: number;
};

export type QualifyAnimeTextRelationRegionIds = (hints: unknown[]) => string[];

export function attachAnimeTextEvidence(
  result: OcrBboxResult,
  detection: AnimeTextDetection,
  qualifyRelationRegionIds: QualifyAnimeTextRelationRegionIds,
  expectedDimensions?: { width?: number; height?: number },
): OcrBboxResult {
  assertDimensions(detection, expectedDimensions);
  const regions = normalizeRegions(detection.regions);
  const projectedHints = result.hints.map((hint) =>
    projectFreshEvidence(hint, regions),
  );
  const defaultQualifiedIds =
    regions.length === 0
      ? new Set<string>()
      : new Set(qualifyRelationRegionIds(projectedHints));
  const fallback = projectCompositeLeafEvidence({
    sourceHints: result.hints,
    projectedHints,
    regions,
    defaultQualifiedIds,
    qualifyRelationRegionIds,
  });
  const evidenceHints = fallback?.hints ?? projectedHints;
  const qualifiedIds = fallback?.qualifiedIds ?? defaultQualifiedIds;
  const hints =
    qualifiedIds.size === 0
      ? result.hints.map(removeAnimeTextEvidence)
      : evidenceHints.map((hint) =>
          keepOnlyQualifiedEvidence(hint, qualifiedIds),
        );
  return hints.every((hint, index) => hint === result.hints[index])
    ? result
    : { ...result, hints };
}

function projectCompositeLeafEvidence(options: {
  sourceHints: unknown[];
  projectedHints: unknown[];
  regions: NormalizedRegion[];
  defaultQualifiedIds: Set<string>;
  qualifyRelationRegionIds: QualifyAnimeTextRelationRegionIds;
}): { hints: unknown[]; qualifiedIds: Set<string> } | null {
  const compositeParentIds = findCompositeParentIds(options.regions);
  if (compositeParentIds.size === 0) {
    return null;
  }
  const leafRegions = options.regions.filter(
    (region) => !compositeParentIds.has(region.id),
  );
  const unresolvedIndices = options.projectedHints
    .map((hint, index) =>
      options.defaultQualifiedIds.has(readProjectedRegionId(hint)) ? -1 : index,
    )
    .filter((index) => index >= 0);
  if (unresolvedIndices.length === 0) {
    return null;
  }
  const unresolved = new Set(unresolvedIndices);
  const fallbackHints = options.projectedHints.map((hint, index) =>
    unresolved.has(index)
      ? projectFreshEvidence(options.sourceHints[index], leafRegions)
      : hint,
  );
  const fallbackRegionIds = new Set(
    unresolvedIndices
      .map((index) => readProjectedRegionId(fallbackHints[index]))
      .filter(Boolean),
  );
  const newlyQualifiedIds = options
    .qualifyRelationRegionIds(fallbackHints)
    .filter(
      (regionId) =>
        !options.defaultQualifiedIds.has(regionId) &&
        fallbackRegionIds.has(regionId),
    );
  if (newlyQualifiedIds.length === 0) {
    return null;
  }
  return {
    hints: fallbackHints,
    qualifiedIds: new Set([
      ...options.defaultQualifiedIds,
      ...newlyQualifiedIds,
    ]),
  };
}

function findCompositeParentIds(regions: NormalizedRegion[]): Set<string> {
  const result = new Set<string>();
  for (const parent of regions) {
    const parentBox = tupleToBox(parent.region.bbox);
    const children = regions.filter(
      (child) =>
        child.id !== parent.id &&
        child.region.score >= MIN_COMPOSITE_CHILD_SCORE &&
        child.area < parent.area &&
        regionContainment(child, parentBox) >= MIN_COMPOSITE_CHILD_CONTAINMENT,
    );
    if (hasNearlyDisjointPair(children)) {
      result.add(parent.id);
    }
  }
  return result;
}

function hasNearlyDisjointPair(regions: NormalizedRegion[]): boolean {
  for (let leftIndex = 0; leftIndex < regions.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < regions.length;
      rightIndex += 1
    ) {
      const left = regions[leftIndex];
      const right = regions[rightIndex];
      const smallerArea = Math.min(left.area, right.area);
      if (
        smallerArea > 0 &&
        intersectionArea(
          tupleToBox(left.region.bbox),
          tupleToBox(right.region.bbox),
        ) /
          smallerArea <=
          MAX_COMPOSITE_CHILD_OVERLAP
      ) {
        return true;
      }
    }
  }
  return false;
}

function regionContainment(inner: NormalizedRegion, outer: PixelBox): number {
  if (inner.area <= 0) {
    return 0;
  }
  const innerBox = tupleToBox(inner.region.bbox);
  return centerInside(innerBox, outer)
    ? intersectionArea(innerBox, outer) / inner.area
    : 0;
}

function readProjectedRegionId(hint: unknown): string {
  return String(asRecord(hint).animeTextRegionId ?? "");
}

function projectFreshEvidence(
  hint: unknown,
  regions: NormalizedRegion[],
): unknown {
  const withoutStaleEvidence = removeAnimeTextEvidence(hint);
  const record = asRecord(withoutStaleEvidence);
  const box = readPixelBox(record);
  if (!box) {
    return withoutStaleEvidence;
  }
  const match = selectRegionMatch(box, regions);
  if (!match) {
    return withoutStaleEvidence;
  }
  return {
    ...record,
    animeTextRegionId: match.id,
    animeTextRegionScore: roundEvidence(match.region.score),
    animeTextContainment: roundEvidence(match.containment),
    animeTextRegionBbox: match.region.bbox.map(roundCoordinate),
    animeTextEvidenceVersion: ANIME_TEXT_EVIDENCE_VERSION,
    animeTextModelRevision: ANIME_TEXT_MODEL_REVISION,
  };
}

function keepOnlyQualifiedEvidence(
  hint: unknown,
  qualifiedIds: Set<string>,
): unknown {
  const record = asRecord(hint);
  const regionId = String(record.animeTextRegionId ?? "");
  return qualifiedIds.has(regionId) ? hint : removeAnimeTextEvidence(hint);
}

function removeAnimeTextEvidence(hint: unknown): unknown {
  const record = asRecord(hint);
  if (
    !EVIDENCE_KEYS.some((key) =>
      Object.prototype.hasOwnProperty.call(record, key),
    )
  ) {
    return hint;
  }
  const cleaned = { ...record };
  for (const key of EVIDENCE_KEYS) {
    delete cleaned[key];
  }
  return cleaned;
}

function normalizeRegions(regions: AnimeTextRegion[]): NormalizedRegion[] {
  return regions
    .filter(
      (region) =>
        region.label === "text_block" &&
        region.score >= MIN_ANIME_TEXT_REGION_SCORE,
    )
    .map((region) => ({
      region,
      area: boxArea(tupleToBox(region.bbox)),
    }))
    .sort(compareRegions)
    .map((entry, index) => ({
      ...entry,
      id: `ATY${String(index + 1).padStart(3, "0")}`,
    }));
}

function compareRegions(
  left: Omit<NormalizedRegion, "id">,
  right: Omit<NormalizedRegion, "id">,
): number {
  const leftBox = left.region.bbox;
  const rightBox = right.region.bbox;
  return (
    leftBox[1] - rightBox[1] ||
    leftBox[0] - rightBox[0] ||
    leftBox[3] - rightBox[3] ||
    leftBox[2] - rightBox[2] ||
    right.region.score - left.region.score
  );
}

function selectRegionMatch(
  hint: PixelBox,
  regions: NormalizedRegion[],
): {
  id: string;
  region: AnimeTextRegion;
  containment: number;
} | null {
  const hintArea = boxArea(hint);
  const matches = regions
    .map((entry) => ({
      ...entry,
      containment:
        intersectionArea(hint, tupleToBox(entry.region.bbox)) / hintArea,
    }))
    .filter((entry) => isUsableMatch(hint, entry))
    .sort(compareMatches);
  const best = matches[0];
  if (!best || hasAmbiguousRunnerUp(best, matches[1])) {
    return null;
  }
  return {
    id: best.id,
    region: best.region,
    containment: best.containment,
  };
}

function isUsableMatch(
  hint: PixelBox,
  match: NormalizedRegion & { containment: number },
): boolean {
  return (
    match.containment >= MIN_ANIME_TEXT_CONTAINMENT &&
    centerInside(hint, tupleToBox(match.region.bbox))
  );
}

function compareMatches(
  left: NormalizedRegion & { containment: number },
  right: NormalizedRegion & { containment: number },
): number {
  return (
    right.containment - left.containment ||
    left.area - right.area ||
    right.region.score - left.region.score
  );
}

function hasAmbiguousRunnerUp(
  best: NormalizedRegion & { containment: number },
  second: (NormalizedRegion & { containment: number }) | undefined,
): boolean {
  return Boolean(
    second &&
    best.containment - second.containment < AMBIGUOUS_CONTAINMENT_DELTA &&
    !mostlySameBox(best.region.bbox, second.region.bbox),
  );
}

function readPixelBox(record: JsonRecord): PixelBox | null {
  const box = {
    x1: Number(record.x1),
    y1: Number(record.y1),
    x2: Number(record.x2),
    y2: Number(record.y2),
  };
  return Object.values(box).every(Number.isFinite) && boxArea(box) > 0
    ? box
    : null;
}

function tupleToBox(bbox: [number, number, number, number]): PixelBox {
  return { x1: bbox[0], y1: bbox[1], x2: bbox[2], y2: bbox[3] };
}

function boxArea(box: PixelBox): number {
  return Math.max(0, box.x2 - box.x1) * Math.max(0, box.y2 - box.y1);
}

function intersectionArea(left: PixelBox, right: PixelBox): number {
  return (
    Math.max(0, Math.min(left.x2, right.x2) - Math.max(left.x1, right.x1)) *
    Math.max(0, Math.min(left.y2, right.y2) - Math.max(left.y1, right.y1))
  );
}

function centerInside(inner: PixelBox, outer: PixelBox): boolean {
  const x = (inner.x1 + inner.x2) / 2;
  const y = (inner.y1 + inner.y2) / 2;
  return x >= outer.x1 && x <= outer.x2 && y >= outer.y1 && y <= outer.y2;
}

function mostlySameBox(
  left: [number, number, number, number],
  right: [number, number, number, number],
): boolean {
  const leftBox = tupleToBox(left);
  const rightBox = tupleToBox(right);
  const intersection = intersectionArea(leftBox, rightBox);
  const union = boxArea(leftBox) + boxArea(rightBox) - intersection;
  return union > 0 && intersection / union >= 0.85;
}

function assertDimensions(
  detection: AnimeTextDetection,
  expected?: { width?: number; height?: number },
): void {
  const expectedWidth = Number(expected?.width);
  const expectedHeight = Number(expected?.height);
  const widthMismatch =
    Number.isFinite(expectedWidth) &&
    expectedWidth > 0 &&
    detection.imageWidth !== expectedWidth;
  const heightMismatch =
    Number.isFinite(expectedHeight) &&
    expectedHeight > 0 &&
    detection.imageHeight !== expectedHeight;
  if (!widthMismatch && !heightMismatch) {
    return;
  }
  throw new Error(
    `anime-text-yolo 이미지 크기 불일치: expected=${expectedWidth}x${expectedHeight}, actual=${detection.imageWidth}x${detection.imageHeight}`,
  );
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function roundEvidence(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function roundCoordinate(value: number): number {
  return Math.round(value * 10) / 10;
}
