import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import { openChapter } from "../libraryStore/libraryAccess";
import { savePageBlocksUnlocked } from "../libraryStore/libraryPageBlockMutations";
import { withLibraryMutation } from "./lock";
import { notifyLinkedWorkspacePagesSaved } from "../linkedWorkspace/linkedWorkspaceNotifications";
/** One mutation lock covers read, pure transform and the existing durable save transaction. */
export async function editPageBlocks(
  chapterId: string,
  pageId: string,
  transform: (page: MangaPage) => TranslationBlock[],
  beforeCommit: () => void,
): Promise<ChapterSnapshot> {
  const saved = await withLibraryMutation(async () => {
    const chapter = await openChapter(chapterId);
    const page = chapter.pages.find((candidate) => candidate.id === pageId);
    if (!page) throw new Error("Page not found.");
    beforeCommit();
    const blocks = transform(page);
    return savePageBlocksUnlocked(
      {
        chapterId,
        pageId,
        baseUpdatedAt: page.updatedAt,
        saveReason: "manual",
        blocks,
        blockOrder: page.blockOrder,
      },
      beforeCommit,
    );
  });
  notifyLinkedWorkspacePagesSaved(chapterId, [pageId]);
  return saved;
}
