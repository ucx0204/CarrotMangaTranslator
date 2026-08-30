import type { JobState } from "../../../../shared/jobTypes";
import type {
  ChapterSnapshot,
  MangaPage,
} from "../../../../shared/libraryTypes";
import { isPageFullyCompleted } from "../../../../shared/pageCompletion";
import { createPageRevision } from "../../../../shared/pageRevision";
import { resolveJobActive } from "./appSessionSelectors";

export function resolveLockedJobTargetPageIds(
  jobState: Pick<JobState, "kind" | "status" | "targets">,
  currentChapter: ChapterSnapshot | null,
  pageLockActive = resolveJobActive(jobState.status),
): ReadonlySet<string> {
  if (!pageLockActive || !currentChapter) return new Set();
  const pagesById = new Map(
    currentChapter.pages.map((page) => [page.id, page]),
  );
  return new Set(
    (jobState.targets ?? []).flatMap((target) => {
      if (target.chapterId !== currentChapter.id) return [];
      const page = pagesById.get(target.pageId);
      if (!page || target.revision !== createPageRevision(page)) return [];
      if (jobState.kind === "gemma-analysis" && isPageFullyCompleted(page)) {
        return [];
      }
      return [target.pageId];
    }),
  );
}

export function resolveSelectedPageEditLocked(
  pageLockActive: boolean,
  targetPageIds: ReadonlySet<string>,
  selectedPage: MangaPage | null,
  jobKind: JobState["kind"],
  targetSnapshotCount: number,
): boolean {
  if (!pageLockActive || !selectedPage) return false;
  if (targetPageIds.size > 0) return targetPageIds.has(selectedPage.id);
  if (targetSnapshotCount > 0) return false;
  if (jobKind === "inpainting") return true;
  return selectedPage.analysisStatus === "running";
}
