import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { AppPaths } from "../src/main/appPaths";
import { createPageWorkflowPlan } from "../src/shared/pageWorkflowTypes";
import { resolveDefaultAppSettings } from "../src/main/settings/appSettingsDefaults";
import { workflowStageKey } from "../src/shared/pageWorkflowPolicy";
import { makeChapter, makePage } from "./helpers/workspacePointerFixtures";
import {
  completeWorkflowReceipt,
  failWorkflowReceipt,
} from "../src/main/application/pageWorkflowReceipts";

const roots: string[] = [];
afterEach(async () => {
  vi.doUnmock("../src/main/appPaths");
  vi.resetModules();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "page-workflow-storage-"));
  roots.push(root);
  const paths: AppPaths = {
    isPackaged: false,
    repoRoot: root,
    executableDir: root,
    resourcesDir: root,
    dataRoot: root,
    settingsPath: join(root, "settings.json"),
    libraryDir: root,
    fontsDir: join(root, "fonts"),
    logsDir: root,
    logFile: join(root, "test.log"),
    runtimeDir: resolve("src/main/runtime"),
    toolsDir: join(root, "tools"),
    ocrRuntimeDir: join(root, "ocr"),
    llamaRuntimeDir: join(root, "llama"),
    llamaServerPath: join(root, "llama", "llama-server.exe"),
  };
  vi.resetModules();
  vi.doMock("../src/main/appPaths", () => ({
    getAppPaths: () => paths,
  }));
  const workId = randomUUID(),
    chapterId = randomUUID();
  const directory = join(root, "works", workId, "chapters", chapterId);
  await mkdir(directory, { recursive: true });
  const page = {
    ...makePage(),
    id: randomUUID(),
    imagePath: join(directory, "original.png"),
  };
  const chapter = { ...makeChapter(page), id: chapterId, workId };
  const { dataUrl: _dataUrl, ...record } = page;
  const file = join(directory, "chapter.json");
  await writeFile(file, JSON.stringify({ ...chapter, pages: [record] }));
  await writeFile(
    join(root, "index.json"),
    JSON.stringify({ workOrder: [workId] }),
  );
  await writeFile(
    join(root, "works", workId, "work.json"),
    JSON.stringify({
      id: workId,
      title: "Test",
      chapterOrder: [chapterId],
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
    }),
  );
  const mutation =
    await import("../src/main/libraryStore/pageWorkflowMutations");
  const transaction =
    await import("../src/main/libraryStore/libraryTransaction");
  const recovery =
    await import("../src/main/libraryStore/libraryTransactionRecovery");
  const after = completeWorkflowReceipt(
    { runId: randomUUID(), planKey: "plan", steps: {}, findings: [] },
    page,
    {
      ...page,
      blocks: page.blocks.map((b) => ({ ...b, sourceText: "새 원문" })),
    },
    "ocr",
  );
  return {
    root,
    paths,
    page,
    after,
    chapterId,
    file,
    mutation,
    transaction,
    recovery,
  };
}

describe("page content and receipt transaction", () => {
  it("records real new-workflow jobs and resumed attempts through the production job path", async () => {
    const f = await fixture();
    const stored = JSON.parse(await readFile(f.file, "utf8"));
    stored.pages[0].blocks = [];
    stored.pages[0].pageWorkflow = {
      runId: randomUUID(),
      planKey: "empty",
      steps: {},
      findings: [],
      emptyDetectionKey: workflowStageKey({ ...f.page, blocks: [] }, "detect"),
    };
    await writeFile(f.file, JSON.stringify(stored));
    const { startPageWorkflowJob } =
      await import("../src/main/jobs/pageWorkflowJob");
    const { ActiveJobStore } = await import("../src/main/jobs/activeJob");
    const { readPageWorkflowTimings } =
      await import("../src/main/pageWorkflow/pageWorkflowTimingStore");
    const jobs = new ActiveJobStore();
    const stopHandoffs = jobs.pageHandoffs.subscribe(() => {
      for (const page of jobs.pageHandoffs.activities) {
        const requestId = page.requestId;
        if (requestId)
          queueMicrotask(() => jobs.pageHandoffs.respond({ requestId }));
      }
    });
    const events = vi.spyOn(jobs, "updateLastEvent");
    const context = {
      jobs,
      appPaths: f.paths,
      getMainWindow: () => null,
      decodeImage: () => {
        throw new Error("This empty review must not decode an image");
      },
    };
    const settings = resolveDefaultAppSettings({
      MANGA_TRANSLATOR_OCR_PIPELINE: "hayai",
    });
    settings.ocr.pipeline = "hayai";
    const request = {
      plan: createPageWorkflowPlan(["review"]),
      selection: [{ chapterId: f.chapterId, pageIds: [f.page.id] }],
    };
    const first = await startPageWorkflowJob(context, request, settings);
    expect(first.status, JSON.stringify(first.issues)).toBe("completed");
    const [saved] = await readPageWorkflowTimings(f.root, f.chapterId);
    expect(saved.status).toBe("completed");
    expect(saved.stages.review).toBeGreaterThanOrEqual(0);
    expect(saved.pages[0].stages.review).toBeGreaterThanOrEqual(0);
    expect(saved.elapsedMs).toBeGreaterThanOrEqual(saved.cleanupMs);
    const terminal = events.mock.calls
      .map(([, event]) => event)
      .filter((event) => event.status === "completed");
    expect(terminal).toHaveLength(1);
    expect(terminal[0].executionId).toBe(saved.attemptId);
    expect(terminal[0].workflowProgress).toEqual({
      pageCount: 1,
      stageCount: 1,
    });
    expect(
      events.mock.calls.every(
        ([, event]) =>
          event.workflowProgress?.pageCount === 1 &&
          event.workflowProgress.stageCount === 1,
      ),
    ).toBe(true);
    const second = await startPageWorkflowJob(
      context,
      { ...request, resumeRunId: first.runId },
      settings,
    );
    expect(second.status).toBe("completed");
    const records = await readPageWorkflowTimings(f.root, f.chapterId);
    expect(records).toHaveLength(2);
    expect(
      records.find((record) => record.attemptId !== saved.attemptId)?.pages[0]
        .skippedStages,
    ).toEqual(["review"]);
    expect(jobs.hasActive).toBe(false);
    stopHandoffs();
  });
  it("reads historical empty translations as completed in both the chapter and library summary without rewriting files", async () => {
    const f = await fixture();
    const stored = JSON.parse(await readFile(f.file, "utf8"));
    stored.pages[0] = {
      ...completeWorkflowReceipt(
        { runId: randomUUID(), planKey: "empty", steps: {}, findings: [] },
        { ...f.page, blocks: [] },
        { ...f.page, blocks: [] },
        "translate",
      ),
      analysisStatus: "idle",
    };
    delete stored.pages[0].dataUrl;
    stored.status = "partial";
    await writeFile(f.file, JSON.stringify(stored));
    const before = await readFile(f.file, "utf8");
    const { openChapter, listLibrary } = await import("../src/main/library");
    expect((await openChapter(f.chapterId)).status).toBe("completed");
    expect((await listLibrary()).works[0].chapters[0].status).toBe("completed");
    expect(await readFile(f.file, "utf8")).toBe(before);
  });
  it("persists source and stage receipt together while retaining analysis status", async () => {
    const f = await fixture();
    f.after.blocks[0].bubbleLayoutPaddingRatio = 0;
    f.after.blocks[0].inpaintExcluded = true;
    await f.mutation.savePageWorkflowResultUnlocked(
      f.chapterId,
      f.page,
      f.after,
    );
    const saved = JSON.parse(await readFile(f.file, "utf8")).pages[0];
    expect(saved.blocks[0].sourceText).toBe("새 원문");
    expect(saved.blocks[0].bubbleLayoutPaddingRatio).toBe(0);
    expect(saved.blocks[0].inpaintExcluded).toBe(true);
    const { openChapter } = await import("../src/main/library");
    const reopened = await openChapter(f.chapterId);
    expect(reopened.pages[0].blocks[0].bubbleLayoutPaddingRatio).toBe(0);
    expect(reopened.pages[0].blocks[0].inpaintExcluded).toBe(true);
    expect(saved.pageWorkflow.steps.ocr.status).toBe("completed");
    expect(saved.analysisStatus).toBe("idle");
    expect(saved.dataUrl).toBeUndefined();
    await expect(
      f.mutation.savePageWorkflowResultUnlocked(f.chapterId, f.page, f.after),
    ).rejects.toThrow(/변경되어/);
  });

  it("persists a real translation failure without discarding existing text", async () => {
    const f = await fixture();
    const receipt = {
      runId: randomUUID(),
      planKey: "plan",
      steps: {},
      findings: [],
    };
    const after = failWorkflowReceipt(
      receipt,
      f.page,
      {
        ...f.page,
        blocks: f.page.blocks.map((block) => ({
          ...block,
          translatedText: "저장된 번역",
        })),
      },
      "translate",
      "모델 요청 실패",
    );
    await f.mutation.savePageWorkflowResultUnlocked(f.chapterId, f.page, after);
    const saved = JSON.parse(await readFile(f.file, "utf8")).pages[0];
    expect(saved.blocks[0].translatedText).toBe("저장된 번역");
    expect(saved.analysisStatus).toBe("failed");
    expect(saved.lastError).toBe("모델 요청 실패");
    expect(saved.pageWorkflow.steps.translate).toMatchObject({
      status: "failed",
      message: "모델 요청 실패",
    });
  });

  it.each(["after-replace-step", "after-commit-point"] as const)(
    "recovers matching content and receipt after %s",
    async (point) => {
      const f = await fixture();
      const restore = f.transaction.setLibraryTransactionCrashInjectorForTests(
        (current) => {
          if (current === point)
            throw new f.transaction.SimulatedLibraryTransactionCrash(point);
        },
      );
      try {
        await expect(
          f.mutation.savePageWorkflowResultUnlocked(
            f.chapterId,
            f.page,
            f.after,
          ),
        ).rejects.toBeInstanceOf(
          f.transaction.SimulatedLibraryTransactionCrash,
        );
      } finally {
        restore();
      }
      await f.recovery.recoverLibraryTransactions();
      const saved = JSON.parse(await readFile(f.file, "utf8")).pages[0];
      if (point === "after-commit-point") {
        expect(saved.blocks[0].sourceText).toBe("새 원문");
        expect(saved.pageWorkflow.steps.ocr.status).toBe("completed");
      } else {
        expect(saved.blocks[0].sourceText).toBe(f.page.blocks[0].sourceText);
        expect(saved.pageWorkflow).toBeUndefined();
      }
    },
  );
});
