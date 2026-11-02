import { describe, expect, it, vi } from "vitest";
import {
  executePageWorkflow,
  type PageWorkflowExecutionPort,
} from "../src/main/application/pageWorkflowService";
import { PageWorkflowPartialFailure } from "../src/main/application/pageWorkflowPartialFailure";
import { createPageWorkflowPlan } from "../src/shared/pageWorkflowTypes";
import { type PageWorkflowStage } from "../src/shared/pageWorkflowStages";
import {
  preflightPageWorkflow,
  workflowStageKey,
  workflowTargetBlocks,
  workflowRegionKey,
} from "../src/shared/pageWorkflowPolicy";
import { resolveBlockDisplayText } from "../src/shared/blockDisplayText";
import { makePage, makeChapter } from "./helpers/workspacePointerFixtures";
import type { MangaPage } from "../src/shared/libraryTypes";
import { isNonRetriableRuntimeError } from "../src/main/pipeline/failure";
import { emitWorkflowCompletion } from "../src/main/jobs/pageWorkflowProgress";
import { extractModelOutputFailure } from "./helpers/runtimeModelContracts";

function harness(
  stages: PageWorkflowStage[],
  execute?: PageWorkflowExecutionPort["execute"],
) {
  let chapter = makeChapter(makePage());
  const abort = new AbortController();
  const port: PageWorkflowExecutionPort = {
    readChapter: async () => structuredClone(chapter),
    acquirePage: vi.fn(async () => {}),
    releasePage: vi.fn(),
    prepareStage: vi.fn(async () => {}),
    progress: vi.fn(),
    isFatal: (error) => error instanceof TypeError,
    execute: vi.fn(execute ?? (async (_stage, _chapter, page) => page)),
    save: vi.fn(async (_chapter, before, after) => {
      expect(chapter.pages.find((p) => p.id === before.id)).toEqual(before);
      chapter = {
        ...chapter,
        pages: chapter.pages.map((p) =>
          p.id === before.id ? structuredClone(after) : p,
        ),
      };
    }),
  };
  const input = {
    runId: "run-1",
    plan: { ...createPageWorkflowPlan(["ocr"]), stages },
    selection: [{ chapterId: chapter.id, pageIds: [chapter.pages[0].id] }],
    signal: abort.signal,
  };
  return {
    port,
    input,
    abort,
    page: () => chapter.pages[0],
    addPage: (page: MangaPage) => {
      chapter.pages.push(page);
      input.selection[0].pageIds.push(page.id);
    },
    edit: (patch: Partial<MangaPage>) => {
      chapter.pages[0] = { ...chapter.pages[0], ...patch };
    },
  };
}

describe("Hayai page workflow commits", () => {
  it("passes the provider block reason to the final job event and preserves page content", async () => {
    const failure = extractModelOutputFailure({
      choices: [
        { finish_reason: "content_filter: PROHIBITED_CONTENT", index: 0 },
      ],
    });
    expect(failure).not.toBeNull();
    if (!failure) throw new Error("Expected a content-policy failure");
    const error = Object.assign(new Error(failure.message), failure);
    const h = harness(["translate"], async () => {
      throw error;
    });
    h.port.isFatal = isNonRetriableRuntimeError;
    const original = structuredClone(h.page());
    const emit = vi.fn();

    const result = await executePageWorkflow(h.input, h.port);
    emitWorkflowCompletion(emit, h.input.runId, result, 1);

    expect(h.port.execute).toHaveBeenCalledOnce();
    expect(h.page().blocks).toEqual(original.blocks);
    expect(h.page().imagePath).toBe(original.imagePath);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        progressText: expect.stringContaining("사유: PROHIBITED_CONTENT"),
      }),
    );
  });

  it.each(["fatal", "cancel", "cleanup"])(
    "preserves earlier page issues when a later %s interrupts the stage",
    async (failure) => {
      const first = new Error("first page failure", {
        cause: new Error("underlying cause"),
      });
      Object.assign(first, { code: "MODEL_SCHEMA" });
      const h = harness(["ocr"], async (_stage, _chapter, page) => {
        if (page.id === "page-1") throw first;
        if (failure === "cancel") h.abort.abort();
        if (failure === "fatal") throw new TypeError("fatal second page");
        return page;
      });
      h.addPage({ ...makePage(), id: "page-2" });
      const reportFailure = vi.fn();
      h.port.reportFailure = reportFailure;
      if (failure === "cleanup")
        h.port.finishStage = async () => {
          throw new Error("cleanup failed");
        };
      const result = await executePageWorkflow(h.input, h.port);
      expect(result.issues[0]).toMatchObject({
        pageId: "page-1",
        message: "first page failure",
      });
      expect(result.status).toBe(failure === "cancel" ? "cancelled" : "failed");
      expect(reportFailure).toHaveBeenCalledWith(first, {
        chapterId: "chapter-1",
        pageId: "page-1",
        stage: "ocr",
      });
      expect(first.cause).toBeInstanceOf(Error);
    },
  );

  it("passes both preparation and cleanup errors to diagnostics", async () => {
    const h = harness(["ocr"]);
    const prepare = new Error("prepare failed");
    const cleanup = new Error("cleanup failed");
    h.port.prepareStage = async () => {
      throw prepare;
    };
    h.port.finishStage = async () => {
      throw cleanup;
    };
    const report = vi.fn();
    h.port.reportFailure = report;
    await executePageWorkflow(h.input, h.port);
    const aggregate = report.mock.calls.find(
      ([error]) => error instanceof AggregateError,
    )?.[0] as AggregateError;
    expect(aggregate.errors).toEqual([prepare, cleanup]);
  });
  it("closes failed page timings and marks receipt-skipped stages without executing them again", async () => {
    const h = harness(["ocr"]);
    const finish = vi.fn(async () => {});
    h.port.startPageTiming = vi.fn(() => finish);
    h.port.skipPageTiming = vi.fn();
    await executePageWorkflow(h.input, h.port);
    expect(finish).toHaveBeenCalledOnce();
    await executePageWorkflow(h.input, h.port);
    expect(h.port.startPageTiming).toHaveBeenCalledOnce();
    expect(h.port.skipPageTiming).toHaveBeenCalledWith(
      "ocr",
      "chapter-1",
      "page-1",
    );
    const failed = harness(["ocr"], async () => {
      throw new Error("failed OCR");
    });
    const failedFinish = vi.fn(async () => {});
    failed.port.startPageTiming = () => failedFinish;
    expect((await executePageWorkflow(failed.input, failed.port)).status).toBe(
      "partial",
    );
    expect(failedFinish).toHaveBeenCalledOnce();
  });
  it("fails a missing target before stage preparation and releases all ownership", async () => {
    const h = harness(["ocr"]);
    h.input.selection[0].pageIds.push("deleted-during-handoff");
    const result = await executePageWorkflow(h.input, h.port);
    expect(result.status).toBe("failed");
    expect(h.port.prepareStage).not.toHaveBeenCalled();
    expect(h.port.execute).not.toHaveBeenCalled();
    expect(h.port.save).not.toHaveBeenCalled();
    expect(h.port.releasePage).toHaveBeenCalledTimes(2);
  });

  it("reads current data before each page without acquisition reads for 100 targets", async () => {
    const h = harness(["ocr"]);
    for (let i = 1; i < 100; i++)
      h.addPage({ ...makePage(), id: `page-${i + 1}` });
    h.port.acquirePage = vi.fn(async () => {});
    h.port.readChapter = vi.fn(h.port.readChapter);
    const result = await executePageWorkflow(h.input, h.port);
    expect(result.status).toBe("completed");
    expect(h.port.acquirePage).toHaveBeenCalledTimes(100);
    expect(h.port.readChapter).toHaveBeenCalledTimes(102);
    expect(h.port.execute).toHaveBeenCalledTimes(100);
    expect(h.port.releasePage).toHaveBeenCalledTimes(100);
  });

  it("finishes each stage before preparing the next", async () => {
    const order: string[] = [];
    const h = harness(["ocr", "translate"]);
    h.port.prepareStage = async (stage) => {
      order.push(stage);
    };
    h.port.finishStage = async () => {
      order.push("close");
    };
    await executePageWorkflow(h.input, h.port);
    expect(order).toEqual(["ocr", "close", "translate", "close"]);
  });

  it("releases page ownership and retains the primary error if cleanup also fails", async () => {
    const h = harness(["ocr", "translate"]);
    h.port.prepareStage = async () => {
      throw new Error("preparation failed");
    };
    h.port.finishStage = vi.fn(async () => {
      throw new Error("cleanup failed");
    });
    const result = await executePageWorkflow(h.input, h.port);
    expect(result.status).toBe("failed");
    expect(result.issues[0].message).toContain("preparation failed");
    expect(h.port.finishStage).toHaveBeenCalledTimes(1);
    expect(h.port.releasePage).toHaveBeenCalledTimes(1);
    expect(h.port.execute).not.toHaveBeenCalled();
  });

  it("does not prepare or restore an entirely completed typography stage", async () => {
    const h = harness(["typography"]);
    const restore = vi.fn();
    h.port.restoreCompletedStage = restore;
    await executePageWorkflow(h.input, h.port);
    await executePageWorkflow(h.input, h.port);
    expect(h.port.prepareStage).toHaveBeenCalledTimes(1);
    expect(h.port.execute).toHaveBeenCalledTimes(1);
    expect(restore).not.toHaveBeenCalled();
    expect(h.port.progress).toHaveBeenCalledTimes(2);
  });

  it("prepares the whole selection when only part of typography is complete", async () => {
    const h = harness(["typography"]);
    await executePageWorkflow(h.input, h.port);
    h.addPage({ ...makePage(), id: "second" });
    const restore = vi.fn();
    h.port.restoreCompletedStage = restore;
    await executePageWorkflow(h.input, h.port);
    expect(h.port.prepareStage).toHaveBeenLastCalledWith(
      "typography",
      expect.anything(),
      ["page-1", "second"],
    );
    expect(restore).toHaveBeenCalledTimes(1);
    expect(h.port.execute).toHaveBeenCalledTimes(2);
  });

  it("keeps processing other pages after a page-local failure", async () => {
    const h = harness(
      ["translate", "review"],
      async (stage, _chapter, page) => {
        if (stage === "translate" && page.id !== "second")
          throw new Error("Invalid page response");
        return page;
      },
    );
    h.addPage({ ...makePage(), id: "second" });
    const result = await executePageWorkflow(h.input, h.port);
    expect(result.status).toBe("partial");
    expect(
      vi
        .mocked(h.port.execute)
        .mock.calls.map(([stage, , page]) => [stage, page.id]),
    ).toEqual([
      ["translate", h.page().id],
      ["translate", "second"],
      ["review", "second"],
    ]);
    expect(h.port.releasePage).toHaveBeenCalledTimes(2);
  });
  it("holds erasure when translation fails in the same workflow", async () => {
    const h = harness(
      ["translate", "typography", "erase", "layout"],
      async (stage, _chapter, page) => {
        if (stage === "translate") throw new Error("Invalid page response");
        return { ...page, inpaintedImagePath: "clean.png" };
      },
    );
    expect((await executePageWorkflow(h.input, h.port)).status).toBe("partial");
    expect(
      vi.mocked(h.port.execute).mock.calls.map(([stage]) => stage),
    ).toEqual(["translate"]);
    expect(h.page().inpaintedImagePath).not.toBe("clean.png");
  });

  it("still allows standalone erasure without a translation", async () => {
    const h = harness(["erase"], async (_stage, _chapter, page) => ({
      ...page,
      inpaintedImagePath: "clean.png",
    }));
    h.edit({
      blocks: h
        .page()
        .blocks.map((block) => ({ ...block, translatedText: "" })),
    });
    expect((await executePageWorkflow(h.input, h.port)).status).toBe(
      "completed",
    );
    expect(h.page().inpaintedImagePath).toBe("clean.png");
  });

  it("does not repeat completed translations solely for an empty slot", async () => {
    const h = harness(["translate"]);
    h.edit({
      blocks: h.page().blocks.map((block) => ({
        ...block,
        sourceText: "はぁ",
        translatedText: "",
      })),
    });
    await executePageWorkflow(h.input, h.port);
    vi.mocked(h.port.execute).mockImplementation(
      async (_stage, _chapter, page) => ({
        ...page,
        blocks: page.blocks.map((block) => ({
          ...block,
          translatedText: "하아",
        })),
      }),
    );
    await executePageWorkflow(h.input, h.port);
    expect(h.port.execute).toHaveBeenCalledTimes(1);
    expect(h.page().blocks[0].translatedText).toBe("");
  });

  it("preserves confirmed no-text detection across a new run", async () => {
    const h = harness(["detect"], async (_stage, _chapter, page) => ({
      ...page,
      blocks: [],
    }));
    await executePageWorkflow(h.input, h.port);
    const next = {
      ...h.input,
      runId: "run-2",
      plan: createPageWorkflowPlan(["ocr", "review"]),
    };
    await executePageWorkflow(next, h.port);
    const request = {
      plan: createPageWorkflowPlan(["translate"]),
      selection: h.input.selection,
    };
    const result = preflightPageWorkflow(request, [makeChapter(h.page())]);
    expect(result.issues).toEqual([]);
    expect(result.counts[0].empty).toBe(1);
    expect(
      preflightPageWorkflow(
        {
          ...request,
          plan: {
            ...createPageWorkflowPlan(["detect", "translate"]),
            overwrite: ["detect"],
          },
        },
        [makeChapter(h.page())],
      ).issues,
    ).not.toEqual([]);
    h.edit({ imagePath: "different-original.png" });
    expect(
      preflightPageWorkflow(request, [makeChapter(h.page())]).issues,
    ).not.toEqual([]);
  });
  it("rechecks only the stage whose configuration changed", async () => {
    const h = harness(["ocr", "translate", "erase"]);
    const first = {
      ...h.input,
      configurationKeys: {
        ocr: "ocr-1",
        translate: "model-1",
        erase: "erase-1",
      },
    };
    await executePageWorkflow(first, h.port);
    vi.mocked(h.port.execute).mockClear();
    await executePageWorkflow(
      {
        ...first,
        configurationKeys: { ...first.configurationKeys, translate: "model-2" },
      },
      h.port,
    );
    expect(
      vi.mocked(h.port.execute).mock.calls.map(([stage]) => stage),
    ).toEqual(["translate"]);
  });
  it("executes fixed order and does not repeat edits after downstream changes and restart", async () => {
    const h = harness(
      ["format-rules", "ocr", "translate"],
      async (stage, _chapter, page) => ({
        ...page,
        blocks: page.blocks.map((b) =>
          stage === "format-rules"
            ? { ...b, fontSizePx: b.fontSizePx + 2 }
            : stage === "translate"
              ? { ...b, translatedText: "new" }
              : { ...b, sourceText: "corrected" },
        ),
      }),
    );
    const size = h.page().blocks[0].fontSizePx;
    expect((await executePageWorkflow(h.input, h.port)).status).toBe(
      "completed",
    );
    expect(
      vi.mocked(h.port.execute).mock.calls.map(([stage]) => stage),
    ).toEqual(["ocr", "translate", "format-rules"]);
    expect(h.page().blocks[0].fontSizePx).toBe(size + 2);
    await executePageWorkflow(
      { ...h.input, signal: new AbortController().signal },
      h.port,
    );
    expect(h.port.execute).toHaveBeenCalledTimes(3);
    expect(h.page().blocks[0].fontSizePx).toBe(size + 2);
  });
  it("a new run deliberately applies selected rules again", async () => {
    const h = harness(["format-rules"], async (_stage, _chapter, p) => ({
      ...p,
      blocks: p.blocks.map((b) => ({ ...b, fontSizePx: b.fontSizePx + 2 })),
    }));
    await executePageWorkflow(h.input, h.port);
    await executePageWorkflow({ ...h.input, runId: "run-2" }, h.port);
    expect(h.port.execute).toHaveBeenCalledTimes(2);
  });
  it("cancel before a commit preserves the last saved stage", async () => {
    const h = harness(["ocr", "translate"], async (stage, _chapter, p) => {
      if (stage === "translate") h.abort.abort();
      return {
        ...p,
        blocks: p.blocks.map((b) => ({ ...b, sourceText: stage })),
      };
    });
    const result = await executePageWorkflow(h.input, h.port);
    expect(result.status).toBe("cancelled");
    expect(h.page().blocks[0].sourceText).toBe("ocr");
    expect(h.page().pageWorkflow?.steps.translate).toBeUndefined();
    expect(h.port.releasePage).toHaveBeenCalledTimes(1);
  });
  it("stores partial erasure and retries only the failed stage", async () => {
    let failed = true;
    const h = harness(
      ["ocr", "erase", "review"],
      async (stage, _chapter, p) => {
        if (stage === "erase" && failed) {
          failed = false;
          throw new PageWorkflowPartialFailure("one region failed", {
            ...p,
            inpaintedImagePath: "partial.png",
          });
        }
        return p;
      },
    );
    expect((await executePageWorkflow(h.input, h.port)).status).toBe("partial");
    expect(h.page().inpaintedImagePath).toBe("partial.png");
    expect(h.page().pageWorkflow?.steps.review?.status).toBe("completed");
    await executePageWorkflow(h.input, h.port);
    expect(vi.mocked(h.port.execute).mock.calls.map(([s]) => s)).toEqual([
      "ocr",
      "erase",
      "review",
      "erase",
    ]);
  });
  it("does not save partial translations after cancellation", async () => {
    const h = harness(["translate"], async (_stage, _chapter, page) => {
      h.abort.abort();
      throw new PageWorkflowPartialFailure("missing", {
        ...page,
        blocks: page.blocks.map((block) => ({
          ...block,
          translatedText: "new",
        })),
      });
    });
    const before = structuredClone(h.page());
    expect((await executePageWorkflow(h.input, h.port)).status).toBe(
      "cancelled",
    );
    expect(h.port.save).not.toHaveBeenCalled();
    expect(h.page()).toEqual(before);
  });

  it("does not retry a failed transaction as a stale failure write", async () => {
    const h = harness(["ocr"]);
    h.port.save = vi.fn(async () => {
      throw new Error("revision conflict");
    });
    expect((await executePageWorkflow(h.input, h.port)).status).toBe("failed");
    expect(h.port.save).toHaveBeenCalledTimes(1);
    expect(h.page().pageWorkflow).toBeUndefined();
  });
  it("a translation edit leaves committed erasure valid", async () => {
    const h = harness(["erase"]);
    await executePageWorkflow(h.input, h.port);
    h.edit({
      blocks: h
        .page()
        .blocks.map((b) => ({ ...b, translatedText: "manual correction" })),
    });
    await executePageWorkflow(h.input, h.port);
    expect(h.port.execute).toHaveBeenCalledTimes(1);
  });
});

describe("page workflow input and preservation", () => {
  it("blocks translation without source but allows detection plus erasure", () => {
    const page = { ...makePage(), blocks: [] };
    const chapter = makeChapter(page);
    const selection = [{ chapterId: chapter.id, pageIds: [page.id] }];
    expect(
      preflightPageWorkflow(
        { plan: createPageWorkflowPlan(["detect", "erase"]), selection },
        [chapter],
      ).issues,
    ).toEqual([]);
    expect(
      preflightPageWorkflow(
        { plan: createPageWorkflowPlan(["detect", "translate"]), selection },
        [chapter],
      ).issues.length,
    ).toBeGreaterThan(0);
  });
  it("fills only empty fields and skips erased geometry", () => {
    const page = makePage();
    page.inpaintedImagePath = "cleaned.png";
    page.erasedWorkflowRegions = {
      [page.blocks[0].id]: workflowRegionKey(page, page.blocks[0]),
    };
    const plan = createPageWorkflowPlan(["ocr", "translate", "erase"]);
    expect(workflowTargetBlocks(page, "ocr", plan)).toEqual([]);
    expect(workflowTargetBlocks(page, "translate", plan)).toEqual([]);
    expect(workflowTargetBlocks(page, "erase", plan)).toEqual([]);
    expect(
      workflowTargetBlocks(page, "ocr", { ...plan, overwrite: ["ocr"] }),
    ).toHaveLength(1);
  });
  it("prepared blank blocks suppress fallback text; legacy blocks still display source", () => {
    const block = makePage({ blockPatch: { translatedText: "" } }).blocks[0];
    expect(resolveBlockDisplayText(block)).toBe("source");
    expect(
      resolveBlockDisplayText({
        ...block,
        textDisplayMode: "translation-only",
      }),
    ).toBe("");
    expect(
      resolveBlockDisplayText({
        ...block,
        textDisplayMode: "translation-only",
        translatedText: "done",
      }),
    ).toBe("done");
  });
  it("erasure signatures consume geometry and exclusion but not translated text", () => {
    const page = makePage();
    const key = workflowStageKey(page, "erase");
    page.blocks[0].translatedText = "new";
    expect(workflowStageKey(page, "erase")).toBe(key);
    page.blocks[0].inpaintExcluded = true;
    expect(workflowStageKey(page, "erase")).not.toBe(key);
  });
});

it("publishes page checkpoints only after durable saves, before the next chapter starts", async () => {
  const first = makeChapter(makePage());
  const second = {
    ...makeChapter({ ...makePage(), id: "page-2" }),
    id: "chapter-2",
    title: "2화",
  };
  const chapters = new Map(
    [first, second].map((chapter) => [chapter.id, chapter]),
  );
  const order: string[] = [];
  const h = harness(["ocr", "translate"]);
  h.input.selection = [first, second].map((c) => ({
    chapterId: c.id,
    pageIds: c.pages.map((p) => p.id),
  }));
  h.port.readChapter = async (id) => structuredClone(chapters.get(id) ?? first);
  h.port.execute = async (stage, chapter, page) => {
    order.push(`execute:${chapter.id}:${stage}`);
    return page;
  };
  h.port.save = async (id, _before, after) => {
    const chapter = chapters.get(id);
    if (!chapter) throw new Error("Missing chapter");
    chapter.pages = [after];
    order.push(`save:${id}`);
  };
  h.port.pageSettled = (stage, _page, chapter) => {
    expect(
      chapters.get(chapter.id)?.pages[0].pageWorkflow?.steps[stage]?.status,
    ).toBe("completed");
    order.push(`checkpoint:${chapter.id}:${stage}`);
  };
  expect((await executePageWorkflow(h.input, h.port)).status).toBe("completed");
  expect(order).toEqual(
    ["chapter-1", "chapter-2"].flatMap((id) =>
      ["ocr", "translate"].flatMap((stage) => [
        `execute:${id}:${stage}`,
        `save:${id}`,
        `checkpoint:${id}:${stage}`,
      ]),
    ),
  );
});

it("does not publish a saved checkpoint when persistence fails", async () => {
  const h = harness(["ocr"]);
  h.port.save = async () => {
    throw new Error("disk full");
  };
  h.port.pageSettled = vi.fn();
  expect((await executePageWorkflow(h.input, h.port)).status).toBe("failed");
  expect(h.port.pageSettled).not.toHaveBeenCalled();
});
