import type { StartSoundEffectTranslationRequest } from "../../shared/analysisTypes";
import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import { createSoundEffectReviewPageRevision } from "../../shared/pageRevision";
import type { PageRevision } from "../../shared/pageRevisionTypes";
import {
  resolvePendingSoundEffectReviewRegions,
  type SoundEffectReviewRegion,
} from "../../shared/soundEffectReview";

export type StoredSoundEffectTarget = {
  page: MangaPage;
  revision: PageRevision;
  regions: SoundEffectReviewRegion[];
};

/** Resolve every renderer selection against the authoritative stored chapter. */
export function resolveStoredSoundEffectTargets(
  chapter: ChapterSnapshot,
  request: StartSoundEffectTranslationRequest,
): StoredSoundEffectTarget[] {
  if (chapter.id !== request.chapterId) {
    throw new Error("효과음 번역 화가 다릅니다.");
  }
  const pages = new Map(chapter.pages.map((page) => [page.id, page]));
  return request.targets.map((requested) => {
    const page = pages.get(requested.pageId);
    if (!page) {
      throw new Error(`효과음 번역 페이지가 없습니다: ${requested.pageId}`);
    }
    const revision = createSoundEffectReviewPageRevision(page);
    if (revision !== requested.pageRevision) {
      throw new Error(
        `${page.name}: 효과음 후보가 변경되었습니다. 페이지를 새로고침한 뒤 다시 시도하세요.`,
      );
    }
    const pending = resolvePendingSoundEffectReviewRegions(
      page.soundEffectReview,
      page.blocks,
    );
    const requestedIds = requested.regionIds
      ? new Set(requested.regionIds)
      : null;
    const regions = requestedIds
      ? pending.filter((region) => requestedIds.has(region.id))
      : pending;
    if (requestedIds && regions.length !== requestedIds.size) {
      throw new Error(
        `${page.name}: 선택한 효과음 후보가 더 이상 pending이 아닙니다.`,
      );
    }
    if (regions.length === 0) {
      throw new Error(`${page.name}: 번역할 pending 효과음 후보가 없습니다.`);
    }
    return { page, revision, regions };
  });
}

export function countChapterPendingSoundEffectRegions(
  chapter: ChapterSnapshot,
): number {
  return chapter.pages.reduce(
    (count, page) =>
      count +
      resolvePendingSoundEffectReviewRegions(
        page.soundEffectReview,
        page.blocks,
      ).length,
    0,
  );
}
