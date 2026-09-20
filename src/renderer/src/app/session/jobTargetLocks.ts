import type { JobState } from "../../../../shared/jobTypes";
import { useMemo } from "react";
import type {
  ChapterSnapshot,
  MangaPage,
} from "../../../../shared/libraryTypes";
import { resolveJobActive } from "./appSessionSelectors";
import {
  activityResourcesConflict,
  libraryStructureResource,
  pageContentResource,
  type AppActivityState,
} from "../../../../shared/appActivityTypes";

export function resolvePageActivityLocks({
  activities,
  activeInputPages,
  currentChapter,
  selectedPage,
  jobState,
  progressState,
}: {
  activities?: AppActivityState | null;
  activeInputPages?: ReadonlySet<string>;
  currentChapter: ChapterSnapshot | null;
  selectedPage: MangaPage | null;
  jobState: Pick<JobState, "kind" | "targets">;
  progressState: {
    jobActive: boolean;
    pageLockActive: boolean;
    jobTargetPageIds: ReadonlySet<string>;
  };
}) {
  const selectedPageEditLocked =
    activities && currentChapter && selectedPage
      ? isPageActivityLocked(
          activities,
          currentChapter.id,
          selectedPage.id,
          activeInputPages,
        )
      : resolveSelectedPageEditLocked(
          progressState.pageLockActive,
          progressState.jobTargetPageIds,
          selectedPage,
          jobState.kind,
          jobState.targets?.length ?? 0,
        );
  return {
    selectedPageEditLocked,
    ...resolveChapterActivityLocks(activities, currentChapter, progressState),
  };
}

function resolveChapterActivityLocks(
  activities: AppActivityState | null | undefined,
  chapter: ChapterSnapshot | null,
  progress: { jobActive: boolean; jobTargetPageIds: ReadonlySet<string> },
) {
  const { finishing, reserved, targets } = collectChapterReservations(
    activities,
    chapter?.id,
  );
  const { editing, removal } = collectChapterWriteLocks(
    activities,
    chapter,
    finishing,
    reserved,
  );
  return {
    removalLockedPageIds:
      activities && chapter ? removal : progress.jobTargetPageIds,
    editingLockedPageIds:
      activities && chapter ? editing : progress.jobTargetPageIds,
    modelResourceBusy: activities
      ? activities.activities.some((activity) =>
          activityResourcesConflict(
            [{ kind: "model-runtime", scope: "*", access: "write" }],
            activity.resources,
          ),
        )
      : progress.jobActive,
    chapterStructureLocked: Boolean(
      chapter &&
      activities?.activities.some((activity) =>
        activityResourcesConflict(
          [libraryStructureResource("chapter", chapter.id)],
          activity.resources,
        ),
      ),
    ),
    jobTargetPageIds: activities ? targets : progress.jobTargetPageIds,
  };
}

function collectChapterReservations(
  activities: AppActivityState | null | undefined,
  chapterId: string | undefined,
) {
  const finishing = new Set<string>();
  const reserved = new Set<string>();
  const targets = new Set<string>();
  for (const page of activities?.pages ?? []) {
    if (page.chapterId !== chapterId) continue;
    targets.add(page.pageId);
    if (page.phase === "finishing-edits") finishing.add(page.pageId);
    if (page.phase !== "completed" && page.phase !== "failed")
      reserved.add(page.pageId);
  }
  return { finishing, reserved, targets };
}

function collectChapterWriteLocks(
  activities: AppActivityState | null | undefined,
  chapter: ChapterSnapshot | null,
  finishing: ReadonlySet<string>,
  reserved: ReadonlySet<string>,
) {
  const editing = new Set<string>();
  const removal = new Set<string>();
  if (activities && chapter) {
    for (const page of chapter.pages) {
      if (
        finishing.has(page.id) ||
        activities.activities.some((activity) =>
          activityResourcesConflict(
            [pageContentResource(chapter.id, page.id)],
            activity.resources,
          ),
        )
      )
        editing.add(page.id);
      if (
        editing.has(page.id) ||
        reserved.has(page.id) ||
        activities.activities.some((activity) =>
          activityResourcesConflict(
            [libraryStructureResource("page", `${chapter.id}/${page.id}`)],
            activity.resources,
          ),
        )
      )
        removal.add(page.id);
    }
  }
  return { editing, removal };
}

export function usePageActivityLocks(
  options: Parameters<typeof resolvePageActivityLocks>[0],
) {
  const { activities, activeInputPages, currentChapter, selectedPage } =
    options;
  const { kind, targets } = options.jobState;
  const { jobActive, pageLockActive, jobTargetPageIds } = options.progressState;
  const chapterLocks = useMemo(
    () =>
      resolveChapterActivityLocks(activities, currentChapter, {
        jobActive,
        jobTargetPageIds,
      }),
    [activities, currentChapter, jobActive, jobTargetPageIds],
  );
  const selectedPageEditLocked =
    activities && currentChapter && selectedPage
      ? isPageActivityLocked(
          activities,
          currentChapter.id,
          selectedPage.id,
          activeInputPages,
        )
      : resolveSelectedPageEditLocked(
          pageLockActive,
          jobTargetPageIds,
          selectedPage,
          kind,
          targets?.length ?? 0,
        );
  return useMemo(
    () => ({ ...chapterLocks, selectedPageEditLocked }),
    [chapterLocks, selectedPageEditLocked],
  );
}

function isPageActivityLocked(
  state: AppActivityState,
  chapterId: string,
  pageId: string,
  activeInputPages?: ReadonlySet<string>,
): boolean {
  return (
    state.activities.some((activity) =>
      activityResourcesConflict(
        [pageContentResource(chapterId, pageId)],
        activity.resources,
      ),
    ) ||
    state.pages.some(
      (page) =>
        page.chapterId === chapterId &&
        page.pageId === pageId &&
        page.phase === "finishing-edits" &&
        !activeInputPages?.has(`${chapterId}/${pageId}`),
    )
  );
}

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
      if (!page) return [];
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
