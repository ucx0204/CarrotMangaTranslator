import type { BBox, TranslationBlock } from "./textTypes";

export const SOUND_EFFECT_REVIEW_CONTRACT_VERSION = 3 as const;
export const LEGACY_SOUND_EFFECT_REVIEW_CONTRACT_VERSION = 1 as const;
export const LEGACY_SOUND_EFFECT_REVIEW_V2_CONTRACT_VERSION = 2 as const;

export type SoundEffectReviewRegion = {
  /** Stable within one detector pass and persisted with the page. */
  id: string;
  /** Normalized 0..1000 page coordinates. */
  bbox: BBox;
  detectorConfidence: number;
  recognizedText?: string;
  sourceDetectionIds?: string[];
};

type ResolvedSoundEffectReviewRegion = {
  regionId: string;
  blockId: string;
  resolvedAt: string;
};

type SoundEffectReviewRegionOverride = {
  regionId: string;
  /** User-reviewed normalized 0..1000 page coordinates. */
  bbox: BBox;
  updatedAt: string;
};

type ManualSoundEffectReviewRegion = {
  id: string;
  /** User-authored normalized 0..1000 page coordinates. */
  bbox: BBox;
  /** A user-authored region is authoritative geometry, not detector evidence. */
  detectorConfidence: 1;
  createdAt: string;
};

export type SoundEffectReview = {
  contractVersion: typeof SOUND_EFFECT_REVIEW_CONTRACT_VERSION;
  producer: "hayai-regions-v1";
  /** Immutable detector output retained for audit and detector refreshes. */
  regions: SoundEffectReviewRegion[];
  /** Geometry corrections for detector regions. OCR anchors are invalidated. */
  regionOverrides: SoundEffectReviewRegionOverride[];
  /** Regions explicitly drawn by the user when OCR missed an effect. */
  manualRegions: ManualSoundEffectReviewRegion[];
  /** Successfully translated candidates. Regions remain immutable audit input. */
  resolvedRegions: ResolvedSoundEffectReviewRegion[];
  /** User-rejected false positives. Original regions remain immutable audit input. */
  dismissedRegionIds?: string[];
};

export type LegacySoundEffectReview = Omit<
  SoundEffectReview,
  "contractVersion" | "resolvedRegions" | "regionOverrides" | "manualRegions"
> & {
  contractVersion: typeof LEGACY_SOUND_EFFECT_REVIEW_CONTRACT_VERSION;
};

export type LegacySoundEffectReviewV2 = Omit<
  SoundEffectReview,
  "contractVersion" | "regionOverrides" | "manualRegions"
> & {
  contractVersion: typeof LEGACY_SOUND_EFFECT_REVIEW_V2_CONTRACT_VERSION;
};

export function normalizeSoundEffectReview(
  review:
    | SoundEffectReview
    | LegacySoundEffectReview
    | LegacySoundEffectReviewV2,
): SoundEffectReview {
  if (review.contractVersion === SOUND_EFFECT_REVIEW_CONTRACT_VERSION) {
    return review;
  }
  return {
    ...review,
    contractVersion: SOUND_EFFECT_REVIEW_CONTRACT_VERSION,
    resolvedRegions:
      review.contractVersion === LEGACY_SOUND_EFFECT_REVIEW_CONTRACT_VERSION
        ? []
        : review.resolvedRegions,
    regionOverrides: [],
    manualRegions: [],
  };
}

const REGION_OVERLAP_HIDE_RATIO = 0.16;
const BLOCK_OVERLAP_HIDE_RATIO = 0.4;

export function resolvePendingSoundEffectReviewRegions(
  review:
    | SoundEffectReview
    | LegacySoundEffectReview
    | LegacySoundEffectReviewV2
    | undefined,
  blocks: readonly Pick<TranslationBlock, "bbox" | "textRole">[] = [],
): SoundEffectReviewRegion[] {
  if (!review) return [];
  const normalized = normalizeSoundEffectReview(review);
  const dismissed = new Set(normalized.dismissedRegionIds ?? []);
  const resolved = new Set(
    normalized.resolvedRegions.map((entry) => entry.regionId),
  );
  const userReviewed = new Set([
    ...normalized.regionOverrides.map((entry) => entry.regionId),
    ...normalized.manualRegions.map((region) => region.id),
  ]);
  return resolveEffectiveSoundEffectReviewRegions(normalized).filter(
    (region) =>
      !dismissed.has(region.id) &&
      !resolved.has(region.id) &&
      (userReviewed.has(region.id) ||
        !blocks.some(
          (block) =>
            block.textRole !== "sound" &&
            reviewRegionConflictsWithBlock(region.bbox, block.bbox),
        )),
  );
}

/** Resolve user-reviewed geometry without mutating immutable detector records. */
export function resolveEffectiveSoundEffectReviewRegions(
  review:
    | SoundEffectReview
    | LegacySoundEffectReview
    | LegacySoundEffectReviewV2,
): SoundEffectReviewRegion[] {
  const normalized = normalizeSoundEffectReview(review);
  const overrides = new Map(
    normalized.regionOverrides.map((entry) => [entry.regionId, entry.bbox]),
  );
  const detectorRegions = normalized.regions.map((region) => {
    const bbox = overrides.get(region.id);
    if (!bbox) return region;
    const {
      recognizedText: _recognizedText,
      sourceDetectionIds: _sourceDetectionIds,
      ...withoutStaleRecognition
    } = region;
    return { ...withoutStaleRecognition, bbox };
  });
  return [
    ...detectorRegions,
    ...normalized.manualRegions.map(
      ({ createdAt: _createdAt, ...region }) => region,
    ),
  ];
}

export function reviewRegionConflictsWithBlock(
  region: BBox,
  block: BBox,
): boolean {
  const intersection = intersectionArea(region, block);
  if (intersection <= 0) return false;
  return (
    intersection / Math.max(1, region.w * region.h) >=
      REGION_OVERLAP_HIDE_RATIO ||
    intersection / Math.max(1, block.w * block.h) >= BLOCK_OVERLAP_HIDE_RATIO
  );
}

function intersectionArea(left: BBox, right: BBox): number {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.w, right.x + right.w);
  const y2 = Math.min(left.y + left.h, right.y + right.h);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}
