import type { MangaPage } from "../../shared/libraryTypes";
import {
  pageMatchesInpaintingLayoutStates,
  type InpaintingBlockLayoutState,
} from "../inpainting/inpaintingLayoutState";
import { translationCompletionsEqual } from "../inpainting/inpaintingRevisionHelpers";
import type { InpaintingJobContext } from "./inpaintingJobTypes";
import type { InpaintingJobRuntime } from "./inpaintingJobRuntime";

export async function saveInpaintingPageResult({
  context,
  result,
  transactionId,
  targetPage,
  runtime,
}: {
  context: InpaintingJobContext;
  result: {
    page: MangaPage;
    beforeLayout?: InpaintingBlockLayoutState[];
    afterLayout?: InpaintingBlockLayoutState[];
    blocksErased?: number;
    workflowReceiptChanged?: boolean;
  };
  transactionId: string | null;
  targetPage: { chapterId: string; page: MangaPage };
  runtime: InpaintingJobRuntime;
}) {
  if (result.page.id !== targetPage.page.id) {
    throw new Error(
      "인페인팅 결과 페이지가 요청한 페이지와 일치하지 않습니다.",
    );
  }
  const revisionStore = context.inpaintingRevisionStore;
  const changeAdded = Boolean(
    revisionStore &&
    transactionId &&
    revisionStore.addChange(transactionId, {
      chapterId: targetPage.chapterId,
      pageId: targetPage.page.id,
      beforePath: targetPage.page.inpaintedImagePath,
      afterPath: result.page.inpaintedImagePath,
      beforeLayout: result.beforeLayout,
      afterLayout: result.afterLayout,
      beforeTranslationCompletion: targetPage.page.translationCompletion,
      afterTranslationCompletion: result.page.translationCompletion,
    }),
  );
  try {
    const savedChapter = await runtime.savePages(
      targetPage.chapterId,
      [result.page],
      buildInpaintingSaveOptions({
        afterLayout: result.afterLayout,
        beforeLayout: result.beforeLayout,
        chapterId: targetPage.chapterId,
        pageId: targetPage.page.id,
        revisionStore,
      }),
    );
    assertInpaintingResultWasSaved(savedChapter.pages, result);
    return savedChapter;
  } catch (error) {
    if (changeAdded && transactionId) {
      await revisionStore?.removeChange(
        transactionId,
        targetPage.chapterId,
        targetPage.page.id,
      );
    }
    throw error;
  }
}

function assertInpaintingResultWasSaved(
  savedPages: readonly MangaPage[],
  result: {
    page: MangaPage;
    afterLayout?: InpaintingBlockLayoutState[];
  },
): void {
  const savedPage = savedPages.find((page) => page.id === result.page.id);
  if (!savedPage) {
    throw new Error("저장된 화에서 인페인팅 결과 페이지를 찾지 못했습니다.");
  }
  if (savedPage.inpaintedImagePath !== result.page.inpaintedImagePath) {
    throw new Error("인페인팅 결과 이미지가 저장되지 않았습니다.");
  }
  if (!pageMatchesInpaintingLayoutStates(savedPage, result.afterLayout)) {
    throw new Error("인페인팅 후처리 결과가 저장되지 않았습니다.");
  }
  if (
    !translationCompletionsEqual(
      savedPage.translationCompletion,
      result.page.translationCompletion,
    )
  ) {
    throw new Error("번역 완료 상태가 저장되지 않았습니다.");
  }
}

function buildInpaintingSaveOptions({
  afterLayout,
  beforeLayout,
  chapterId,
  pageId,
  revisionStore,
}: {
  afterLayout?: InpaintingBlockLayoutState[];
  beforeLayout?: InpaintingBlockLayoutState[];
  chapterId: string;
  pageId: string;
  revisionStore: InpaintingJobContext["inpaintingRevisionStore"];
}): Parameters<InpaintingJobRuntime["savePages"]>[2] {
  const hasLayout = Boolean(afterLayout?.length);
  if (!revisionStore && !hasLayout) {
    return undefined;
  }
  return {
    ...(hasLayout
      ? {
          layoutPatches: [
            {
              pageId,
              states: afterLayout ?? [],
              ...(beforeLayout ? { expectedStates: beforeLayout } : {}),
            },
          ],
        }
      : {}),
    ...(revisionStore
      ? {
          retainedInpaintedArtifactPaths:
            revisionStore.getRetainedArtifactPaths(chapterId),
        }
      : {}),
  };
}
