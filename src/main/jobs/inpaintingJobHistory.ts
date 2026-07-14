import type { MangaPage } from "../../shared/libraryTypes";
import { updatePagesAfterInpainting } from "../library";
import type { InpaintingJobContext } from "./inpaintingJobTypes";

export async function saveInpaintingPageResult({
  context,
  resultPage,
  transactionId,
  chapterId,
  previousPage,
}: {
  context: InpaintingJobContext;
  resultPage: MangaPage;
  transactionId: string | null;
  chapterId: string;
  previousPage: MangaPage;
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
    return await updatePagesAfterInpainting(
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
