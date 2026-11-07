import { describe, expect, it, vi } from "vitest";
import { startInpaintingJob } from "../src/main/jobs/inpaintingJobs";
import { prepareBubbleLayoutJob } from "../src/main/jobs/bubbleLayoutJob";
import { runInpaintingSelectionsSequentially } from "../src/renderer/src/hooks/inpaintingSelectionFlow";
import type { StartInpaintingResult } from "../src/shared/inpaintingTypes";
import {
  createInpaintingRuntimeHarness,
  makeChapter,
  makeContext,
  makePage,
} from "./inpaintingSelectionJobFixtures";

async function fixture() {
  const page = makePage("page-a", "11.webp");
  const chapter = makeChapter("chapter-a", "work-a", [page]);
  const chapters = new Map([[chapter.id, chapter]]);
  const harness = createInpaintingRuntimeHarness(chapters);
  const send = vi.fn();
  const context = makeContext(send);
  context.executionSettings = await harness.runtime.getSettings();
  const selections = [{ chapterId: chapter.id, mode: "all" as const }];
  const run = async (edit: () => void = () => undefined) => {
    const unsubscribe = context.jobs.pageHandoffs.subscribe(() => {
      const pending = context.jobs.pageHandoffs.activities.find(
        (item) => item.phase === "finishing-edits",
      );
      if (pending?.requestId) {
        edit();
        context.jobs.pageHandoffs.respond({ requestId: pending.requestId });
      }
    });
    try {
      return await startInpaintingJob(
        context,
        { mode: "selection-pattern", workId: chapter.workId, selections },
        harness.runtime,
      );
    } finally {
      unsubscribe();
    }
  };
  const renderResult = (result: StartInpaintingResult, bubbleLayout = false) =>
    runInpaintingSelectionsSequentially({
      workId: chapter.workId,
      selections,
      postprocess: {
        bubbleLayout: { enabled: bubbleLayout, policy: "balanced" },
      },
      timingSession: { id: "diagnostic-session", startedAtEpochMs: Date.now() },
      startInpainting: async () => result,
    });
  return { page, chapter, harness, context, send, run, renderResult };
}

describe("targetless inpainting main/renderer contract", () => {
  it("keeps direct zero-target layout preparation free of settings and model access", async () => {
    const f = await fixture();
    vi.mocked(f.harness.runtime.getSettings).mockClear();
    const result = await prepareBubbleLayoutJob({
      context: f.context,
      request: {
        mode: "selection-pattern",
        workId: f.chapter.workId,
        selections: [{ chapterId: f.chapter.id, mode: "all" }],
      },
      runtime: f.harness.runtime,
      totalTargetBlocks: 0,
    });
    expect(result).toEqual({ appSettings: null, config: null, runner: null });
    expect(f.harness.runtime.getSettings).not.toHaveBeenCalled();
    expect(f.harness.acquireEngine).not.toHaveBeenCalled();
  });
  it.each(["empty", "excluded", "invalid"])(
    "reports a specific no-target error without preparing models: %s",
    async (mode) => {
      const f = await fixture();
      if (mode === "empty") f.page.blocks = [];
      if (mode === "excluded") f.page.blocks[0].inpaintExcluded = true;
      if (mode === "invalid") f.page.blocks[0].bbox.w = 0;
      const before = structuredClone(f.page);
      const main = await f.run();
      const renderer = await f.renderResult(main);
      expect(main).toMatchObject({
        status: "failed",
        error: "인페인팅할 텍스트 블록이 없습니다.",
        pagesChanged: 0,
        blocksErased: 0,
      });
      expect(renderer).toMatchObject({
        status: main.status,
        error: main.error,
      });
      expect(f.harness.acquireEngine).not.toHaveBeenCalled();
      expect(f.harness.runtime.getSettings).toHaveBeenCalledOnce();
      expect(f.harness.inpaintPatternPage).not.toHaveBeenCalled();
      expect(f.harness.runtime.savePages).not.toHaveBeenCalled();
      expect(f.page).toEqual(before);
      expect(
        f.send.mock.calls.some(([, event]) => event.status === "completed"),
      ).toBe(false);
      expect(f.context.jobs.all).toEqual([]);
      expect(
        f.context.jobs.pageHandoffs.activities.every(
          (item) => item.phase !== "processing",
        ),
      ).toBe(true);
    },
  );

  it.each(["erase-original", "bubble-layout"] as const)(
    "completes existing %s receipts without loading models",
    async (workflow) => {
      const f = await fixture();
      f.page.blocks = [];
      f.page.translationCompletion = { workflow, status: "pending" };
      const main = await f.run();
      expect(main.status).toBe("completed");
      expect(main.chapters?.[0].pages[0].translationCompletion).toEqual({
        workflow,
        status: "completed",
      });
      expect(
        (await f.renderResult(main, workflow === "bubble-layout")).status,
      ).toBe("completed");
      expect(f.harness.acquireEngine).not.toHaveBeenCalled();
      expect(f.harness.runtime.savePages).toHaveBeenCalledOnce();
    },
  );

  it("does not let one receipt hide another targetless page without a receipt", async () => {
    const f = await fixture();
    f.page.blocks = [];
    f.page.translationCompletion = {
      workflow: "erase-original",
      status: "pending",
    };
    const other = { ...makePage("page-b", "12.webp"), blocks: [] };
    f.chapter.pages.push(other);
    f.chapter.pageOrder.push(other.id);
    const main = await f.run();
    expect(main).toMatchObject({
      status: "failed",
      error: "인페인팅할 텍스트 블록이 없습니다.",
    });
    expect((await f.renderResult(main)).error).toBe(main.error);
    expect(main.chapters?.[0].pages[0].translationCompletion?.status).toBe(
      "completed",
    );
    expect(main.chapters?.[0].pages[1].translationCompletion).toBeUndefined();
    expect(f.harness.acquireEngine).not.toHaveBeenCalled();
  });

  it("loads the engine for blocks added to a later queued page after an empty page", async () => {
    const f = await fixture();
    f.page.blocks = [];
    const other = makePage("page-b", "12.webp");
    const blocks = other.blocks;
    other.blocks = [];
    f.chapter.pages.push(other);
    f.chapter.pageOrder.push(other.id);
    const main = await f.run(() => {
      if (
        f.context.jobs.pageHandoffs.activities.some(
          (item) =>
            item.pageId === other.id && item.phase === "finishing-edits",
        )
      )
        other.blocks = blocks;
    });
    expect(main).toMatchObject({ status: "completed", pagesChanged: 1 });
    expect((await f.renderResult(main)).status).toBe("completed");
    expect(f.harness.acquireEngine).toHaveBeenCalledOnce();
    expect(f.harness.inpaintPatternPage).toHaveBeenCalledOnce();
    expect(f.harness.inpaintPatternPage.mock.calls[0][0].id).toBe(other.id);
  });

  it.each([false, true])(
    "skips model preparation when the last target is removed during handoff (retained ownership=%s)",
    async (retainPageOwnership) => {
      const f = await fixture();
      f.context.retainPageOwnership = retainPageOwnership;
      const main = await f.run(() => {
        f.page.blocks = [];
      });
      expect(main).toMatchObject({
        status: "failed",
        error: "인페인팅할 텍스트 블록이 없습니다.",
      });
      expect(f.harness.acquireEngine).not.toHaveBeenCalled();
    },
  );

  it("preserves cancellation during a targetless page handoff", async () => {
    const f = await fixture();
    f.page.blocks = [];
    const main = await f.run(() => {
      f.context.jobs.current?.abortController.abort();
    });
    expect(main.status).toBe("cancelled");
    expect((await f.renderResult(main)).status).toBe("cancelled");
    expect(f.harness.acquireEngine).not.toHaveBeenCalled();
    expect(f.context.jobs.all).toEqual([]);
  });
});
