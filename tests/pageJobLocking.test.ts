import { describe, expect, it } from "vitest";
import {
  resolveLockedJobTargetPageIds,
  resolvePageActivityLocks,
} from "../src/renderer/src/app/session/jobTargetLocks";
import { resolveSelectedPageEditLocked } from "../src/renderer/src/app/session/jobTargetLocks";
import type { JobState } from "../src/shared/jobTypes";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import { createPageJobTargetSnapshot } from "../src/shared/pageRevision";

describe("page-scoped job locking", () => {
  it("distinguishes model, active content and queued reservations without unlocking an unfinished input", () => {
    const pages = [
      makePage("page-1", "running"),
      makePage("page-2", "completed"),
    ];
    const chapter = makeChapter(pages);
    const base = {
      currentChapter: chapter,
      selectedPage: pages[1],
      jobState: makeJob("gemma-analysis", pages),
      progressState: {
        jobActive: true,
        pageLockActive: true,
        jobTargetPageIds: new Set(["page-1", "page-2"]),
      },
    };
    const activities = {
      version: 1,
      activities: [
        {
          id: "job-1",
          category: "job" as const,
          kind: "gemma-analysis",
          startedAt: 1,
          blocksQuit: true,
          mutatesLibrary: true,
          resources: [
            {
              kind: "model-runtime" as const,
              scope: "*",
              access: "write" as const,
            },
            {
              kind: "page-content" as const,
              scope: "chapter-1/page-1",
              access: "write" as const,
            },
            {
              kind: "library-structure" as const,
              scope: "chapter:chapter-1",
              access: "read" as const,
            },
          ],
        },
      ],
      pages: pages.map((page) => ({
        jobId: "job-1",
        chapterId: chapter.id,
        pageId: page.id,
        phase: "queued" as const,
      })),
    };
    expect(resolvePageActivityLocks({ ...base, activities })).toMatchObject({
      selectedPageEditLocked: false,
      modelResourceBusy: true,
      chapterStructureLocked: true,
      editingLockedPageIds: new Set(["page-1"]),
      jobTargetPageIds: new Set(["page-1", "page-2"]),
      removalLockedPageIds: new Set(["page-1", "page-2"]),
    });
    const released = {
      ...activities,
      pages: activities.pages.map((entry) => ({
        ...entry,
        phase: "completed" as const,
      })),
    };
    expect(
      resolvePageActivityLocks({ ...base, activities: released })
        .removalLockedPageIds,
    ).toEqual(new Set(["page-1"]));
    const structureOnly = {
      ...released,
      activities: [
        {
          ...activities.activities[0],
          resources: [
            {
              kind: "library-structure" as const,
              scope: "page:chapter-1/page-2",
              access: "write" as const,
            },
          ],
        },
      ],
    };
    expect(
      resolvePageActivityLocks({ ...base, activities: structureOnly })
        .removalLockedPageIds,
    ).toEqual(new Set(["page-2"]));
    const finishing = {
      ...activities,
      pages: [{ ...activities.pages[1], phase: "finishing-edits" as const }],
    };
    expect(
      resolvePageActivityLocks({ ...base, activities: finishing })
        .selectedPageEditLocked,
    ).toBe(true);
    expect(
      resolvePageActivityLocks({
        ...base,
        activities: finishing,
        activeInputPages: new Set(["chapter-1/page-2"]),
      }).selectedPageEditLocked,
    ).toBe(false);
    expect(
      resolvePageActivityLocks({ ...base, activities, selectedPage: pages[0] })
        .selectedPageEditLocked,
    ).toBe(true);
    expect(resolvePageActivityLocks(base).selectedPageEditLocked).toBe(true);
    expect(
      resolvePageActivityLocks({
        ...base,
        currentChapter: null,
        selectedPage: null,
        activities: { version: 2, activities: [], pages: [] },
      }).modelResourceBusy,
    ).toBe(false);
  });
  it("keeps legacy target locks until ownership ends, regardless of completion metadata", () => {
    const completed = makePage("page-1", "completed");
    const running = makePage("page-2", "running");
    const chapter = makeChapter([completed, running]);
    const job = makeJob("gemma-analysis", chapter.pages);

    expect([...resolveLockedJobTargetPageIds(job, chapter)]).toEqual([
      "page-1",
      "page-2",
    ]);
  });

  it("keeps a translated page locked until its required downstream stage completes", () => {
    const page = {
      ...makePage("page-1", "completed"),
      translationCompletion: {
        workflow: "erase-original" as const,
        status: "pending" as const,
      },
    };
    const chapter = makeChapter([page]);

    expect([
      ...resolveLockedJobTargetPageIds(
        makeJob("gemma-analysis", chapter.pages),
        chapter,
      ),
    ]).toEqual(["page-1"]);
  });

  it("keeps inpainting targets locked even when translation is already complete", () => {
    const page = makePage("page-1", "completed");
    const chapter = makeChapter([page]);

    expect([
      ...resolveLockedJobTargetPageIds(
        makeJob("inpainting", chapter.pages),
        chapter,
      ),
    ]).toEqual(["page-1"]);
  });

  it("keeps ownership across a revision change while unrelated pages remain editable", () => {
    const original = makePage("page-1", "running");
    const job = makeJob("gemma-analysis", [original]);
    const revised = {
      ...original,
      width: original.width + 1,
    };
    const unrelated = makePage("page-2", "idle");
    const chapter = makeChapter([revised, unrelated]);
    const locked = resolveLockedJobTargetPageIds(job, chapter);

    expect([...locked]).toEqual(["page-1"]);
    expect(
      resolveSelectedPageEditLocked(
        true,
        locked,
        unrelated,
        "gemma-analysis",
        job.targets?.length ?? 0,
      ),
    ).toBe(false);
  });
});

function makeJob(kind: JobState["kind"], pages: MangaPage[]): JobState {
  return {
    id: "job-1",
    kind,
    status: "running",
    progressText: "running",
    targets: pages.map((page) =>
      createPageJobTargetSnapshot("chapter-1", page),
    ),
  };
}

function makeChapter(pages: MangaPage[]): ChapterSnapshot {
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "1화",
    sourceKind: "images",
    status: "running",
    pageOrder: pages.map((page) => page.id),
    pages,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makePage(
  id: string,
  analysisStatus: MangaPage["analysisStatus"],
): MangaPage {
  return {
    id,
    name: `${id}.png`,
    imagePath: `${id}.png`,
    dataUrl: "",
    width: 1200,
    height: 1800,
    blocks: [],
    analysisStatus,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
