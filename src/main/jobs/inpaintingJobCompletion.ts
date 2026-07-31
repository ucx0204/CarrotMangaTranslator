import type {
  StartInpaintingRequest,
  StartInpaintingResult,
} from "../../shared/inpaintingTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import {
  canCompleteTranslationWorkflowWithoutTargets,
  pageHasMatchingTranslationCompletion,
  resolveExpectedTranslationCompletionWorkflow,
} from "./inpaintingJobPageCompletion";
import type {
  InpaintingJobState,
  InpaintingTarget,
} from "./inpaintingJobPageTypes";
import type { InpaintingJobRuntime } from "./inpaintingJobRuntime";
import { tMain } from "./localization";

type OpenedChapter = Awaited<ReturnType<InpaintingJobRuntime["openChapter"]>>;

export function assertInpaintingJobHasTargets(
  targets: readonly { page: MangaPage }[],
  state: InpaintingJobState,
  target: InpaintingTarget,
  totalTargetBlocks: number,
): void {
  if (
    totalTargetBlocks <= 0 &&
    !targets.some(
      ({ page }) =>
        pageHasMatchingTranslationCompletion(page, state, target) &&
        canCompleteTranslationWorkflowWithoutTargets(page, target),
    )
  ) {
    throw new Error(tMain("inpainting.noTargets"));
  }
}

export async function markFailedTranslationCompletions(
  request: StartInpaintingRequest,
  state: InpaintingJobState,
  runtime: InpaintingJobRuntime,
): Promise<void> {
  if (!canOwnFullPageCompletion(request)) return;
  const expectedWorkflow = resolveExpectedTranslationCompletionWorkflow(state);
  for (const [chapterId, targetPageIds] of state.targetPageIds) {
    try {
      const chapter = await runtime
        .openChapter(chapterId)
        .catch(() => state.chapters.get(chapterId));
      if (!chapter) continue;
      const failedPages = chapter.pages.flatMap((page) => {
        const completion = page.translationCompletion;
        return targetPageIds.has(page.id) &&
          completion?.workflow === expectedWorkflow &&
          completion.status === "pending"
          ? [
              {
                ...page,
                translationCompletion: {
                  ...completion,
                  status: "failed" as const,
                },
              },
            ]
          : [];
      });
      if (failedPages.length === 0) continue;
      recordSavedInpaintingChapter(
        state,
        chapterId,
        await runtime.savePages(chapterId, failedPages),
      );
    } catch (completionError) {
      runtime.logError("Failed to persist inpainting completion failure", {
        chapterId,
        error: completionError,
      });
    }
  }
}

function canOwnFullPageCompletion(request: StartInpaintingRequest): boolean {
  return (
    request.mode === "selection-pattern" ||
    (request.mode === "page-pattern" && request.blockId === undefined)
  );
}

export async function refreshInpaintingRequestChapters(
  request: StartInpaintingRequest,
  state: InpaintingJobState,
  runtime: InpaintingJobRuntime,
): Promise<Pick<StartInpaintingResult, "chapter" | "chapters">> {
  if (request.mode !== "selection-pattern") {
    return {
      chapter: await runtime
        .openChapter(request.chapterId)
        .catch(() => state.chapter ?? undefined),
    };
  }
  if (request.selections.length !== 1) {
    return { chapters: [...state.chapters.values()] };
  }
  const chapters = await Promise.all(
    request.selections.map(async ({ chapterId }) =>
      runtime.openChapter(chapterId).catch(() => state.chapters.get(chapterId)),
    ),
  );
  return { chapters: chapters.filter((chapter) => chapter !== undefined) };
}

export function recordSavedInpaintingChapter(
  state: InpaintingJobState,
  chapterId: string,
  chapter: OpenedChapter,
): void {
  state.chapters.set(chapterId, chapter);
  if (state.chapter?.id === chapterId) state.chapter = chapter;
}
