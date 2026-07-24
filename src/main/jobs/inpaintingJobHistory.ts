import type { MangaPage } from "../../shared/libraryTypes";
import type { InpaintingJobContext } from "./inpaintingJobTypes";
import type { InpaintingJobRuntime } from "./inpaintingJobRuntime";

export async function saveInpaintingPageResult({
  context,
  resultPage,
  transactionId,
  chapterId,
  previousPage,
  runtime,
}: {
  context: InpaintingJobContext;
  resultPage: MangaPage;
  transactionId: string | null;
  chapterId: string;
  previousPage: MangaPage;
  runtime: InpaintingJobRuntime;
}) {
  const revisionStore = context.inpaintingRevisionStore;
  const changeAdded = Boolean(
    revisionStore &&
    transactionId &&
    revisionStore.addChange(transactionId, {
      chapterId,
      pageId: previousPage.id,
      beforePath: previousPage.inpaintedImagePath,
      afterPath: resultPage.inpaintedImagePath,
    }),
  );
  try {
    return await runtime.savePages(
      chapterId,
      [resultPage],
      revisionStore
        ? {
            retainedInpaintedArtifactPaths:
              revisionStore.getRetainedArtifactPaths(chapterId),
          }
        : undefined,
    );
  } catch (error) {
    if (changeAdded && transactionId) {
      await revisionStore?.removeChange(
        transactionId,
        chapterId,
        previousPage.id,
      );
    }
    throw error;
  }
}
