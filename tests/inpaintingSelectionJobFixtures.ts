import { vi } from "vitest";
import { ActiveJobStore } from "../src/main/jobs/activeJob";
import type {
  InpaintingJobContext,
  InpaintingJobRevisionStore,
} from "../src/main/jobs/inpaintingJobTypes";
import type { InpaintingJobRuntime } from "../src/main/jobs/inpaintingJobRuntime";
import type { InpaintingRevisionChange } from "../src/main/inpainting/inpaintingRevisionStore";
import type { InpaintingEngine } from "../src/main/inpainting/inpaintingEngine";
import type { AppPaths } from "../src/main/appPaths";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import { createPageProcessingTimingCollector } from "../src/main/pipeline/pageProcessingTiming";

export type InpaintingRuntimeHarness = {
  acquireEngine: ReturnType<
    typeof vi.fn<InpaintingJobRuntime["acquireEngine"]>
  >;
  inpaintPatternPage: ReturnType<
    typeof vi.fn<InpaintingJobRuntime["inpaintPatternPage"]>
  >;
  openPageTimingSession: ReturnType<
    typeof vi.fn<InpaintingJobRuntime["openPageTimingSession"]>
  >;
  releaseEngine: ReturnType<typeof vi.fn<() => void>>;
  runEngine: ReturnType<typeof vi.fn<InpaintingEngine["inpaint"]>>;
  runtime: InpaintingJobRuntime;
};

export function createInpaintingRuntimeHarness(
  chapters: Map<string, ChapterSnapshot>,
): InpaintingRuntimeHarness {
  const runEngine = vi.fn<InpaintingEngine["inpaint"]>(async () => undefined);
  const releaseEngine = vi.fn<() => void>();
  const acquireEngine = vi.fn<InpaintingJobRuntime["acquireEngine"]>(
    async () => ({
      engine: {
        model: "flux-klein",
        backend: "cuda-native",
        runtimePath: "C:\\runtime\\flux.exe",
        runRootDir: "C:\\runtime\\runs",
        inpaint: runEngine,
        dispose: async () => undefined,
      },
      release: releaseEngine,
    }),
  );
  const inpaintPatternPage = vi.fn<InpaintingJobRuntime["inpaintPatternPage"]>(
    async (page, options) => {
      await options?.inpaintingEngine?.inpaint(
        Buffer.alloc(4),
        1,
        1,
        new Uint8Array(1).fill(1),
        [{ x: 0, y: 0, w: 1, h: 1 }],
      );
      return {
        page: {
          ...page,
          inpaintedImagePath: `${page.imagePath}.inpainted.png`,
        },
        blocksErased: 1,
      };
    },
  );
  const settings = resolveDefaultAppSettings();
  settings.hardware = {
    ...settings.hardware,
    computeGpuIndex: 2,
  };
  settings.inpainting = { model: "flux-klein" };
  const savePages = vi.fn<InpaintingJobRuntime["savePages"]>(
    async (chapterId, pages) => {
      const chapter = requireChapter(chapters, chapterId);
      const updates = new Map(pages.map((page) => [page.id, page]));
      const saved: ChapterSnapshot = {
        ...chapter,
        pages: chapter.pages.map((page) => updates.get(page.id) ?? page),
      };
      chapters.set(chapterId, saved);
      return saved;
    },
  );
  const openPageTimingSession = vi.fn<
    InpaintingJobRuntime["openPageTimingSession"]
  >(async ({ jobId, pages, session }) =>
    createPageProcessingTimingCollector(
      jobId,
      pages.map((page) => page.id),
      { managed: true, sessionId: session.id },
    ),
  );
  const runtime: InpaintingJobRuntime = {
    acquireEngine,
    emitEvent: (jobs, mainWindow, event) => {
      if (jobs.current?.id !== event.id) {
        return;
      }
      jobs.updateLastEvent(event.id, event);
      mainWindow?.webContents.send("job:event", event);
    },
    getSettings: vi.fn(async () => settings),
    inpaintDrawnPage: vi.fn(async () => {
      throw new Error("drawn inpainting should not run");
    }),
    inpaintPatternPage,
    logError: vi.fn(),
    openPageTimingSession,
    openChapter: vi.fn(async (chapterId) =>
      requireChapter(chapters, chapterId),
    ),
    savePages,
  };
  return {
    acquireEngine,
    inpaintPatternPage,
    openPageTimingSession,
    releaseEngine,
    runEngine,
    runtime,
  };
}

export function requireChapter(
  chapters: ReadonlyMap<string, ChapterSnapshot>,
  chapterId: string,
): ChapterSnapshot {
  const chapter = chapters.get(chapterId);
  if (!chapter) {
    throw new Error(`missing chapter: ${chapterId}`);
  }
  return chapter;
}

export function makePage(id: string, name: string): MangaPage {
  return {
    id,
    name,
    imagePath: `C:\\library\\${name}`,
    dataUrl: "data:image/png;base64,AA==",
    width: 100,
    height: 100,
    blocks: [
      {
        id: `${id}-block`,
        type: "nonsolid",
        bbox: { x: 0, y: 0, w: 1, h: 1 },
        sourceText: "source",
        translatedText: "translated",
        confidence: 1,
        sourceDirection: "horizontal",
        renderDirection: "horizontal",
        fontSizePx: 16,
        lineHeight: 1.2,
        textAlign: "left",
        textColor: "#000000",
        backgroundColor: "#ffffff",
        opacity: 1,
      },
    ],
    analysisStatus: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

export function makeChapter(id: string, workId: string, pages: MangaPage[]) {
  return {
    id,
    workId,
    title: id,
    sourceKind: "images" as const,
    status: "completed" as const,
    pageOrder: pages.map((page) => page.id),
    pages,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

export const HISTORY_TRANSACTION_ID = "66666666-6666-4666-8666-666666666666";

export function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  if (!resolvePromise) {
    throw new Error("Failed to create deferred promise.");
  }
  return { promise, resolve: resolvePromise };
}

export function makeContext(
  send: (
    channel: string,
    event: import("../src/shared/jobTypes").JobEvent,
  ) => void,
  revisionChanges: InpaintingRevisionChange[] = [],
): InpaintingJobContext {
  const mainWindow = { webContents: { send } };
  return {
    appPaths: makeAppPaths(),
    jobs: new ActiveJobStore({ error: vi.fn(), info: vi.fn() }),
    getMainWindow: () => mainWindow,
    decodeImage: async () => {
      throw new Error("decode fallback should not run");
    },
    inpaintingRevisionStore: makeRevisionStore(revisionChanges),
  };
}

function makeAppPaths(): AppPaths {
  return {
    isPackaged: false,
    repoRoot: "C:\\repo",
    executableDir: "C:\\repo",
    resourcesDir: "C:\\repo\\resources",
    dataRoot: "C:\\repo",
    settingsPath: "C:\\repo\\settings.json",
    libraryDir: "C:\\repo\\library",
    fontsDir: "C:\\repo\\fonts",
    logsDir: "C:\\repo\\logs",
    logFile: "C:\\repo\\logs\\app.log",
    runtimeDir: "C:\\repo\\runtime",
    toolsDir: "C:\\repo\\tools",
    ocrRuntimeDir: "C:\\repo\\ocr",
    llamaRuntimeDir: "C:\\repo\\llama",
    llamaServerPath: "C:\\repo\\llama\\server.exe",
  };
}

function makeRevisionStore(
  changes: InpaintingRevisionChange[],
): InpaintingJobRevisionStore {
  return {
    beginTransaction: () => HISTORY_TRANSACTION_ID,
    addChange: (_transactionId: string, change: InpaintingRevisionChange) => {
      changes.push(change);
      return true;
    },
    removeChange: async (
      _transactionId: string,
      chapterId: string,
      pageId: string,
    ) => {
      const index = changes.findIndex(
        (change) => change.chapterId === chapterId && change.pageId === pageId,
      );
      if (index >= 0) {
        changes.splice(index, 1);
      }
    },
    discardIfEmpty: () => undefined,
    getReference: () =>
      changes.length > 0
        ? { transactionId: HISTORY_TRANSACTION_ID }
        : undefined,
    getRetainedArtifactPaths: () =>
      changes.flatMap((change) =>
        [change.beforePath, change.afterPath].filter((path): path is string =>
          Boolean(path),
        ),
      ),
  } satisfies InpaintingJobRevisionStore;
}
