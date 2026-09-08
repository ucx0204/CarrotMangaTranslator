import type { RestoreSoundEffectReviewRequest } from "../../shared/analysisTypes";
import { createSoundEffectReviewPageRevision } from "../../shared/pageRevision";
import { normalizeSoundEffectReview } from "../../shared/soundEffectReview";
import { hydrateChapter } from "./chapterSnapshots";
import type { ChapterFile } from "./libraryFiles";
import type { findChapterLocation, readChapterFile } from "./libraryFiles";

export function createRestoreSoundEffectReviewMutation(runtime: {
  findChapterLocation: typeof findChapterLocation;
  readChapterFile: typeof readChapterFile;
  now: () => string;
  commitChapterAndWork: (
    chapter: ChapterFile,
    updatedAt: string,
    operation: "restore-sound-effect-review",
  ) => Promise<void>;
}) {
  return async (request: RestoreSoundEffectReviewRequest) => {
    const locator = await runtime.findChapterLocation(request.chapterId);
    if (!locator) throw new Error("효과음 검토 화를 찾지 못했습니다.");
    const chapter = await runtime.readChapterFile(
      locator.workId,
      locator.chapterId,
    );
    if (!chapter) throw new Error("효과음 검토 화를 찾지 못했습니다.");
    const targets = new Map(request.pages.map((page) => [page.pageId, page]));
    const now = runtime.now();
    const pages = chapter.pages.map((page) => {
      const target = targets.get(page.id);
      if (!target) return page;
      targets.delete(page.id);
      return restorePage(page, target, now);
    });
    if (targets.size > 0)
      throw new Error("효과음 검토 페이지를 찾지 못했습니다.");
    const next = { ...chapter, pages, updatedAt: now };
    await runtime.commitChapterAndWork(
      next,
      now,
      "restore-sound-effect-review",
    );
    return hydrateChapter(next);
  };
}

function restorePage(
  page: ChapterFile["pages"][number],
  target: RestoreSoundEffectReviewRequest["pages"][number],
  now: string,
): ChapterFile["pages"][number] {
  if (createSoundEffectReviewPageRevision(page) !== target.pageRevision) {
    throw new Error(
      `${page.name}: 효과음 후보가 변경되었습니다. 모달을 다시 열어 주세요.`,
    );
  }
  if (!page.soundEffectReview)
    throw new Error("효과음 검토 후보를 찾지 못했습니다.");
  const review = normalizeSoundEffectReview(page.soundEffectReview);
  const known = new Set(
    [...review.regions, ...review.manualRegions].map((region) => region.id),
  );
  const dismissed = new Set(review.dismissedRegionIds ?? []);
  const resolved = new Set(
    review.resolvedRegions.map((entry) => entry.regionId),
  );
  for (const id of target.regionIds) {
    if (!known.has(id) || !dismissed.has(id) || resolved.has(id)) {
      throw new Error(`복원할 수 없는 효과음 후보입니다: ${id}`);
    }
    dismissed.delete(id);
  }
  const { dismissedRegionIds: _previous, ...preserved } = review;
  return {
    ...page,
    soundEffectReview: {
      ...preserved,
      ...(dismissed.size ? { dismissedRegionIds: [...dismissed] } : {}),
    },
    updatedAt: now,
  };
}
