import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import type {
  PrepareSoundEffectTranslationRequest,
  PrepareSoundEffectTranslationResult,
} from "../../shared/analysisTypes";
import { createSoundEffectReviewPageRevision } from "../../shared/pageRevision";
import type { PageRevision } from "../../shared/pageRevisionTypes";
import {
  normalizeSoundEffectReview,
  resolveEffectiveSoundEffectReviewRegions,
  SOUND_EFFECT_REVIEW_CONTRACT_VERSION,
} from "../../shared/soundEffectReview";
import { hydrateChapter } from "./chapterSnapshots";
import { resolveChapterStatus } from "./chapterRecords";
import {
  findChapterLocation,
  readChapterFile,
  readWorkFile,
  type ChapterFile,
} from "./libraryFiles";
import { runLibraryTransaction } from "./libraryTransaction";
import { stageChapterFile, stageWorkFile } from "./libraryTransactionFiles";
import { applySoundEffectReviewDraft } from "./librarySoundEffectReviewDraft";
import { resolveCompletionAfterBlockMutation } from "./translationCompletionInvalidation";

export type ResolvedSoundEffectBlock = {
  regionId: string;
  block: MangaPage["blocks"][number];
};

export type PrepareSoundEffectTranslationRuntime = {
  findChapterLocation: typeof findChapterLocation;
  readChapterFile: typeof readChapterFile;
  now: () => string;
  commitChapterAndWork: (
    chapter: ChapterFile,
    updatedAt: string,
  ) => Promise<void>;
};

const prepareProductionRuntime: PrepareSoundEffectTranslationRuntime = {
  findChapterLocation,
  readChapterFile,
  now: () => new Date().toISOString(),
  commitChapterAndWork: async (chapter, updatedAt) => {
    const work = await readWorkFile(chapter.workId);
    if (!work) throw new Error("작품을 찾지 못했습니다.");
    await runLibraryTransaction(
      "prepare-sound-effect-translation",
      async (transaction) => {
        await stageChapterFile(transaction, chapter);
        await stageWorkFile(transaction, { ...work, updatedAt });
      },
    );
  },
};

/**
 * Commit the modal's complete review draft before starting the model job.
 * Detector regions remain immutable; only overrides, manual additions and the
 * dismissal ledger are updated. All touched pages share one transaction.
 */
export function createPrepareSoundEffectTranslationMutation(
  runtime: PrepareSoundEffectTranslationRuntime,
): (
  request: PrepareSoundEffectTranslationRequest,
) => Promise<PrepareSoundEffectTranslationResult> {
  return async (request) => {
    const locator = await runtime.findChapterLocation(request.chapterId);
    if (!locator) throw new Error("효과음 검토 화를 찾지 못했습니다.");
    const chapter = await runtime.readChapterFile(
      locator.workId,
      locator.chapterId,
    );
    if (!chapter) throw new Error("효과음 검토 화를 찾지 못했습니다.");
    const now = runtime.now();
    const draftsByPageId = new Map(
      request.pages.map((draft) => [draft.pageId, draft]),
    );
    const includedByPage = new Map<string, string[]>();
    let dismissedRegionCount = 0;
    const pages = chapter.pages.map((page) => {
      const draft = draftsByPageId.get(page.id);
      if (!draft) return page;
      draftsByPageId.delete(page.id);
      if (createSoundEffectReviewPageRevision(page) !== draft.pageRevision) {
        throw new Error(
          `${page.name}: 효과음 후보가 변경되었습니다. 모달을 다시 열어 주세요.`,
        );
      }
      const applied = applySoundEffectReviewDraft(page, draft, now);
      includedByPage.set(page.id, applied.includedRegionIds);
      dismissedRegionCount += applied.dismissedRegionCount;
      return applied.page;
    });
    if (draftsByPageId.size > 0) {
      throw new Error("효과음 검토 페이지를 찾지 못했습니다.");
    }
    const nextChapter = { ...chapter, pages, updatedAt: now };
    await runtime.commitChapterAndWork(nextChapter, now);
    return buildPreparedSoundEffectResult(
      nextChapter,
      includedByPage,
      dismissedRegionCount,
    );
  };
}

export const prepareSoundEffectTranslationUnlocked =
  createPrepareSoundEffectTranslationMutation(prepareProductionRuntime);

function buildPreparedSoundEffectResult(
  chapter: ChapterFile,
  includedByPage: ReadonlyMap<string, string[]>,
  dismissedRegionCount: number,
): PrepareSoundEffectTranslationResult {
  const hydrated = hydrateChapter(chapter);
  const targets = hydrated.pages.flatMap((page) => {
    const regionIds = includedByPage.get(page.id) ?? [];
    return regionIds.length > 0
      ? [
          {
            pageId: page.id,
            pageRevision: createSoundEffectReviewPageRevision(page),
            regionIds,
          },
        ]
      : [];
  });
  return {
    chapter: hydrated,
    targets,
    includedRegionCount: targets.reduce(
      (count, target) => count + (target.regionIds?.length ?? 0),
      0,
    ),
    dismissedRegionCount,
  };
}

/**
 * Append translated SFX blocks and resolve their detector candidates in the
 * same library transaction. The persisted page is re-read and validated; no
 * renderer-supplied geometry or source text reaches this mutation.
 */
export async function appendResolvedSoundEffectBlocksUnlocked(
  chapterId: string,
  pageId: string,
  expectedRevision: PageRevision,
  entries: readonly ResolvedSoundEffectBlock[],
): Promise<ChapterSnapshot> {
  if (entries.length === 0) {
    throw new Error("저장할 효과음 번역 결과가 없습니다.");
  }
  assertUniqueEntries(entries);
  const locator = await findChapterLocation(chapterId);
  if (!locator) throw new Error("저장할 화를 찾지 못했습니다.");
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) throw new Error("저장할 화를 찾지 못했습니다.");
  const page = chapter.pages.find((candidate) => candidate.id === pageId);
  if (!page?.soundEffectReview) {
    throw new Error("저장된 효과음 검토 후보를 찾지 못했습니다.");
  }
  if (createSoundEffectReviewPageRevision(page) !== expectedRevision) {
    throw new Error(
      "효과음 검토 페이지가 작업 중 변경되었습니다. 페이지를 새로고침한 뒤 다시 시도하세요.",
    );
  }
  assertEntriesStillPending(page, entries);

  const now = new Date().toISOString();
  const pages = chapter.pages.map((candidate) =>
    candidate.id === pageId
      ? applyResolvedSoundEffectEntries(candidate, entries, now)
      : candidate,
  );
  const nextChapter: ChapterFile = {
    ...chapter,
    pages,
    status: resolveChapterStatus(pages),
    updatedAt: now,
  };
  const work = await readWorkFile(locator.workId);
  if (!work) throw new Error("작품을 찾지 못했습니다.");
  await runLibraryTransaction(
    "append-resolved-sound-effect-blocks",
    async (transaction) => {
      await stageChapterFile(transaction, nextChapter);
      await stageWorkFile(transaction, { ...work, updatedAt: now });
    },
  );
  return hydrateChapter(nextChapter);
}

/**
 * Hide a detector false positive from pending review without deleting its
 * immutable source region. This keeps the decision reversible in persisted
 * data and prevents a later detector refresh from silently resurrecting it.
 */
export async function dismissSoundEffectReviewRegionUnlocked(
  chapterId: string,
  pageId: string,
  regionId: string,
): Promise<ChapterSnapshot> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) throw new Error("화를 찾지 못했습니다.");
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) throw new Error("화를 찾지 못했습니다.");
  const page = chapter.pages.find((candidate) => candidate.id === pageId);
  const review = page?.soundEffectReview;
  if (!page || !review) throw new Error("효과음 검토 후보를 찾지 못했습니다.");
  const normalized = normalizeSoundEffectReview(review);
  if (
    !resolveEffectiveSoundEffectReviewRegions(normalized).some(
      (region) => region.id === regionId,
    )
  ) {
    throw new Error(`저장된 효과음 후보가 없습니다: ${regionId}`);
  }
  if (normalized.resolvedRegions.some((entry) => entry.regionId === regionId)) {
    throw new Error(`이미 번역된 효과음 후보입니다: ${regionId}`);
  }
  if (normalized.dismissedRegionIds?.includes(regionId)) {
    return hydrateChapter(chapter);
  }

  const now = new Date().toISOString();
  const pages = chapter.pages.map((candidate) =>
    candidate.id === pageId
      ? applyDismissedSoundEffectRegion(candidate, regionId, now)
      : candidate,
  );
  const nextChapter: ChapterFile = {
    ...chapter,
    pages,
    updatedAt: now,
  };
  const work = await readWorkFile(locator.workId);
  if (!work) throw new Error("작품을 찾지 못했습니다.");
  await runLibraryTransaction(
    "dismiss-sound-effect-review-region",
    async (transaction) => {
      await stageChapterFile(transaction, nextChapter);
      await stageWorkFile(transaction, { ...work, updatedAt: now });
    },
  );
  return hydrateChapter(nextChapter);
}

export function applyResolvedSoundEffectEntries(
  page: ChapterFile["pages"][number],
  entries: readonly ResolvedSoundEffectBlock[],
  now: string,
): ChapterFile["pages"][number] {
  const review = page.soundEffectReview;
  if (!review) return page;
  const nextBlocks = [...page.blocks, ...entries.map((entry) => entry.block)];
  return {
    ...page,
    blocks: nextBlocks,
    soundEffectReview: {
      ...review,
      contractVersion: SOUND_EFFECT_REVIEW_CONTRACT_VERSION,
      resolvedRegions: [
        ...review.resolvedRegions,
        ...entries.map((entry) => ({
          regionId: entry.regionId,
          blockId: entry.block.id,
          resolvedAt: now,
        })),
      ],
    },
    analysisStatus: "completed",
    translationCompletion: resolveCompletionAfterBlockMutation(
      page.translationCompletion,
      page.blocks,
      nextBlocks,
    ),
    lastError: undefined,
    updatedAt: now,
  };
}

export function applyDismissedSoundEffectRegion(
  page: ChapterFile["pages"][number],
  regionId: string,
  now: string,
): ChapterFile["pages"][number] {
  const review = page.soundEffectReview;
  if (!review || review.dismissedRegionIds?.includes(regionId)) return page;
  return {
    ...page,
    soundEffectReview: {
      ...review,
      contractVersion: SOUND_EFFECT_REVIEW_CONTRACT_VERSION,
      dismissedRegionIds: [...(review.dismissedRegionIds ?? []), regionId],
    },
    updatedAt: now,
  };
}

function assertEntriesStillPending(
  page: ChapterFile["pages"][number],
  entries: readonly ResolvedSoundEffectBlock[],
): void {
  const review = page.soundEffectReview;
  if (!review) throw new Error("저장된 효과음 검토 후보를 찾지 못했습니다.");
  const normalized = normalizeSoundEffectReview(review);
  const known = new Set(
    resolveEffectiveSoundEffectReviewRegions(normalized).map(
      (region) => region.id,
    ),
  );
  const resolved = new Set(
    normalized.resolvedRegions.map((entry) => entry.regionId),
  );
  const dismissed = new Set(normalized.dismissedRegionIds ?? []);
  for (const entry of entries) {
    if (!known.has(entry.regionId)) {
      throw new Error(`저장된 효과음 후보가 없습니다: ${entry.regionId}`);
    }
    if (resolved.has(entry.regionId) || dismissed.has(entry.regionId)) {
      throw new Error(`이미 처리된 효과음 후보입니다: ${entry.regionId}`);
    }
  }
}

function assertUniqueEntries(
  entries: readonly ResolvedSoundEffectBlock[],
): void {
  if (
    new Set(entries.map((entry) => entry.regionId)).size !== entries.length ||
    new Set(entries.map((entry) => entry.block.id)).size !== entries.length
  ) {
    throw new Error("중복된 효과음 번역 결과는 저장할 수 없습니다.");
  }
}
