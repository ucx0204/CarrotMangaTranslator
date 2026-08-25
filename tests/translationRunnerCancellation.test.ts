import { describe, expect, it, vi } from "vitest";
import { ActiveJobStore } from "../src/main/jobs/activeJob";
import {
  type AnalysisJobRunnerDependencies,
  runResolvedAnalysisJob,
} from "../src/main/jobs/translationJobRunners";
import {
  type RegionJobRunnerDependencies,
  runRegionTranslationJob,
} from "../src/main/jobs/translationRegionJobRunner";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";

vi.mock("electron", () => ({
  app: { isPackaged: false },
}));

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

describe("analysis runner cancellation checkpoints", () => {
  it("does not mark pages running when cancellation arrives during work-context read", async () => {
    const chapter = makeChapter();
    const controller = new AbortController();
    const workContextGate = createDeferred<unknown>();
    const markChapterPagesRunning = vi.fn();
    const runWholePagePipeline = vi.fn();
    const dependencies = makeAnalysisDependencies({
      resolveWorkContextForChapter: vi.fn(() => workContextGate.promise),
      markChapterPagesRunning,
      runWholePagePipeline,
    });

    const promise = runResolvedAnalysisJob(
      makeAnalysisArgs(controller, chapter),
      dependencies,
    );
    controller.abort();
    workContextGate.resolve({ workId: "work-1" });

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(markChapterPagesRunning).not.toHaveBeenCalled();
    expect(runWholePagePipeline).not.toHaveBeenCalled();
  });

  it("stops before run paths and pipeline when cancellation arrives during mark-running", async () => {
    const chapter = makeChapter();
    const controller = new AbortController();
    const markGate = createDeferred<ChapterSnapshot>();
    const getRunPaths = vi.fn();
    const runWholePagePipeline = vi.fn();
    const dependencies = makeAnalysisDependencies({
      markChapterPagesRunning: vi.fn(() => markGate.promise),
      getRunPaths,
      runWholePagePipeline,
    });

    const promise = runResolvedAnalysisJob(
      makeAnalysisArgs(controller, chapter),
      dependencies,
    );
    await Promise.resolve();
    controller.abort();
    markGate.resolve(makeRunningChapter(chapter));

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(getRunPaths).not.toHaveBeenCalled();
    expect(runWholePagePipeline).not.toHaveBeenCalled();
  });

  it("does not enter the pipeline when cancellation arrives during getRunPaths", async () => {
    const chapter = makeChapter();
    const controller = new AbortController();
    const runPathsGate = createDeferred<unknown>();
    const runWholePagePipeline = vi.fn();
    const dependencies = makeAnalysisDependencies({
      getRunPaths: vi.fn(() => runPathsGate.promise),
      runWholePagePipeline,
    });

    const promise = runResolvedAnalysisJob(
      makeAnalysisArgs(controller, chapter),
      dependencies,
    );
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    runPathsGate.resolve({ runDir: "C:/run" });

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(runWholePagePipeline).not.toHaveBeenCalled();
  });
});

describe("region runner cancellation checkpoints", () => {
  it("does not create a crop when cancellation arrives during chapter open", async () => {
    const chapter = makeChapter();
    const controller = new AbortController();
    const chapterGate = createDeferred<ChapterSnapshot>();
    const createRegionCropPage = vi.fn();
    const dependencies = makeRegionDependencies({
      openChapter: vi.fn(() => chapterGate.promise),
      createRegionCropPage,
    });

    const promise = runRegionTranslationJob(
      makeRegionArgs(controller, chapter),
      dependencies,
    );
    controller.abort();
    chapterGate.resolve(chapter);

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(createRegionCropPage).not.toHaveBeenCalled();
  });

  it("does not start work context or pipeline when cancellation arrives during crop creation", async () => {
    const chapter = makeChapter();
    const controller = new AbortController();
    const cropGate = createDeferred<unknown>();
    const resolveWorkContextForChapter = vi.fn();
    const runWholePagePipeline = vi.fn();
    const dependencies = makeRegionDependencies({
      createRegionCropPage: vi.fn(() => cropGate.promise),
      resolveWorkContextForChapter,
      runWholePagePipeline,
    });

    const promise = runRegionTranslationJob(
      makeRegionArgs(controller, chapter),
      dependencies,
    );
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    cropGate.resolve(makeCropResult(firstPage(chapter)));

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(resolveWorkContextForChapter).not.toHaveBeenCalled();
    expect(runWholePagePipeline).not.toHaveBeenCalled();
  });

  it("does not start the pipeline when cancellation arrives during work-context read", async () => {
    const chapter = makeChapter();
    const controller = new AbortController();
    const workContextGate = createDeferred<unknown>();
    const runWholePagePipeline = vi.fn();
    const dependencies = makeRegionDependencies({
      resolveWorkContextForChapter: vi.fn(() => workContextGate.promise),
      runWholePagePipeline,
    });

    const promise = runRegionTranslationJob(
      makeRegionArgs(controller, chapter),
      dependencies,
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    workContextGate.resolve({ workId: "work-1" });

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(runWholePagePipeline).not.toHaveBeenCalled();
  });

  it("lets a successful append commit win even if cancellation arrives during the commit", async () => {
    const chapter = makeChapter();
    const controller = new AbortController();
    const appendAnalyzedPageBlocks = vi.fn(async () => {
      controller.abort();
      return chapter;
    });
    const dependencies = makeRegionDependencies({
      appendAnalyzedPageBlocks,
      runWholePagePipeline: vi.fn(async () => ({
        pages: [
          { ...firstPage(chapter), analysisStatus: "completed" as const },
        ],
        warnings: [],
      })),
    });
    const emit = vi.fn();
    const args = makeRegionArgs(controller, chapter);
    args.emit = emit;

    const result = await runRegionTranslationJob(args, dependencies);

    expect(appendAnalyzedPageBlocks).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("completed");
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed", phase: "done" }),
    );
  });

  it("does not append a failed crop and preserves its exact limit guidance", async () => {
    const chapter = makeChapter();
    const controller = new AbortController();
    const appendAnalyzedPageBlocks = vi.fn();
    const dependencies = makeRegionDependencies({
      appendAnalyzedPageBlocks,
      runWholePagePipeline: vi.fn(async () => ({
        pages: [
          {
            ...firstPage(chapter),
            analysisStatus: "failed" as const,
            lastError: "작품 컨텍스트 예산 한도에서 응답이 잘렸습니다.",
          },
        ],
        warnings: [],
        failureGuidance: "increase-work-context-budget" as const,
      })),
    });

    await expect(
      runRegionTranslationJob(
        makeRegionArgs(controller, chapter),
        dependencies,
      ),
    ).rejects.toMatchObject({
      message: "작품 컨텍스트 예산 한도에서 응답이 잘렸습니다.",
      failureGuidance: "increase-work-context-budget",
    });
    expect(appendAnalyzedPageBlocks).not.toHaveBeenCalled();
  });
});

function makeAnalysisDependencies(
  overrides: Partial<Record<keyof AnalysisJobRunnerDependencies, unknown>> = {},
): AnalysisJobRunnerDependencies {
  const chapter = makeChapter();
  const fixture = {
    resolveWorkContextForChapter: vi.fn(async () => ({ workId: "work-1" })),
    resolvePreviousChapterStoryPages: vi.fn(async () => []),
    markChapterPagesRunning: vi.fn(async () => makeRunningChapter(chapter)),
    getRunPaths: vi.fn(async () => ({ runDir: "C:/run" })),
    runWholePagePipeline: vi.fn(),
    ...overrides,
  };
  return fixture as AnalysisJobRunnerDependencies;
}

function makeRegionDependencies(
  overrides: Partial<Record<keyof RegionJobRunnerDependencies, unknown>> = {},
): RegionJobRunnerDependencies {
  const chapter = makeChapter();
  const fixture = {
    openChapter: vi.fn(async () => chapter),
    getRunPaths: vi.fn(async () => ({ runDir: "C:/run" })),
    createRegionCropPage: vi.fn(async () => makeCropResult(firstPage(chapter))),
    resolveWorkContextForChapter: vi.fn(async () => ({ workId: "work-1" })),
    runWholePagePipeline: vi.fn(),
    appendAnalyzedPageBlocks: vi.fn(async () => chapter),
    ...overrides,
  };
  return fixture as RegionJobRunnerDependencies;
}

function makeAnalysisArgs(
  abortController: AbortController,
  chapter: ChapterSnapshot,
): Parameters<typeof runResolvedAnalysisJob>[0] {
  return {
    context: makeContext(),
    request: { chapterId: chapter.id, runMode: "all" },
    id: "job-1",
    abortController,
    emit: vi.fn(),
    resolved: { chapter, pages: chapter.pages },
    state: {
      resolved: { chapter, pages: chapter.pages },
      pageIds: [],
      runPaths: null,
    },
    registerResourceCleanup: vi.fn(),
  } as Parameters<typeof runResolvedAnalysisJob>[0];
}

function makeRegionArgs(
  abortController: AbortController,
  chapter: ChapterSnapshot,
): Parameters<typeof runRegionTranslationJob>[0] {
  return {
    context: makeContext(),
    request: {
      chapterId: chapter.id,
      pageId: firstPage(chapter).id,
      bbox: { x: 100, y: 100, w: 400, h: 400 },
    },
    id: "job-region",
    abortController,
    emit: vi.fn(),
    state: { chapter: null, runPaths: null },
    registerResourceCleanup: vi.fn(),
  } as Parameters<typeof runRegionTranslationJob>[0];
}

function makeContext() {
  return {
    jobs: new ActiveJobStore(),
    getMainWindow: () => null,
    decodeImage: vi.fn(),
  };
}

function makeCropResult(page: MangaPage) {
  return {
    cropPage: {
      ...page,
      id: `${page.id}-crop`,
      width: 400,
      height: 400,
      blocks: [],
    },
    cropRect: { x: 100, y: 100, w: 400, h: 400 },
  };
}

function makeRunningChapter(chapter: ChapterSnapshot): ChapterSnapshot {
  return {
    ...chapter,
    pages: chapter.pages.map((page) => ({
      ...page,
      analysisStatus: "running" as const,
      updatedAt: "2026-01-01T00:00:01.000Z",
    })),
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function firstPage(chapter: ChapterSnapshot): MangaPage {
  const page = chapter.pages[0];
  if (!page) throw new Error("Expected a chapter page.");
  return page;
}

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "001.png",
    imagePath: "C:/001.png",
    dataUrl: "",
    width: 1000,
    height: 1000,
    blocks: [],
    analysisStatus: "idle",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function makeChapter(): ChapterSnapshot {
  const pages = [makePage()];
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "1화",
    sourceKind: "images",
    status: "completed",
    pageOrder: pages.map((page) => page.id),
    pages,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}
