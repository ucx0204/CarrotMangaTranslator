import { describe, expect, it, vi } from "vitest";
import { runInpaintingSelectionsSequentially } from "../src/renderer/src/hooks/inpaintingSelectionFlow";
import type {
  AutoInpaintingChapterSelection,
  StartInpaintingRequest,
  StartInpaintingResult,
} from "../src/shared/inpaintingTypes";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";

const selections: AutoInpaintingChapterSelection[] = [
  { chapterId: "chapter-1", mode: "all" },
  { chapterId: "chapter-2", mode: "all" },
  { chapterId: "chapter-3", mode: "all" },
];
type StartInpainting = (
  request: StartInpaintingRequest,
) => Promise<StartInpaintingResult>;

describe("sequential chapter inpainting flow", () => {
  it("runs one IPC per chapter and stops immediately after a failure", async () => {
    const results: StartInpaintingResult[] = [
      completedResult("chapter-1", "tx-1"),
      {
        status: "failed",
        error: "chapter 2 failed",
        chapters: [makeChapter("chapter-2")],
      },
      completedResult("chapter-3", "tx-3"),
    ];
    const startInpainting = vi.fn<StartInpainting>(async () => {
      const result = results.shift();
      if (!result) throw new Error("unexpected request");
      return result;
    });
    const onResult = vi.fn();

    const outcome = await runInpaintingSelectionsSequentially({
      workId: "work-1",
      selections,
      postprocess: {
        bubbleLayout: { enabled: true, policy: "balanced" },
      },
      startInpainting,
      onResult,
    });

    expect(outcome).toMatchObject({
      status: "failed",
      pagesChanged: 1,
      blocksErased: 1,
      error: "chapter 2 failed",
    });
    expect(startInpainting).toHaveBeenCalledTimes(2);
    expect(
      startInpainting.mock.calls.map(([request]) =>
        request.mode === "selection-pattern" ? request.selections : null,
      ),
    ).toEqual(selections.slice(0, 2).map((selection) => [selection]));
    expect(onResult).toHaveBeenCalledTimes(2);
  });

  it("rejects completed responses with no changed chapter data", async () => {
    const outcome = await runInpaintingSelectionsSequentially({
      workId: "work-1",
      selections: [{ chapterId: "chapter-1", mode: "all" }],
      startInpainting: vi.fn<StartInpainting>(async () => ({
        status: "completed",
        chapters: [],
        pagesChanged: 0,
        blocksErased: 0,
      })),
    });

    expect(outcome.status).toBe("failed");
  });

  it("keeps partial chapter results and continues with later chapters", async () => {
    const startInpainting = vi
      .fn<StartInpainting>()
      .mockResolvedValueOnce({
        status: "partial",
        chapters: [makeChapter("chapter-1")],
        pagesChanged: 1,
        blocksErased: 6,
        pagesIncomplete: 1,
        blocksIncomplete: 1,
      })
      .mockResolvedValueOnce(completedResult("chapter-2", "tx-2"));

    const outcome = await runInpaintingSelectionsSequentially({
      workId: "work-1",
      selections: selections.slice(0, 2),
      startInpainting,
    });

    expect(startInpainting).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({
      status: "partial",
      pagesChanged: 2,
      blocksErased: 7,
      pagesIncomplete: 1,
      blocksIncomplete: 1,
    });
  });

  it("accepts a persisted receipt-only completion for a no-text page", async () => {
    const chapter = makeChapter("chapter-1");
    chapter.pageOrder = ["page-1"];
    chapter.pages = [
      {
        id: "page-1",
        name: "001.png",
        imagePath: "C:/001.png",
        dataUrl: "",
        width: 100,
        height: 100,
        blocks: [],
        analysisStatus: "completed",
        translationCompletion: {
          workflow: "bubble-layout",
          status: "completed",
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const outcome = await runInpaintingSelectionsSequentially({
      workId: "work-1",
      selections: [{ chapterId: "chapter-1", mode: "all" }],
      postprocess: {
        bubbleLayout: { enabled: true, policy: "balanced" },
      },
      startInpainting: vi.fn<StartInpainting>(async () => ({
        status: "completed",
        chapters: [chapter],
        pagesChanged: 0,
        blocksErased: 0,
      })),
    });

    expect(outcome.status).toBe("completed");
  });

  it("stops remaining chapters on cancellation", async () => {
    const startInpainting = vi
      .fn<StartInpainting>()
      .mockResolvedValueOnce(completedResult("chapter-1", "tx-1"))
      .mockResolvedValueOnce({ status: "cancelled" });

    const outcome = await runInpaintingSelectionsSequentially({
      workId: "work-1",
      selections,
      startInpainting,
    });

    expect(outcome.status).toBe("cancelled");
    expect(startInpainting).toHaveBeenCalledTimes(2);
  });

  it("honors a flow cancellation requested between chapter jobs", async () => {
    let cancellationRequested = false;
    const startInpainting = vi
      .fn<StartInpainting>()
      .mockResolvedValue(completedResult("chapter-1", "tx-1"));

    const outcome = await runInpaintingSelectionsSequentially({
      workId: "work-1",
      selections,
      startInpainting,
      shouldCancel: () => cancellationRequested,
      onResult: () => {
        cancellationRequested = true;
      },
    });

    expect(outcome.status).toBe("cancelled");
    expect(outcome.pagesChanged).toBe(1);
    expect(startInpainting).toHaveBeenCalledOnce();
  });
});

function completedResult(
  chapterId: string,
  transactionId: string,
): StartInpaintingResult {
  return {
    status: "completed",
    chapters: [makeChapter(chapterId)],
    pagesChanged: 1,
    blocksErased: 1,
    historyTransaction: { transactionId },
  };
}

function makeChapter(id: string): ChapterSnapshot {
  return {
    id,
    workId: "work-1",
    title: id,
    sourceKind: "images",
    status: "completed",
    pageOrder: [],
    pages: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
