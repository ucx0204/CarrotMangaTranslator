import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
  vi.resetModules();
  vi.doMock("../src/main/appPaths", () => ({
    getAppPaths: () => ({ libraryDir: root, logFile: join(root, "test.log") }),
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
  return { page, after, chapterId, file, mutation, transaction, recovery };
}

describe("page content and receipt transaction", () => {
  it("persists source and stage receipt together while retaining analysis status", async () => {
    const f = await fixture();
    await f.mutation.savePageWorkflowResultUnlocked(
      f.chapterId,
      f.page,
      f.after,
    );
    const saved = JSON.parse(await readFile(f.file, "utf8")).pages[0];
    expect(saved.blocks[0].sourceText).toBe("새 원문");
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
