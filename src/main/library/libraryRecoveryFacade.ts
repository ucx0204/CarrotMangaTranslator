import { commitPageRecoveryUnlocked } from "../libraryStore/libraryPageRecovery";
import { assertLibraryActivityAccess, withLibraryMutation } from "./lock";
import { pageContentResource } from "../../shared/appActivityTypes";
import { notifyLinkedWorkspacePagesSaved } from "../linkedWorkspace/linkedWorkspaceNotifications";

/** Native ownership and atomic page/assets/receipt publication, before renderer notification. */
export async function commitPageRecovery(
  ...args: Parameters<typeof commitPageRecoveryUnlocked>
) {
  const saved = await withLibraryMutation(() => {
    assertLibraryActivityAccess(
      args[0].map((item) => pageContentResource(item.chapterId, item.pageId)),
    );
    return commitPageRecoveryUnlocked(...args);
  });
  for (const chapterId of new Set(saved.map((item) => item.chapterId)))
    notifyLinkedWorkspacePagesSaved(
      chapterId,
      saved
        .filter((item) => item.chapterId === chapterId)
        .map((item) => item.page.id),
    );
  return saved;
}
