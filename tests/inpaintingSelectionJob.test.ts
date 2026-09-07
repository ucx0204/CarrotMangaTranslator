import {
  createInpaintingRuntimeHarness,
  requireChapter,
  makePage,
  makeChapter,
  createDeferred,
  makeContext,
  HISTORY_TRANSACTION_ID,
  type InpaintingRuntimeHarness,
} from "./inpaintingSelectionJobFixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InpaintingRevisionChange } from "../src/main/inpainting/inpaintingRevisionStore";
import type { InpaintingEngine } from "../src/main/inpainting/inpaintingEngine";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import { StartInpaintingRequestSchema } from "../src/shared/ipcJobSchemas";

const chapterAId = "11111111-1111-4111-8111-111111111111";
const chapterBId = "22222222-2222-4222-8222-222222222222";
const pageA1Id = "33333333-3333-4333-8333-333333333333";
const pageA2Id = "44444444-4444-4444-8444-444444444444";
const pageB1Id = "55555555-5555-4555-8555-555555555555";

describe("single-chapter automatic inpainting jobs", () => {
  const chapters = new Map<string, ReturnType<typeof makeChapter>>();
  const revisionChanges: InpaintingRevisionChange[] = [];
  let harness: InpaintingRuntimeHarness;
  const send =
    vi.fn<
      (
        channel: string,
        event: import("../src/shared/jobTypes").JobEvent,
      ) => void
    >();

  beforeEach(() => {
    send.mockClear();
    chapters.clear();
    revisionChanges.length = 0;
    chapters.set(
      chapterAId,
      makeChapter(chapterAId, "work-a", [
        makePage(pageA1Id, "a-1.png"),
        makePage(pageA2Id, "a-2.png"),
      ]),
    );
    chapters.set(
      chapterBId,
      makeChapter(chapterBId, "work-a", [makePage(pageB1Id, "b-1.png")]),
    );
    harness = createInpaintingRuntimeHarness(chapters);
  });

  it.each([true, false])(
    "carries a validated per-run Codex engine through the job, saves its pages and keeps normal layout=%s",
    async (bubbleLayout) => {
      const { startInpaintingJob } =
        await import("../src/main/jobs/inpaintingJobs");
      const settings = resolveDefaultAppSettings({});
      settings.modelProvider = "openai-codex";
      settings.codex = {
        ...settings.codex,
        model: "gpt-6-astra",
        delegateAll: false,
      };
      harness.runtime.getSettings = async () => settings;
      const codexInpaint = vi.fn<InpaintingEngine["inpaint"]>(
        async () => undefined,
      );
      const release = vi.fn();
      const acquireCodexEngine = vi.fn(async () => ({
        engine: {
          model: "codex" as const,
          backend: "imagegen",
          runtimePath: "codex",
          runRootDir: "fixture",
          inpaint: codexInpaint,
          dispose: async () => undefined,
        },
        release,
      }));
      harness.runtime.acquireCodexEngine = acquireCodexEngine;
      const createLayout = vi.fn(() => ({
        runPage: vi.fn(async () => ({ patches: [] })),
      }));
      harness.runtime.createBubbleLayoutRunner = createLayout;
      const workId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const request = StartInpaintingRequestSchema.parse({
        mode: "selection-pattern",
        engine: "codex",
        workId,
        selections: [{ chapterId: chapterAId, mode: "all" }],
        postprocess: {
          bubbleLayout: { enabled: bubbleLayout, policy: "balanced" },
        },
      });
      const chapter = requireChapter(chapters, chapterAId);
      chapters.set(chapterAId, makeChapter(chapterAId, workId, chapter.pages));
      const result = await startInpaintingJob(
        makeContext(send),
        request,
        harness.runtime,
      );
      expect(result.status, result.error).toBe("completed");
      expect(acquireCodexEngine).toHaveBeenCalledOnce();
      expect(harness.acquireEngine).not.toHaveBeenCalled();
      expect(codexInpaint).toHaveBeenCalledTimes(2);
      expect(release).toHaveBeenCalledOnce();
      expect(createLayout).toHaveBeenCalledTimes(bubbleLayout ? 1 : 0);
      expect(
        result.chapters?.[0].pages.every((page) => page.inpaintedImagePath),
      ).toBe(true);
      expect(settings.codex.delegateAll).toBe(false);
    },
  );

  it("routes brush masks through Codex with delegation off and preserves the mask contract", async () => {
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");
    const settings = resolveDefaultAppSettings({});
    settings.modelProvider = "openai-codex";
    settings.codex.model = "gpt-6-astra";
    settings.codex.delegateAll = false;
    harness.runtime.getSettings = async () => settings;
    const engine: InpaintingEngine = {
      model: "codex",
      backend: "imagegen",
      runtimePath: "test",
      runRootDir: "test",
      inpaint: async () => {},
      dispose: async () => {},
    };
    const release = vi.fn();
    harness.runtime.acquireCodexEngine = vi.fn(async () => ({
      engine,
      release,
    }));
    const strokes = [
      {
        points: [
          { x: 30, y: 30 },
          { x: 50, y: 50 },
        ],
        radiusPx: 12,
      },
    ];
    const drawn = vi.fn<typeof harness.runtime.inpaintDrawnPage>(
      async (page, options) => {
        expect(options.inpaintingEngine).toBe(engine);
        expect(options.strokes).toEqual(strokes);
        expect(options.featherPx).toBe(8);
        return {
          page: { ...page, inpaintedImagePath: "drawn-codex.png" },
          blocksErased: 1,
        };
      },
    );
    harness.runtime.inpaintDrawnPage = drawn;
    const request = StartInpaintingRequestSchema.parse({
      mode: "page-pattern-drawn",
      engine: "codex",
      chapterId: chapterAId,
      pageId: pageA1Id,
      strokes,
      featherPx: 8,
    });
    const result = await startInpaintingJob(
      makeContext(send),
      request,
      harness.runtime,
    );
    expect(result.status, result.error).toBe("completed");
    expect(drawn).toHaveBeenCalledOnce();
    expect(harness.acquireEngine).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(result.chapter?.pages[0].inpaintedImagePath).toBe("drawn-codex.png");
  });

  it("processes one chapter with one engine lease and aggregate progress", async () => {
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");
    const result = await startInpaintingJob(
      makeContext(send),
      {
        mode: "selection-pattern",
        workId: "work-a",
        timingSession: {
          id: "66666666-6666-4666-8666-666666666666",
          startedAtEpochMs: 1_000,
        },
        selections: [
          {
            chapterId: chapterAId,
            mode: "page-set",
            pageIds: [pageA2Id, pageA1Id],
          },
        ],
      },
      harness.runtime,
    );

    expect(result.status).toBe("completed");
    expect(result.chapter).toBeUndefined();
    expect(result.chapters?.map((chapter) => chapter.id)).toEqual([chapterAId]);
    expect(result.pagesChanged).toBe(2);
    expect(harness.acquireEngine).toHaveBeenCalledTimes(1);
    expect(harness.openPageTimingSession).toHaveBeenCalledWith(
      expect.objectContaining({
        chapterId: chapterAId,
        kind: "inpainting",
        session: expect.objectContaining({
          id: "66666666-6666-4666-8666-666666666666",
        }),
      }),
    );
    expect(harness.acquireEngine).toHaveBeenCalledWith(
      expect.objectContaining({ computeGpuIndex: 2 }),
    );
    expect(harness.runEngine).toHaveBeenCalledTimes(2);
    expect(harness.releaseEngine).toHaveBeenCalledTimes(1);
    expect(
      harness.inpaintPatternPage.mock.calls.map(([page]) => page.name),
    ).toEqual(["a-1.png", "a-2.png"]);

    const jobEvents = send.mock.calls.map((call) => call[1]);
    expect(jobEvents.at(-1)).toMatchObject({
      status: "completed",
      progressCurrent: 2,
      progressTotal: 2,
      pageTotal: 2,
    });
    expect(
      jobEvents
        .filter((event) => event.status === "running")
        .every((event) => event.progressTotal === 2 && event.pageTotal === 2),
    ).toBe(true);
  });

  it("rejects multiple chapters before opening either chapter", async () => {
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");
    const result = await startInpaintingJob(
      makeContext(send),
      {
        mode: "selection-pattern",
        workId: "work-a",
        selections: [
          { chapterId: chapterAId, mode: "all" },
          { chapterId: chapterBId, mode: "all" },
        ],
      },
      harness.runtime,
    );

    expect(result).toMatchObject({
      status: "failed",
      error: "Exactly one chapter selection is required.",
      pagesChanged: 0,
      blocksErased: 0,
    });
    expect(harness.runtime.openChapter).not.toHaveBeenCalled();
    expect(harness.acquireEngine).not.toHaveBeenCalled();
    expect(harness.runtime.savePages).not.toHaveBeenCalled();
  });

  it("fails instead of completing when an expected erase produces no result", async () => {
    const firstPage = requireChapter(chapters, chapterAId).pages[0];
    if (!firstPage) {
      throw new Error("expected first page");
    }
    harness.inpaintPatternPage.mockResolvedValueOnce({
      page: firstPage,
      blocksErased: 0,
    });
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");

    const result = await startInpaintingJob(
      makeContext(send),
      {
        mode: "selection-pattern",
        workId: "work-a",
        selections: [
          {
            chapterId: chapterAId,
            mode: "page-set",
            pageIds: [pageA1Id],
          },
        ],
      },
      harness.runtime,
    );

    expect(result).toMatchObject({
      status: "failed",
      error: "인페인팅 결과가 생성되지 않았습니다.",
    });
    expect(harness.runtime.savePages).not.toHaveBeenCalled();
    expect(send.mock.calls.at(-1)?.[1]).toMatchObject({
      status: "failed",
    });
  });

  it("commits a partial page, keeps its receipt pending, and continues later pages", async () => {
    const chapter = requireChapter(chapters, chapterAId);
    const firstPage = chapter.pages[0];
    const secondPage = chapter.pages[1];
    const firstBlock = firstPage?.blocks[0];
    if (!firstPage || !secondPage || !firstBlock) {
      throw new Error("expected two pages and a source block");
    }
    const incompleteBlock = {
      ...firstBlock,
      id: `${firstPage.id}-incomplete-block`,
    };
    firstPage.blocks.push(incompleteBlock);
    firstPage.translationCompletion = {
      workflow: "erase-original",
      status: "pending",
    };
    secondPage.translationCompletion = {
      workflow: "erase-original",
      status: "pending",
    };
    harness.inpaintPatternPage.mockResolvedValueOnce({
      page: {
        ...firstPage,
        inpaintedImagePath: `${firstPage.imagePath}.partial.png`,
      },
      blocksErased: 1,
      blocksIncomplete: 0,
      erasedBlockIds: [firstBlock.id],
      incompleteBlockIds: [incompleteBlock.id],
    });
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");

    const result = await startInpaintingJob(
      makeContext(send, revisionChanges),
      {
        mode: "selection-pattern",
        workId: "work-a",
        selections: [{ chapterId: chapterAId, mode: "all" }],
        postprocess: {
          bubbleLayout: { enabled: false, policy: "balanced" },
        },
      },
      harness.runtime,
    );

    expect(result).toMatchObject({
      status: "partial",
      pagesChanged: 2,
      pagesIncomplete: 1,
      blocksErased: 2,
      blocksIncomplete: 1,
    });
    expect(harness.inpaintPatternPage).toHaveBeenCalledTimes(2);
    expect(
      harness.inpaintPatternPage.mock.calls.map(([page]) => page.id),
    ).toEqual([pageA1Id, pageA2Id]);
    expect(result.chapters?.[0]?.pages[0]?.translationCompletion).toEqual({
      workflow: "erase-original",
      status: "pending",
      erasedBlockIds: [firstBlock.id],
    });
    expect(result.chapters?.[0]?.pages[1]?.translationCompletion?.status).toBe(
      "completed",
    );
    expect(revisionChanges).toHaveLength(2);
    expect(revisionChanges[0]).toMatchObject({
      pageId: pageA1Id,
      afterPath: `${firstPage.imagePath}.partial.png`,
      afterTranslationCompletion: {
        workflow: "erase-original",
        status: "pending",
        erasedBlockIds: [firstBlock.id],
      },
    });
    expect(send.mock.calls.at(-1)?.[1]).toMatchObject({
      status: "partial",
      phase: "partial",
    });
  });

  it("includes a saved partial page in pending mode and retries only unfinished blocks", async () => {
    const chapter = requireChapter(chapters, chapterAId);
    const partialPage = chapter.pages[0];
    const completedPage = chapter.pages[1];
    const alreadyErasedBlock = partialPage?.blocks[0];
    if (!partialPage || !completedPage || !alreadyErasedBlock) {
      throw new Error("expected two pages and a source block");
    }
    const remainingBlock = {
      ...alreadyErasedBlock,
      id: `${partialPage.id}-remaining-block`,
    };
    partialPage.blocks.push(remainingBlock);
    partialPage.inpaintedImagePath = `${partialPage.imagePath}.partial.png`;
    partialPage.translationCompletion = {
      workflow: "erase-original",
      status: "pending",
      erasedBlockIds: [alreadyErasedBlock.id],
    };
    completedPage.inpaintedImagePath = `${completedPage.imagePath}.done.png`;
    completedPage.translationCompletion = {
      workflow: "erase-original",
      status: "completed",
    };
    harness.inpaintPatternPage.mockImplementationOnce(async (page, options) => {
      expect(options?.excludedBlockIds).toEqual([alreadyErasedBlock.id]);
      return {
        page: {
          ...page,
          inpaintedImagePath: `${page.imagePath}.done.png`,
        },
        blocksErased: 1,
        blocksIncomplete: 0,
        erasedBlockIds: [remainingBlock.id],
        incompleteBlockIds: [],
      };
    });
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");

    const result = await startInpaintingJob(
      makeContext(send, revisionChanges),
      {
        mode: "chapter-pattern-pending",
        chapterId: chapterAId,
        postprocess: {
          bubbleLayout: { enabled: false, policy: "balanced" },
        },
      },
      harness.runtime,
    );

    expect(result).toMatchObject({
      status: "completed",
      pagesChanged: 1,
      pagesIncomplete: 0,
      blocksErased: 1,
      blocksIncomplete: 0,
    });
    expect(harness.inpaintPatternPage).toHaveBeenCalledTimes(1);
    expect(result.chapter?.pages[0]?.translationCompletion).toEqual({
      workflow: "erase-original",
      status: "completed",
      erasedBlockIds: [alreadyErasedBlock.id, remainingBlock.id],
    });
    expect(result.chapter?.pages[1]?.inpaintedImagePath).toBe(
      completedPage.inpaintedImagePath,
    );
  });

  it("retries a failed completion even when an older inpainted artifact exists", async () => {
    const chapter = requireChapter(chapters, chapterAId);
    const failedPage = chapter.pages[0];
    const completedPage = chapter.pages[1];
    const failedBlock = failedPage?.blocks[0];
    if (!failedPage || !completedPage || !failedBlock) {
      throw new Error("expected two pages and a source block");
    }
    failedPage.inpaintedImagePath = `${failedPage.imagePath}.stale.png`;
    failedPage.translationCompletion = {
      workflow: "erase-original",
      status: "failed",
    };
    completedPage.inpaintedImagePath = `${completedPage.imagePath}.done.png`;
    completedPage.translationCompletion = {
      workflow: "erase-original",
      status: "completed",
    };
    harness.inpaintPatternPage.mockImplementationOnce(async (page) => ({
      page: {
        ...page,
        inpaintedImagePath: `${page.imagePath}.retried.png`,
      },
      blocksErased: 1,
      blocksIncomplete: 0,
      erasedBlockIds: [failedBlock.id],
      incompleteBlockIds: [],
    }));
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");

    const result = await startInpaintingJob(
      makeContext(send, revisionChanges),
      {
        mode: "chapter-pattern-pending",
        chapterId: chapterAId,
        postprocess: {
          bubbleLayout: { enabled: false, policy: "balanced" },
        },
      },
      harness.runtime,
    );

    expect(result).toMatchObject({
      status: "completed",
      pagesChanged: 1,
      blocksErased: 1,
    });
    expect(harness.inpaintPatternPage).toHaveBeenCalledTimes(1);
    expect(result.chapter?.pages[0]).toMatchObject({
      inpaintedImagePath: `${failedPage.imagePath}.retried.png`,
      translationCompletion: {
        workflow: "erase-original",
        status: "completed",
        erasedBlockIds: [failedBlock.id],
      },
    });
    expect(result.chapter?.pages[1]?.inpaintedImagePath).toBe(
      completedPage.inpaintedImagePath,
    );
  });

  it("fails before engine acquisition when every selected block is ineligible", async () => {
    const chapter = requireChapter(chapters, chapterAId);
    const firstBlock = chapter.pages[0]?.blocks[0];
    const secondBlock = chapter.pages[1]?.blocks[0];
    if (!firstBlock || !secondBlock) throw new Error("expected blocks");
    firstBlock.inpaintExcluded = true;
    secondBlock.bbox.w = 0;
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");

    const result = await startInpaintingJob(
      makeContext(send),
      {
        mode: "selection-pattern",
        workId: "work-a",
        selections: [{ chapterId: chapterAId, mode: "all" }],
      },
      harness.runtime,
    );

    expect(result).toMatchObject({
      status: "failed",
      pagesChanged: 0,
      blocksErased: 0,
    });
    expect(harness.acquireEngine).not.toHaveBeenCalled();
    expect(harness.inpaintPatternPage).not.toHaveBeenCalled();
    expect(harness.runtime.savePages).not.toHaveBeenCalled();
  });

  it("completes a no-text receipt without counting an image change in a mixed chapter", async () => {
    const chapter = requireChapter(chapters, chapterAId);
    const firstPage = chapter.pages[0];
    const secondPage = chapter.pages[1];
    if (!firstPage || !secondPage) throw new Error("expected pages");
    firstPage.blocks = [];
    firstPage.translationCompletion = {
      workflow: "erase-original",
      status: "pending",
    };
    secondPage.translationCompletion = {
      workflow: "erase-original",
      status: "pending",
    };
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
      status: "completed",
      pagesChanged: 1,
      blocksErased: 1,
    });
    expect(harness.inpaintPatternPage).toHaveBeenCalledTimes(1);
    expect(harness.inpaintPatternPage).toHaveBeenCalledWith(
      expect.objectContaining({ id: pageA2Id }),
      expect.anything(),
    );
    expect(
      result.chapters?.[0]?.pages.map((page) => page.translationCompletion),
    ).toEqual([
      { workflow: "erase-original", status: "completed" },
      { workflow: "erase-original", status: "completed" },
    ]);
    expect(revisionChanges).toHaveLength(2);
    expect(
      revisionChanges.map((change) => ({
        after: change.afterTranslationCompletion,
        before: change.beforeTranslationCompletion,
      })),
    ).toEqual([
      {
        before: { workflow: "erase-original", status: "pending" },
        after: { workflow: "erase-original", status: "completed" },
      },
      {
        before: { workflow: "erase-original", status: "pending" },
        after: { workflow: "erase-original", status: "completed" },
      },
    ]);
  });

  it("completes all no-text receipts without acquiring an engine", async () => {
    const chapter = requireChapter(chapters, chapterAId);
    for (const page of chapter.pages) {
      page.blocks = [];
      page.translationCompletion = {
        workflow: "erase-original",
        status: "pending",
      };
    }
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
      status: "completed",
      pagesChanged: 0,
      blocksErased: 0,
      historyTransaction: { transactionId: HISTORY_TRANSACTION_ID },
    });
    expect(harness.acquireEngine).not.toHaveBeenCalled();
    expect(harness.inpaintPatternPage).not.toHaveBeenCalled();
    expect(harness.runtime.savePages).toHaveBeenCalledTimes(2);
    expect(
      result.chapters?.[0]?.pages.every(
        (page) => page.translationCompletion?.status === "completed",
      ),
    ).toBe(true);
    expect(revisionChanges).toHaveLength(2);
    expect(revisionChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          beforeTranslationCompletion: {
            workflow: "erase-original",
            status: "pending",
          },
          afterTranslationCompletion: {
            workflow: "erase-original",
            status: "completed",
          },
        }),
      ]),
    );
  });

  it("completes all no-text Bubble receipts without starting postprocess", async () => {
    const chapter = requireChapter(chapters, chapterAId);
    for (const page of chapter.pages) {
      page.blocks = [];
      page.translationCompletion = {
        workflow: "bubble-layout",
        status: "pending",
      };
    }
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");

    const result = await startInpaintingJob(
      makeContext(send, revisionChanges),
      {
        mode: "selection-pattern",
        workId: "work-a",
        selections: [{ chapterId: chapterAId, mode: "all" }],
        postprocess: {
          bubbleLayout: { enabled: true, policy: "balanced" },
        },
      },
      harness.runtime,
    );

    expect(result).toMatchObject({
      status: "completed",
      pagesChanged: 0,
      blocksErased: 0,
      historyTransaction: { transactionId: HISTORY_TRANSACTION_ID },
    });
    expect(harness.acquireEngine).not.toHaveBeenCalled();
    expect(harness.inpaintPatternPage).not.toHaveBeenCalled();
    expect(harness.runtime.savePages).toHaveBeenCalledTimes(2);
    expect(
      result.chapters?.[0]?.pages.every(
        (page) =>
          page.translationCompletion?.workflow === "bubble-layout" &&
          page.translationCompletion.status === "completed",
      ),
    ).toBe(true);
    expect(revisionChanges).toHaveLength(2);
    expect(revisionChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          beforeTranslationCompletion: {
            workflow: "bubble-layout",
            status: "pending",
          },
          afterTranslationCompletion: {
            workflow: "bubble-layout",
            status: "completed",
          },
        }),
      ]),
    );
  });

  it("does not treat a non-excluded block with an invalid box as no-text", async () => {
    const chapter = requireChapter(chapters, chapterAId);
    const page = chapter.pages[0];
    const block = page?.blocks[0];
    if (!page || !block) throw new Error("expected page block");
    block.bbox = { ...block.bbox, w: 0 };
    page.translationCompletion = {
      workflow: "erase-original",
      status: "pending",
    };
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");

    const result = await startInpaintingJob(
      makeContext(send, revisionChanges),
      {
        mode: "selection-pattern",
        workId: "work-a",
        selections: [
          {
            chapterId: chapterAId,
            mode: "page-set",
            pageIds: [pageA1Id],
          },
        ],
        postprocess: {
          bubbleLayout: { enabled: false, policy: "balanced" },
        },
      },
      harness.runtime,
    );

    expect(result.status).toBe("failed");
    expect(result.chapters?.[0]?.pages[0]?.translationCompletion).toEqual({
      workflow: "erase-original",
      status: "failed",
    });
    expect(harness.inpaintPatternPage).not.toHaveBeenCalled();
  });

  it("fails the whole page when a valid block is mixed with an invalid required block", async () => {
    const chapter = requireChapter(chapters, chapterAId);
    const page = chapter.pages[0];
    const validBlock = page?.blocks[0];
    if (!page || !validBlock) throw new Error("expected page block");
    page.blocks.push({
      ...validBlock,
      id: `${validBlock.id}-invalid`,
      bbox: { ...validBlock.bbox, h: 0 },
    });
    page.translationCompletion = {
      workflow: "erase-original",
      status: "pending",
    };
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");

    const result = await startInpaintingJob(
      makeContext(send, revisionChanges),
      {
        mode: "selection-pattern",
        workId: "work-a",
        selections: [
          {
            chapterId: chapterAId,
            mode: "page-set",
            pageIds: [pageA1Id],
          },
        ],
      },
      harness.runtime,
    );

    expect(result.status).toBe("failed");
    expect(result.chapters?.[0]?.pages[0]?.translationCompletion?.status).toBe(
      "failed",
    );
    expect(harness.inpaintPatternPage).not.toHaveBeenCalled();
    expect(harness.runtime.savePages).toHaveBeenCalledTimes(1);
  });

  it("skips a legacy blank page when another page has direct inpainting targets", async () => {
    const chapter = requireChapter(chapters, chapterAId);
    const blankPage = chapter.pages[0];
    if (!blankPage) throw new Error("expected blank page");
    blankPage.blocks = [];
    delete blankPage.translationCompletion;
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
      status: "completed",
      pagesChanged: 1,
      blocksErased: 1,
    });
    expect(harness.inpaintPatternPage).toHaveBeenCalledTimes(1);
    expect(harness.inpaintPatternPage).toHaveBeenCalledWith(
      expect.objectContaining({ id: pageA2Id }),
      expect.anything(),
    );
    expect(harness.runtime.savePages).toHaveBeenCalledTimes(1);
  });

  it("allows an explicitly excluded block to complete without inpainting", async () => {
    const chapter = requireChapter(chapters, chapterAId);
    const page = chapter.pages[0];
    const block = page?.blocks[0];
    if (!page || !block) throw new Error("expected page block");
    block.inpaintExcluded = true;
    page.translationCompletion = {
      workflow: "erase-original",
      status: "pending",
    };
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");

    const result = await startInpaintingJob(
      makeContext(send, revisionChanges),
      {
        mode: "selection-pattern",
        workId: "work-a",
        selections: [
          {
            chapterId: chapterAId,
            mode: "page-set",
            pageIds: [pageA1Id],
          },
        ],
        postprocess: {
          bubbleLayout: { enabled: false, policy: "balanced" },
        },
      },
      harness.runtime,
    );

    expect(result).toMatchObject({
      status: "completed",
      pagesChanged: 0,
      blocksErased: 0,
    });
    expect(result.chapters?.[0]?.pages[0]?.translationCompletion).toEqual({
      workflow: "erase-original",
      status: "completed",
    });
    expect(harness.inpaintPatternPage).not.toHaveBeenCalled();
  });

  it("rejects an inpainting result for a different page before saving", async () => {
    const page = requireChapter(chapters, chapterAId).pages[0];
    if (!page) throw new Error("expected page");
    harness.inpaintPatternPage.mockResolvedValueOnce({
      page: {
        ...page,
        id: pageA2Id,
        inpaintedImagePath: `${page.imagePath}.inpainted.png`,
      },
      blocksErased: 1,
    });
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");

    const result = await startInpaintingJob(
      makeContext(send, revisionChanges),
      {
        mode: "selection-pattern",
        workId: "work-a",
        selections: [
          {
            chapterId: chapterAId,
            mode: "page-set",
            pageIds: [pageA1Id],
          },
        ],
      },
      harness.runtime,
    );

    expect(result).toMatchObject({
      status: "failed",
      pagesChanged: 0,
      blocksErased: 0,
    });
    expect(harness.runtime.savePages).not.toHaveBeenCalled();
    expect(revisionChanges).toHaveLength(0);
  });

  it("fails when the save result does not contain the committed artifact", async () => {
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
        selections: [
          {
            chapterId: chapterAId,
            mode: "page-set",
            pageIds: [pageA1Id],
          },
        ],
      },
      harness.runtime,
    );

    expect(result).toMatchObject({
      status: "failed",
      error: "인페인팅 결과 이미지가 저장되지 않았습니다.",
      pagesChanged: 0,
      blocksErased: 0,
    });
    expect(revisionChanges).toHaveLength(0);
  });

  it.each([
    {
      label: "duplicate pages",
      selections: [
        {
          chapterId: chapterAId,
          mode: "page-set" as const,
          pageIds: [pageA1Id, pageA1Id],
        },
      ],
      error: /Duplicate page/,
    },
    {
      label: "unknown pages",
      selections: [
        {
          chapterId: chapterAId,
          mode: "page-set" as const,
          pageIds: [pageB1Id],
        },
      ],
      error: /does not belong/,
    },
  ])(
    "rejects $label before acquiring an engine",
    async ({ selections, error }) => {
      const { startInpaintingJob } =
        await import("../src/main/jobs/inpaintingJobs");
      const result = await startInpaintingJob(
        makeContext(send),
        {
          mode: "selection-pattern",
          workId: "work-a",
          selections,
        },
        harness.runtime,
      );

      expect(result.status).toBe("failed");
      expect(result.error).toMatch(error);
      expect(harness.acquireEngine).not.toHaveBeenCalled();
      expect(harness.inpaintPatternPage).not.toHaveBeenCalled();
    },
  );

  it("rejects a selected chapter from a different work", async () => {
    chapters.set(
      chapterBId,
      makeChapter(chapterBId, "work-b", [makePage(pageB1Id, "b-1.png")]),
    );
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");
    const result = await startInpaintingJob(
      makeContext(send),
      {
        mode: "selection-pattern",
        workId: "work-a",
        selections: [{ chapterId: chapterBId, mode: "all" }],
      },
      harness.runtime,
    );

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/requested work/);
    expect(harness.acquireEngine).not.toHaveBeenCalled();
  });

  it.each([
    {
      status: "failed" as const,
      error: new Error("second page failed"),
    },
    {
      status: "cancelled" as const,
      error: new DOMException("Aborted", "AbortError"),
    },
  ])(
    "returns one partial history transaction when a job is $status",
    async ({ status, error }) => {
      harness.inpaintPatternPage
        .mockImplementationOnce(async (page: MangaPage) => ({
          page: {
            ...page,
            inpaintedImagePath: `${page.imagePath}.inpainted.png`,
          },
          blocksErased: 1,
        }))
        .mockRejectedValueOnce(error);
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

      expect(result.status).toBe(status);
      expect(result.historyTransaction).toEqual({
        transactionId: HISTORY_TRANSACTION_ID,
      });
      expect(result.pagesChanged).toBe(1);
      expect(result.blocksErased).toBe(1);
      expect(revisionChanges).toHaveLength(1);
      expect(revisionChanges[0]).toMatchObject({
        chapterId: chapterAId,
        pageId: pageA1Id,
      });
      if (status === "failed") {
        expect(harness.runtime.logError).toHaveBeenCalledWith(
          "Inpainting job failed",
          expect.objectContaining({ error }),
        );
      } else {
        expect(harness.runtime.logError).not.toHaveBeenCalled();
      }
    },
  );

  it("emits cancellation after refresh and before clearing the runner", async () => {
    const refreshedChapter = createDeferred<ChapterSnapshot>();
    vi.mocked(harness.runtime.openChapter).mockImplementation(
      async (chapterId) => {
        if (vi.mocked(harness.runtime.openChapter).mock.calls.length === 1) {
          return requireChapter(chapters, chapterId);
        }
        return refreshedChapter.promise;
      },
    );
    harness.inpaintPatternPage.mockImplementation(
      (_page: MangaPage, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");
    const context = makeContext(send, revisionChanges);
    const terminalOrder: string[] = [];
    send.mockImplementation((_channel, event) => {
      if (event.status === "cancelled") {
        expect(context.jobs.hasActive).toBe(true);
        terminalOrder.push("cancelled");
      }
    });
    const clearIfCurrent = context.jobs.clearIfCurrent.bind(context.jobs);
    vi.spyOn(context.jobs, "clearIfCurrent").mockImplementation((jobId) => {
      terminalOrder.push("clear");
      clearIfCurrent(jobId);
    });
    const resultPromise = startInpaintingJob(
      context,
      {
        mode: "selection-pattern",
        workId: "work-a",
        selections: [{ chapterId: chapterAId, mode: "all" }],
      },
      harness.runtime,
    );
    await vi.waitFor(() => {
      expect(harness.inpaintPatternPage).toHaveBeenCalled();
      expect(context.jobs.current?.cleanup).toBeTypeOf("function");
    });
    const job = context.jobs.current;
    expect(job).not.toBeNull();
    job?.abortController.abort();

    const cleanupPromise = job
      ? context.jobs.runCleanup(job, "test-cancel")
      : Promise.resolve();
    await vi.waitFor(() =>
      expect(harness.runtime.openChapter).toHaveBeenCalledTimes(2),
    );
    expect(terminalOrder).toEqual([]);
    expect(context.jobs.current).not.toBeNull();

    refreshedChapter.resolve(requireChapter(chapters, chapterAId));
    await cleanupPromise;
    expect(context.jobs.current).toBeNull();
    await expect(resultPromise).resolves.toMatchObject({ status: "cancelled" });
    expect(terminalOrder).toEqual(["cancelled", "clear"]);
  });
});
