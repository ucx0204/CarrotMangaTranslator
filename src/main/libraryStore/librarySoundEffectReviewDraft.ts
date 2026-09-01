import type { PrepareSoundEffectTranslationRequest } from "../../shared/analysisTypes";
import {
  normalizeSoundEffectReview,
  resolvePendingSoundEffectReviewRegions,
  SOUND_EFFECT_REVIEW_CONTRACT_VERSION,
  type SoundEffectReview,
} from "../../shared/soundEffectReview";
import type { BBox } from "../../shared/textTypes";
import type { ChapterFile } from "./libraryFiles";

type ReviewDraft = PrepareSoundEffectTranslationRequest["pages"][number];
type ReviewPage = ChapterFile["pages"][number];

type DraftState = {
  review: SoundEffectReview;
  pendingIds: Set<string>;
  knownIds: Set<string>;
  included: Set<string>;
  dismissed: Set<string>;
};

const MANUAL_REGION_ID_PATTERN =
  /^manual-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MIN_REVIEW_BBOX_EXTENT = 2;

export function applySoundEffectReviewDraft(
  page: ReviewPage,
  draft: ReviewDraft,
  now: string,
): {
  page: ReviewPage;
  includedRegionIds: string[];
  dismissedRegionCount: number;
} {
  const state = createDraftState(page, draft);
  assertDisjoint(state.included, state.dismissed);
  const addedIds = validateAddedRegions(draft, state);
  validateExistingRegionDecisions(draft, state, addedIds);
  const nextReview = applyDraftGeometry(draft, state, now);
  return {
    page: { ...page, soundEffectReview: nextReview, updatedAt: now },
    includedRegionIds: [...state.included],
    dismissedRegionCount: state.dismissed.size,
  };
}

function createDraftState(page: ReviewPage, draft: ReviewDraft): DraftState {
  const review = normalizeOrCreateReview(page.soundEffectReview);
  const pending = resolvePendingSoundEffectReviewRegions(review, page.blocks);
  return {
    review,
    pendingIds: new Set(pending.map((region) => region.id)),
    knownIds: new Set([
      ...review.regions.map((region) => region.id),
      ...review.manualRegions.map((region) => region.id),
    ]),
    included: new Set(draft.includedRegionIds),
    dismissed: new Set(draft.dismissedRegionIds),
  };
}

function validateAddedRegions(
  draft: ReviewDraft,
  state: DraftState,
): Set<string> {
  const addedIds = new Set<string>();
  for (const addition of draft.addedRegions) {
    assertReviewBbox(addition.bbox);
    if (
      !MANUAL_REGION_ID_PATTERN.test(addition.regionId) ||
      state.knownIds.has(addition.regionId) ||
      addedIds.has(addition.regionId)
    ) {
      throw new Error(`잘못된 수동 효과음 후보 ID입니다: ${addition.regionId}`);
    }
    if (!state.included.has(addition.regionId)) {
      throw new Error("제외한 새 효과음 후보는 저장할 수 없습니다.");
    }
    addedIds.add(addition.regionId);
  }
  return addedIds;
}

function validateExistingRegionDecisions(
  draft: ReviewDraft,
  state: DraftState,
  addedIds: Set<string>,
): void {
  const effectivePendingIds = new Set([...state.pendingIds, ...addedIds]);
  for (const regionId of [...state.included, ...state.dismissed]) {
    if (!effectivePendingIds.has(regionId)) {
      throw new Error(`더 이상 검토할 수 없는 효과음 후보입니다: ${regionId}`);
    }
  }
  for (const edit of draft.editedRegions) {
    assertReviewBbox(edit.bbox);
    if (
      !state.pendingIds.has(edit.regionId) ||
      state.dismissed.has(edit.regionId)
    ) {
      throw new Error(`수정할 수 없는 효과음 후보입니다: ${edit.regionId}`);
    }
  }
  for (const regionId of state.pendingIds) {
    if (!state.included.has(regionId) && !state.dismissed.has(regionId)) {
      throw new Error(`검토 결정이 누락된 효과음 후보입니다: ${regionId}`);
    }
  }
}

function applyDraftGeometry(
  draft: ReviewDraft,
  state: DraftState,
  now: string,
): SoundEffectReview {
  const overrides = new Map(
    state.review.regionOverrides.map((entry) => [entry.regionId, entry]),
  );
  const manualRegions = new Map(
    state.review.manualRegions.map((entry) => [entry.id, entry]),
  );
  for (const edit of draft.editedRegions) {
    const manual = manualRegions.get(edit.regionId);
    if (manual) {
      manualRegions.set(edit.regionId, { ...manual, bbox: edit.bbox });
    } else {
      overrides.set(edit.regionId, {
        regionId: edit.regionId,
        bbox: edit.bbox,
        updatedAt: now,
      });
    }
  }
  return buildNextReview(draft, state, overrides, manualRegions, now);
}

function buildNextReview(
  draft: ReviewDraft,
  state: DraftState,
  overrides: Map<string, SoundEffectReview["regionOverrides"][number]>,
  manualRegions: Map<string, SoundEffectReview["manualRegions"][number]>,
  now: string,
): SoundEffectReview {
  const dismissedRegionIds = new Set(state.review.dismissedRegionIds ?? []);
  for (const regionId of state.dismissed) dismissedRegionIds.add(regionId);
  const { dismissedRegionIds: _previousDismissals, ...review } = state.review;
  return {
    ...review,
    contractVersion: SOUND_EFFECT_REVIEW_CONTRACT_VERSION,
    regionOverrides: [...overrides.values()],
    manualRegions: [
      ...manualRegions.values(),
      ...draft.addedRegions.map((entry) => ({
        id: entry.regionId,
        bbox: entry.bbox,
        detectorConfidence: 1 as const,
        createdAt: now,
      })),
    ],
    ...(dismissedRegionIds.size > 0
      ? { dismissedRegionIds: [...dismissedRegionIds] }
      : {}),
  };
}

function normalizeOrCreateReview(
  review: ReviewPage["soundEffectReview"],
): SoundEffectReview {
  return review
    ? normalizeSoundEffectReview(review)
    : {
        contractVersion: SOUND_EFFECT_REVIEW_CONTRACT_VERSION,
        producer: "hayai-regions-v1",
        regions: [],
        regionOverrides: [],
        manualRegions: [],
        resolvedRegions: [],
      };
}

function assertDisjoint(left: Set<string>, right: Set<string>): void {
  for (const value of left) {
    if (right.has(value)) {
      throw new Error(
        `포함과 제외가 동시에 선택된 효과음 후보입니다: ${value}`,
      );
    }
  }
}

function assertReviewBbox(bbox: BBox): void {
  if (![bbox.x, bbox.y, bbox.w, bbox.h].every(Number.isFinite)) {
    throw new Error("효과음 후보 영역이 페이지 범위를 벗어났습니다.");
  }
  if (
    bbox.x < 0 ||
    bbox.y < 0 ||
    bbox.w < MIN_REVIEW_BBOX_EXTENT ||
    bbox.h < MIN_REVIEW_BBOX_EXTENT ||
    bbox.x + bbox.w > 1000 ||
    bbox.y + bbox.h > 1000
  ) {
    throw new Error("효과음 후보 영역이 페이지 범위를 벗어났습니다.");
  }
}
