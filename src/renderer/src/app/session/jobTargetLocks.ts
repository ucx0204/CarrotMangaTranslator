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
    removalLockedPageIds: resolveRemovalLocks(
      activities,
      currentChapter,
      progressState.jobTargetPageIds,
    ),
    editingLockedPageIds:
      activities && currentChapter
        ? new Set(
            currentChapter.pages
              .filter((page) =>
                isPageActivityLocked(activities, currentChapter.id, page.id),
              )
              .map((page) => page.id),
          )
        : progressState.jobTargetPageIds,
    modelResourceBusy: activities
      ? activities.activities.some((activity) =>
          activityResourcesConflict(
            [{ kind: "model-runtime", scope: "*", access: "write" }],
            activity.resources,
          ),
        )
      : progressState.jobActive,
    chapterStructureLocked: Boolean(
      currentChapter &&
      activities?.activities.some((activity) =>
        activityResourcesConflict(
          [libraryStructureResource("chapter", currentChapter.id)],
          activity.resources,
        ),
      ),
    ),
    jobTargetPageIds: activities
      ? new Set(
          activities.pages
            .filter((page) => page.chapterId === currentChapter?.id)
            .map((page) => page.pageId),
        )
      : progressState.jobTargetPageIds,
  };
}

function resolveRemovalLocks(
  state: AppActivityState | null | undefined,
  chapter: ChapterSnapshot | null,
  fallback: ReadonlySet<string>,
): ReadonlySet<string> {
  if (!state || !chapter) return fallback;
  return new Set(
    chapter.pages
      .filter(
        (page) =>
          isPageActivityLocked(state, chapter.id, page.id) ||
          state.pages.some(
            (entry) =>
              entry.chapterId === chapter.id &&
              entry.pageId === page.id &&
              entry.phase !== "completed" &&
              entry.phase !== "failed",
          ) ||
          state.activities.some((activity) =>
            activityResourcesConflict(
              [libraryStructureResource("page", `${chapter.id}/${page.id}`)],
              activity.resources,
            ),
          ),
      )
      .map((page) => page.id),
  );
}

export function usePageActivityLocks(
  options: Parameters<typeof resolvePageActivityLocks>[0],
) {
  const { activities, activeInputPages, currentChapter, selectedPage } =
    options;
  const { kind, targets } = options.jobState;
  const { jobActive, pageLockActive, jobTargetPageIds } = options.progressState;
  return useMemo(
    () =>
      resolvePageActivityLocks({
        activities,
        activeInputPages,
        currentChapter,
        selectedPage,
        jobState: { kind, targets },
        progressState: { jobActive, pageLockActive, jobTargetPageIds },
      }),
    [
      activities,
      activeInputPages,
      currentChapter,
      selectedPage,
      kind,
      targets,
      jobActive,
      pageLockActive,
      jobTargetPageIds,
    ],
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
