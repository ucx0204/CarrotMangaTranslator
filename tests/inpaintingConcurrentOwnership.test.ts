import { describe, expect, it, vi } from "vitest";
import { startInpaintingJob } from "../src/main/jobs/inpaintingJobs";
import {
  createInpaintingRuntimeHarness,
  makeChapter,
  makeContext,
  makePage,
} from "./inpaintingSelectionJobFixtures";

function fixture() {
  const chapter = makeChapter("chapter-a", "work-a", [
    makePage("a", "001.png"),
  ]);
  const chapters = new Map([[chapter.id, chapter]]);
  const harness = createInpaintingRuntimeHarness(chapters);
  harness.runtime.emitEvent = (jobs, window, event) => {
    if (!jobs.get(event.id)) return;
    jobs.updateLastEvent(event.id, event);
    window?.webContents.send("job:event", event);
  };
  const context = makeContext(vi.fn());
  const handoff = (edit: () => void = () => undefined) =>
    context.jobs.pageHandoffs.subscribe(() => {
      const page = context.jobs.pageHandoffs.activities.find(
        (page) => page.phase === "finishing-edits",
      );
      if (page?.requestId) {
        edit();
        context.jobs.pageHandoffs.respond({ requestId: page.requestId });
      }
    });
  return { chapter, chapters, harness, context, handoff };
}

describe("inpainting resource and queued input ownership", () => {
  it("releases a job without loading a model when its requested page no longer exists", async () => {
    const f = fixture();
    f.context.executionSettings = await f.harness.runtime.getSettings();
    const result = await startInpaintingJob(
      f.context,
      { mode: "page-pattern", chapterId: f.chapter.id, pageId: "missing" },
      f.harness.runtime,
    );
    expect(result).toMatchObject({ status: "failed", pagesChanged: 0 });
    expect(f.harness.acquireEngine).not.toHaveBeenCalled();
    expect(f.context.jobs.all).toEqual([]);
  });

  it("runs remote mask erasure beside a local job and never disposes its runtime", async () => {
    const f = fixture();
    f.context.executionSettings = await f.harness.runtime.getSettings();
    const local = {
      id: "local",
      kind: "gemma-analysis" as const,
      abortController: new AbortController(),
      resources: [
        {
          kind: "model-runtime" as const,
          scope: "*",
          access: "write" as const,
        },
      ],
    };
    f.context.jobs.start(local);
    const dispose = vi.fn(async () => true);
    f.harness.runtime.disposeBubbleLayoutSessions = dispose;
    f.harness.runtime.acquireCodexEngine = vi.fn(async () => ({
      ...(await f.harness.acquireEngine({
        appPaths: f.context.appPaths,
        model: "flux-klein",
      })),
      release: f.harness.releaseEngine,
    }));
    f.harness.runtime.inpaintDrawnPage = vi.fn(async (page) => ({
      page: { ...page, inpaintedImagePath: "remote.png" },
      blocksErased: 1,
    }));
    const unsubscribe = f.handoff();
    const result = await startInpaintingJob(
      f.context,
      {
        mode: "page-pattern-drawn",
        chapterId: f.chapter.id,
        pageId: "a",
        engine: "codex",
        strokes: [{ radiusPx: 3, points: [{ x: 10, y: 10 }] }],
        postprocess: { bubbleLayout: { enabled: false, policy: "balanced" } },
      },
      f.harness.runtime,
    );
    unsubscribe();
    expect(result.status).toBe("completed");
    expect(f.context.jobs.get("local")).toBe(local);
    expect(local.abortController.signal.aborted).toBe(false);
    expect(dispose).not.toHaveBeenCalled();
    expect(f.harness.releaseEngine).toHaveBeenCalledOnce();
    f.context.jobs.clearIfCurrent("local");
  });

  it("acquires an engine and uses blocks added while the page was queued", async () => {
    const f = fixture();
    f.context.executionSettings = await f.harness.runtime.getSettings();
    const originalBlocks = f.chapter.pages[0].blocks;
    f.chapter.pages[0] = { ...f.chapter.pages[0], blocks: [] };
    const unsubscribe = f.handoff(() => {
      f.chapter.pages[0] = {
        ...f.chapter.pages[0],
        blocks: originalBlocks.map((block) => ({
          ...block,
          translatedText: "queued edit",
        })),
      };
    });
    const result = await startInpaintingJob(
      f.context,
      { mode: "page-pattern", chapterId: f.chapter.id, pageId: "a" },
      f.harness.runtime,
    );
    unsubscribe();
    expect(result.status).toBe("completed");
    expect(f.harness.acquireEngine).toHaveBeenCalledOnce();
    expect(f.harness.runEngine).toHaveBeenCalledOnce();
    expect(
      f.harness.inpaintPatternPage.mock.calls[0][0].blocks[0].translatedText,
    ).toBe("queued edit");
    expect(f.context.jobs.all).toEqual([]);
  });

  it("rejects a queued page whose completion workflow changed before handoff", async () => {
    const f = fixture();
    f.context.executionSettings = await f.harness.runtime.getSettings();
    f.chapter.pages[0].translationCompletion = {
      status: "pending",
      workflow: "erase-original",
    };
    const unsubscribe = f.handoff(() => {
      f.chapter.pages[0] = {
        ...f.chapter.pages[0],
        translationCompletion: { status: "pending", workflow: "bubble-layout" },
      };
    });
    const result = await startInpaintingJob(
      f.context,
      { mode: "page-pattern", chapterId: f.chapter.id, pageId: "a" },
      f.harness.runtime,
    );
    unsubscribe();
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/방식이 변경/);
    expect(f.harness.inpaintPatternPage).not.toHaveBeenCalled();
    expect(f.harness.releaseEngine).toHaveBeenCalledOnce();
  });
});
