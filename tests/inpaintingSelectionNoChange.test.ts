import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInpaintingRuntimeHarness,
  requireChapter,
  makePage,
  makeChapter,
  makeContext,
  type InpaintingRuntimeHarness,
} from "./inpaintingSelectionJobFixtures";
import type { InpaintingRevisionChange } from "../src/main/inpainting/inpaintingRevisionStore";
import type { JobEvent } from "../src/shared/jobTypes";

const chapterAId = "11111111-1111-4111-8111-111111111111";
const pageA1Id = "33333333-3333-4333-8333-333333333333";
const pageA2Id = "44444444-4444-4444-8444-444444444444";

describe("batch inpainting without changed pixels", () => {
  const chapters = new Map<string, ReturnType<typeof makeChapter>>();
  const revisionChanges: InpaintingRevisionChange[] = [];
  const send = vi.fn<(channel: string, event: JobEvent) => void>();
  let harness: InpaintingRuntimeHarness;
  beforeEach(() => {
    send.mockClear();
    revisionChanges.length = 0;
    chapters.clear();
    const pages = [
      makePage(pageA1Id, "a-1.png"),
      makePage(pageA2Id, "a-2.png"),
    ];
    chapters.set(chapterAId, makeChapter(chapterAId, "work-a", pages));
    harness = createInpaintingRuntimeHarness(chapters);
  });
  it.each([false, true])(
    "continues after an unchanged page and counts it again without a new receipt (bubble layout=%s)",
    async (bubbleLayout) => {
      const chapter = requireChapter(chapters, chapterAId);
      const first = chapter.pages[0];
      const second = chapter.pages[1];
      const block = first?.blocks[0];
      if (!first || !second || !block) throw Error("expected page fixtures");
      const alreadyErased = { ...block, id: "already-erased" };
      first.blocks.push(alreadyErased, {
        ...block,
        id: "excluded",
        inpaintExcluded: true,
      });
      first.inpaintedImagePath = `${first.imagePath}.previous.png`;
      const workflow = bubbleLayout ? "bubble-layout" : "erase-original";
      first.translationCompletion = {
        workflow,
        status: "pending",
        erasedBlockIds: [alreadyErased.id],
      };
      second.translationCompletion = { workflow, status: "pending" };
      const before = structuredClone(first);
      harness.inpaintPatternPage.mockImplementationOnce(async (page) => ({
        page,
        blocksErased: 0,
      }));
      if (bubbleLayout)
        harness.runtime.createBubbleLayoutRunner = () => ({
          runPage: async () => ({ patches: [] }),
        });
      const { startInpaintingJob } =
        await import("../src/main/jobs/inpaintingJobs");
      const request = {
        mode: "selection-pattern" as const,
        workId: "work-a",
        selections: [{ chapterId: chapterAId, mode: "all" as const }],
        postprocess: {
          bubbleLayout: { enabled: bubbleLayout, policy: "balanced" as const },
        },
      };
      const result = await startInpaintingJob(
        makeContext(send, revisionChanges),
        request,
        harness.runtime,
      );
      expect(result).toMatchObject({
        status: "partial",
        pagesChanged: 1,
        pagesIncomplete: 1,
        blocksErased: 1,
        blocksIncomplete: 1,
      });
      expect(
        harness.inpaintPatternPage.mock.calls.map(([page]) => page.id),
      ).toEqual([first.id, second.id]);
      expect(result.chapters?.[0]?.pages[0]).toEqual(before);
      expect(
        result.chapters?.[0]?.pages[1]?.translationCompletion?.status,
      ).toBe("completed");
      expect(revisionChanges).toHaveLength(1);
      expect(
        send.mock.calls.some(
          ([, event]) =>
            event.pageIndex === 1 &&
            event.phase === "inpainting_done" &&
            event.progressText.includes("부분"),
        ),
      ).toBe(true);

      harness.inpaintPatternPage.mockClear();
      vi.mocked(harness.runtime.savePages).mockClear();
      harness.inpaintPatternPage.mockImplementationOnce(async (page) => ({
        page,
        blocksErased: 0,
      }));
      const again = await startInpaintingJob(
        makeContext(send),
        request,
        harness.runtime,
      );
      expect(again).toMatchObject({
        status: "partial",
        pagesChanged: 0,
        pagesIncomplete: 1,
        blocksErased: 0,
        blocksIncomplete: 1,
      });
      expect(harness.inpaintPatternPage).toHaveBeenCalledOnce();
      expect(harness.runtime.savePages).not.toHaveBeenCalled();
    },
  );

  it("stops and rolls back history when the pending receipt was not saved", async () => {
    harness.inpaintPatternPage.mockImplementationOnce(async (page) => ({
      page,
      blocksErased: 0,
    }));
    vi.mocked(harness.runtime.savePages).mockImplementationOnce(
      async (chapterId) => requireChapter(chapters, chapterId),
    );
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");
    const result = await startInpaintingJob(
      makeContext(send, revisionChanges),
      {
        mode: "selection-pattern",
        workId: "work-a",
        selections: [{ chapterId: chapterAId, mode: "all" }],
      },
      harness.runtime,
    );
    expect(result).toMatchObject({
      status: "failed",
      error: "번역 완료 상태가 저장되지 않았습니다.",
      pagesChanged: 0,
      blocksErased: 0,
    });
    expect(harness.inpaintPatternPage).toHaveBeenCalledOnce();
    expect(harness.runtime.savePages).toHaveBeenCalledOnce();
    expect(revisionChanges).toHaveLength(0);
    expect(
      requireChapter(chapters, chapterAId).pages[0]?.translationCompletion,
    ).toBeUndefined();
  });

  it("honors cancellation even when the runtime finishes with an unchanged page", async () => {
    const context = makeContext(send, revisionChanges);
    harness.inpaintPatternPage.mockImplementationOnce(async (page) => {
      context.jobs.current?.abortController.abort();
      return { page, blocksErased: 0 };
    });
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");
    const result = await startInpaintingJob(
      context,
      {
        mode: "selection-pattern",
        workId: "work-a",
        selections: [{ chapterId: chapterAId, mode: "all" }],
      },
      harness.runtime,
    );
    expect(result).toMatchObject({
      status: "cancelled",
      pagesChanged: 0,
      blocksErased: 0,
    });
    expect(harness.inpaintPatternPage).toHaveBeenCalledOnce();
    expect(harness.runtime.savePages).not.toHaveBeenCalled();
    expect(revisionChanges).toHaveLength(0);
  });
});
