import { describe, expect, it } from "vitest";
import { resolveLockedJobTargetPageIds } from "../src/renderer/src/app/session/jobTargetLocks";
import { resolveSelectedPageEditLocked } from "../src/renderer/src/app/session/jobTargetLocks";
import type { JobState } from "../src/shared/jobTypes";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import { createPageJobTargetSnapshot } from "../src/shared/pageRevision";

describe("page-scoped job locking", () => {
  it("unlocks finished translation targets while later target pages keep running", () => {
    const completed = makePage("page-1", "completed");
    const running = makePage("page-2", "running");
    const chapter = makeChapter([completed, running]);
    const job = makeJob("gemma-analysis", chapter.pages);

    expect([...resolveLockedJobTargetPageIds(job, chapter)]).toEqual([
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

  it("does not lock an unrelated or revised page from a stale target snapshot", () => {
    const original = makePage("page-1", "running");
    const job = makeJob("gemma-analysis", [original]);
    const revised = {
      ...original,
      width: original.width + 1,
    };
    const unrelated = makePage("page-2", "idle");
    const chapter = makeChapter([revised, unrelated]);
    const locked = resolveLockedJobTargetPageIds(job, chapter);

    expect([...locked]).toEqual([]);
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
