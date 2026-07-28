import type { MangaPage } from "../../shared/libraryTypes";
import type { InpaintingBlockLayoutState } from "../inpainting/inpaintingLayoutState";
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
  };
  transactionId: string | null;
  targetPage: { chapterId: string; page: MangaPage };
  runtime: InpaintingJobRuntime;
}) {
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
    }),
  );
  try {
    return await runtime.savePages(
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
