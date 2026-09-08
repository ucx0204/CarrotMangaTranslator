import type {
  PrepareSoundEffectTranslationRequest,
  PrepareSoundEffectTranslationResult,
  RestoreSoundEffectReviewRequest,
} from "../../shared/analysisTypes";
import type { ChapterSnapshot } from "../../shared/libraryTypes";
import type { PageRevision } from "../../shared/pageRevisionTypes";
import {
  appendResolvedSoundEffectBlocksUnlocked,
  dismissSoundEffectReviewRegionUnlocked,
  prepareSoundEffectTranslationUnlocked,
  restoreSoundEffectReviewUnlocked,
  type ResolvedSoundEffectBlock,
} from "../libraryStore/librarySoundEffectMutations";
import { notifyLinkedWorkspacePagesSaved } from "../linkedWorkspace/linkedWorkspaceNotifications";
import { withLibraryMutation } from "./lock";

export async function restoreSoundEffectReview(
  request: RestoreSoundEffectReviewRequest,
): Promise<ChapterSnapshot> {
  const chapter = await withLibraryMutation(() =>
    restoreSoundEffectReviewUnlocked(request),
  );
  notifyLinkedWorkspacePagesSaved(
    request.chapterId,
    request.pages.map((page) => page.pageId),
  );
  return chapter;
}

export async function appendResolvedSoundEffectBlocks(
  chapterId: string,
  pageId: string,
  expectedRevision: PageRevision,
  entries: readonly ResolvedSoundEffectBlock[],
  image?: Parameters<typeof appendResolvedSoundEffectBlocksUnlocked>[4],
): Promise<ChapterSnapshot> {
  const chapter = await withLibraryMutation(() =>
    appendResolvedSoundEffectBlocksUnlocked(
      chapterId,
      pageId,
      expectedRevision,
      entries,
      image,
    ),
  );
  notifyLinkedWorkspacePagesSaved(chapterId, [pageId]);
  return chapter;
}

export async function dismissSoundEffectReviewRegion(
  chapterId: string,
  pageId: string,
  regionId: string,
): Promise<ChapterSnapshot> {
  const chapter = await withLibraryMutation(() =>
    dismissSoundEffectReviewRegionUnlocked(chapterId, pageId, regionId),
  );
  notifyLinkedWorkspacePagesSaved(chapterId, [pageId]);
  return chapter;
}

export async function prepareSoundEffectTranslation(
  request: PrepareSoundEffectTranslationRequest,
): Promise<PrepareSoundEffectTranslationResult> {
  const result = await withLibraryMutation(() =>
    prepareSoundEffectTranslationUnlocked(request),
  );
  notifyLinkedWorkspacePagesSaved(
    request.chapterId,
    request.pages.map((page) => page.pageId),
  );
  return result;
}
