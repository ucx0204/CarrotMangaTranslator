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
        canCompleteTranslationWorkflowWithoutTargets(page, state, target),
    )
  ) {
    throw new Error(tMain("inpainting.noTargets"));
  }
}

export async function markFailedTranslationCompletions(
  request: StartInpaintingRequest,
  state: InpaintingJobState,
  runtime: InpaintingJobRuntime,
  ownedPages?: ReadonlySet<string>,
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
        return (!ownedPages || ownedPages.has(`${chapterId}/${page.id}`)) &&
          targetPageIds.has(page.id) &&
          completion?.workflow === expectedWorkflow &&
          completion.status === "pending" &&
          !completion.erasedBlockIds?.length
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

export function assertRequestedBlockExists(
  targets: readonly { page: MangaPage }[],
  target: InpaintingTarget,
): void {
  if (!target.blockId) {
    return;
  }
  const page = targets[0]?.page;
  if (
    targets.length !== 1 ||
    !page?.blocks.some((block) => block.id === target.blockId)
  ) {
    throw new Error("선택한 텍스트 블록을 페이지에서 찾지 못했습니다.");
  }
}

export function assertInpaintingCompletionWorkflow(
  page: MangaPage,
  state: InpaintingJobState,
): void {
  const completion = page.translationCompletion;
  if (
    completion?.status === "pending" &&
    state.requestedCompletionWorkflow &&
    completion.workflow !== state.requestedCompletionWorkflow
  ) {
    throw new Error(
      "페이지의 원문 제거 방식이 변경되었습니다. 최신 내용으로 다시 실행해 주세요.",
    );
  }
}
