import { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppActivityGate } from "../src/main/appActivityGate";
import { AppOperationRegistry } from "../src/main/appOperationRegistry";
import { ActiveJobStore } from "../src/main/jobs/activeJob";
import {
  handlePageImageExportError,
  runPageImageExportJob,
} from "../src/main/jobs/pageImageExportJobRunner";
import {
  preflightPageImageExport,
  resolvePageImageExportSelection,
} from "../src/main/jobs/pageImageExportSelection";
import type {
  PageImageExportDependencies,
  PageImageExportRuntimePort,
} from "../src/main/jobs/pageImageExportPorts";
import {
  registerPageImageExportIpc,
  type PageImageExportService,
} from "../src/main/ipc/pageImageExportIpc";
import type { IpcContext } from "../src/main/ipc/context";
import type {
  ChapterSnapshot,
  LibraryIndex,
  MangaPage,
} from "../src/shared/libraryTypes";
import type { JobEvent } from "../src/shared/jobTypes";

type IpcHandler = (
  event: {
    sender: { id: number };
    senderFrame?: { url: string };
  },
  ...args: unknown[]
) => Promise<unknown> | unknown;

const electronBoundary = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  showOpenDialog: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: class {
    readonly webContents = {
      id: 1,
      getURL: () => "http://127.0.0.1:5173/",
    };

    isDestroyed(): boolean {
      return false;
    }
  },
  dialog: { showOpenDialog: electronBoundary.showOpenDialog },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => {
      electronBoundary.handlers.set(channel, handler);
    },
  },
  nativeImage: {},
  shell: { openPath: vi.fn() },
}));

const tempDirs: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  electronBoundary.handlers.clear();
});

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("page image export behavior", () => {
  it("rejects a page changed after preflight before export starts", async () => {
    const chapter = makeChapter("chapter-1", "One", [
      makePage("page-1", "001.png"),
    ]);
    const harness = makeDependencies(makeLibrary([chapter]), [chapter]);
    const request = {
      workId: "work-1",
      selections: [{ chapterId: chapter.id, mode: "all" as const }],
    };
    const preflight = await preflightPageImageExport(
      request,
      harness.dependencies.repository,
    );

    const page = chapter.pages[0];
    if (!page) throw new Error("test page is missing");
    chapter.pages[0] = {
      ...page,
      imagePath: "source-page-1-updated.png",
    };

    await expect(
      resolvePageImageExportSelection(
        { ...request, expectedTargets: preflight.targets },
        harness.dependencies.repository,
      ),
    ).rejects.toThrow("사전 점검 후 변경");
  });

  it("checks only inpainting readiness for textless export", async () => {
    const translatedFailure = {
      ...makePage("page-1", "001.png", "inpainted-page-1.png"),
      analysisStatus: "failed" as const,
      blocks: [
        {
          id: "block-1",
          translatedText: "",
        } as MangaPage["blocks"][number],
      ],
    };
    const missingInpainting = makePage("page-2", "002.png");
    const chapter = makeChapter("chapter-1", "One", [
      translatedFailure,
      missingInpainting,
    ]);
    const harness = makeDependencies(makeLibrary([chapter]), [chapter]);

    const preflight = await preflightPageImageExport(
      {
        workId: "work-1",
        selections: [{ chapterId: chapter.id, mode: "all" }],
        omitText: true,
      },
      harness.dependencies.repository,
    );

    expect(preflight.issues.map((issue) => issue.code)).toEqual([
      "inpainted-image-missing",
    ]);
    expect(preflight.issues[0]).toMatchObject({ pageId: "page-2" });
  });

  it("rejects textless export before creating output when inpainting is missing", async () => {
    const outputParentDir = await makeTempDir();
    const chapter = makeChapter("chapter-1", "One", [
      makePage("page-1", "001.png"),
    ]);
    const harness = makeDependencies(makeLibrary([chapter]), [chapter]);

    await expect(
      runPageImageExportJob({
        context: makeContext(outputParentDir),
        request: {
          workId: "work-1",
          selections: [{ chapterId: chapter.id, mode: "all" }],
          omitText: true,
        },
        outputParentDir,
        id: "textless-export",
        abortController: new AbortController(),
        emit: vi.fn(),
        dependencies: harness.dependencies,
      }),
    ).rejects.toThrow(/인페인팅|inpaint/i);

    expect(await readdir(outputParentDir)).toEqual([]);
    expect(harness.createSession).not.toHaveBeenCalled();
    expect(harness.renderPage).not.toHaveBeenCalled();
  });

  it("removes translated blocks only from the textless export render snapshot", async () => {
    const outputParentDir = await makeTempDir();
    const page = {
      ...makePage("page-1", "001.png", "inpainted-page-1.png"),
      blocks: [
        {
          id: "block-1",
          translatedText: "합성하면 안 되는 번역문",
        } as MangaPage["blocks"][number],
      ],
    };
    const chapter = makeChapter("chapter-1", "One", [page]);
    const harness = makeDependencies(makeLibrary([chapter]), [chapter]);

    await runPageImageExportJob({
      context: makeContext(outputParentDir),
      request: {
        workId: "work-1",
        selections: [{ chapterId: chapter.id, mode: "all" }],
        omitText: true,
      },
      outputParentDir,
      id: "textless-export",
      abortController: new AbortController(),
      emit: vi.fn(),
      dependencies: harness.dependencies,
    });

    expect(harness.renderPage).toHaveBeenCalledOnce();
    expect(harness.renderPage.mock.calls[0]?.[0]).toMatchObject({
      id: page.id,
      inpaintedImagePath: "inpainted-page-1.png",
      blocks: [],
    });
    expect(page.blocks).toHaveLength(1);
  });

  it("uses library order and preserves original chapter/page indexes", async () => {
    const outputParentDir = await makeTempDir();
    const chapter1 = makeChapter("chapter-1", "Chapter: One", [
      makePage("page-1", "001.jpg"),
      makePage("page-2", "002.jpg"),
      makePage("page-3", "003.webp", "edited-page-3.png"),
    ]);
    const chapter2 = makeChapter("chapter-2", "Second", [
      makePage("page-4", "a.jpeg"),
    ]);
    const harness = makeDependencies(
      makeLibrary([chapter1, chapter2], "My: Work"),
      [chapter1, chapter2],
    );
    const events: JobEvent[] = [];

    const result = await runPageImageExportJob({
      context: makeContext(outputParentDir),
      request: {
        workId: "work-1",
        selections: [
          { chapterId: chapter2.id, mode: "all" },
          {
            chapterId: chapter1.id,
            mode: "page-set",
            pageIds: ["page-3", "page-1"],
          },
        ],
      },
      outputParentDir,
      id: "export-job",
      abortController: new AbortController(),
      emit: (event) => events.push(event),
      dependencies: harness.dependencies,
    });

    expect(result).toEqual({
      status: "completed",
      outputDir: join(outputParentDir, "My_ Work-2026-01-02T03-04-05-000Z"),
      pageCount: 3,
    });
    expect(await readdir(result.outputDir)).toEqual([
      "001-Chapter_ One",
      "002-Second",
    ]);
    expect(await readdir(join(result.outputDir, "001-Chapter_ One"))).toEqual([
      "001-001.png",
      "003-003.png",
    ]);
    expect(await readdir(join(result.outputDir, "002-Second"))).toEqual([
      "001-a.png",
    ]);
    expect(harness.renderPage.mock.calls.map(([page]) => page.id)).toEqual([
      "page-1",
      "page-3",
      "page-4",
    ]);
    expect(harness.createSession).toHaveBeenCalledOnce();
    expect(harness.closeSession).toHaveBeenCalledOnce();
    expect(harness.openDirectory).toHaveBeenCalledWith(result.outputDir);
    expect(events.at(0)).toMatchObject({
      status: "starting",
      progressCurrent: 0,
      progressTotal: 3,
    });
    expect(events.at(-1)).toMatchObject({
      status: "completed",
      progressCurrent: 3,
      progressTotal: 3,
    });
  });

  it("rejects duplicate pages before creating output", async () => {
    const outputParentDir = await makeTempDir();
    const chapter = makeChapter("chapter-1", "One", [
      makePage("page-1", "001.png"),
    ]);
    const harness = makeDependencies(makeLibrary([chapter]), [chapter]);

    await expect(
      runPageImageExportJob({
        context: makeContext(outputParentDir),
        request: {
          workId: "work-1",
          selections: [
            {
              chapterId: chapter.id,
              mode: "page-set",
              pageIds: ["page-1", "page-1"],
            },
          ],
        },
        outputParentDir,
        id: "export-job",
        abortController: new AbortController(),
        emit: vi.fn(),
        dependencies: harness.dependencies,
      }),
    ).rejects.toThrow("같은 페이지");
    expect(await readdir(outputParentDir)).toEqual([]);
    expect(harness.renderPage).not.toHaveBeenCalled();
  });

  it("cancels after rendering and removes the partial output", async () => {
    const outputParentDir = await makeTempDir();
    const chapter = makeChapter("chapter-1", "One", [
      makePage("page-1", "001.png"),
    ]);
    const abortController = new AbortController();
    const events: JobEvent[] = [];
    const request = {
      workId: "work-1",
      selections: [{ chapterId: chapter.id, mode: "all" as const }],
    };
    const harness = makeDependencies(makeLibrary([chapter]), [chapter], {
      renderPage: async () => {
        abortController.abort();
        return Buffer.from("rendered");
      },
    });

    await expect(
      runPageImageExportJob({
        context: makeContext(outputParentDir),
        request,
        outputParentDir,
        id: "cancelled-export",
        abortController,
        emit: (event) => events.push(event),
        dependencies: harness.dependencies,
      }).catch((error: unknown) =>
        handlePageImageExportError({
          abortController,
          emit: (event) => events.push(event),
          error,
          id: "cancelled-export",
          request,
          dependencies: harness.dependencies,
        }),
      ),
    ).resolves.toEqual({ status: "cancelled" });

    expect(await readdir(outputParentDir)).toEqual([]);
    expect(harness.openDirectory).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      status: "cancelled",
      progressCurrent: 0,
      progressTotal: 1,
      pageTotal: 1,
    });
    expect(events.some((event) => event.status === "completed")).toBe(false);
  });

  it("keeps successful output and reports a folder-open failure", async () => {
    const outputParentDir = await makeTempDir();
    const chapter = makeChapter("chapter-1", "One", [
      makePage("page-1", "001.png"),
    ]);
    const harness = makeDependencies(makeLibrary([chapter]), [chapter], {
      openDirectory: async () => {
        throw new Error("shell unavailable");
      },
    });

    const result = await runPageImageExportJob({
      context: makeContext(outputParentDir),
      request: {
        workId: "work-1",
        selections: [{ chapterId: chapter.id, mode: "all" }],
      },
      outputParentDir,
      id: "export-job",
      abortController: new AbortController(),
      emit: vi.fn(),
      dependencies: harness.dependencies,
    });

    expect(result.openError).toBe("shell unavailable");
    expect(await readdir(result.outputDir)).toEqual(["001-One"]);
  });

  it("removes partial output and emits failure when rendering fails", async () => {
    const outputParentDir = await makeTempDir();
    const chapter = makeChapter("chapter-1", "One", [
      makePage("page-1", "001.png"),
    ]);
    const request = {
      workId: "work-1",
      selections: [{ chapterId: chapter.id, mode: "all" as const }],
    };
    const harness = makeDependencies(makeLibrary([chapter]), [chapter], {
      renderPage: async () => {
        throw new Error("renderer crashed");
      },
    });
    const events: JobEvent[] = [];
    const abortController = new AbortController();

    await expect(
      runPageImageExportJob({
        context: makeContext(outputParentDir),
        request,
        outputParentDir,
        id: "failed-export",
        abortController,
        emit: (event) => events.push(event),
        dependencies: harness.dependencies,
      }).catch((error: unknown) =>
        handlePageImageExportError({
          abortController,
          emit: (event) => events.push(event),
          error,
          id: "failed-export",
          request,
          dependencies: harness.dependencies,
        }),
      ),
    ).rejects.toThrow("renderer crashed");

    expect(await readdir(outputParentDir)).toEqual([]);
    expect(harness.logError).toHaveBeenCalledWith(
      "Page image export failed",
      expect.objectContaining({ jobId: "failed-export" }),
    );
    expect(events.at(-1)).toMatchObject({
      status: "failed",
      detail: "renderer crashed",
    });
  });

  it("rejects an oversized renderer PNG before writing and removes partial output", async () => {
    const outputParentDir = await makeTempDir();
    const chapter = makeChapter("chapter-1", "One", [
      makePage("page-1", "001.png"),
    ]);
    const request = {
      workId: "work-1",
      selections: [{ chapterId: chapter.id, mode: "all" as const }],
    };
    const harness = makeDependencies(makeLibrary([chapter]), [chapter], {
      renderPage: async () => fakePng(5000, 12000),
    });
    const events: JobEvent[] = [];
    const abortController = new AbortController();

    await expect(
      runPageImageExportJob({
        context: makeContext(outputParentDir),
        request,
        outputParentDir,
        id: "oversized-export",
        abortController,
        emit: (event) => events.push(event),
        dependencies: harness.dependencies,
      }).catch((error: unknown) =>
        handlePageImageExportError({
          abortController,
          emit: (event) => events.push(event),
          error,
          id: "oversized-export",
          request,
          dependencies: harness.dependencies,
        }),
      ),
    ).rejects.toThrow(/안전 해상도|raster safety/i);

    expect(await readdir(outputParentDir)).toEqual([]);
    expect(harness.writePng).not.toHaveBeenCalled();
    expect(harness.openDirectory).not.toHaveBeenCalled();
    expect(events.some((event) => event.status === "completed")).toBe(false);
    expect(events.at(-1)).toMatchObject({ status: "failed" });
  });

  it("surfaces cleanup failure and records both error paths", async () => {
    const outputParentDir = await makeTempDir();
    const chapter = makeChapter("chapter-1", "One", [
      makePage("page-1", "001.png"),
    ]);
    const harness = makeDependencies(makeLibrary([chapter]), [chapter], {
      renderPage: async () => {
        throw new Error("render failed");
      },
      removeDirectory: async () => {
        throw new Error("cleanup failed");
      },
    });

    await expect(
      runPageImageExportJob({
        context: makeContext(outputParentDir),
        request: {
          workId: "work-1",
          selections: [{ chapterId: chapter.id, mode: "all" }],
        },
        outputParentDir,
        id: "export-job",
        abortController: new AbortController(),
        emit: vi.fn(),
        dependencies: harness.dependencies,
      }),
    ).rejects.toThrow("정리에 실패");
    expect(harness.logError).toHaveBeenCalledWith(
      "Page image export cleanup failed",
      expect.objectContaining({
        outputDir: join(outputParentDir, "Work-2026-01-02T03-04-05-000Z"),
      }),
    );
  });

  it.each([
    {
      name: "a duplicate chapter selection",
      selections: [
        { chapterId: "chapter-1", mode: "all" as const },
        { chapterId: "chapter-1", mode: "all" as const },
      ],
      errorText: "같은 화",
    },
    {
      name: "a chapter outside the work",
      selections: [{ chapterId: "chapter-other", mode: "all" as const }],
      errorText: "선택한 화",
    },
    {
      name: "a page outside the selected chapter",
      selections: [
        {
          chapterId: "chapter-1",
          mode: "page-set" as const,
          pageIds: ["page-other"],
        },
      ],
      errorText: "선택한 페이지",
    },
  ])("rejects $name", async ({ selections, errorText }) => {
    const outputParentDir = await makeTempDir();
    const chapter = makeChapter("chapter-1", "One", [
      makePage("page-1", "001.png"),
    ]);
    const harness = makeDependencies(makeLibrary([chapter]), [chapter]);

    await expect(
      runPageImageExportJob({
        context: makeContext(outputParentDir),
        request: { workId: "work-1", selections },
        outputParentDir,
        id: "export-job",
        abortController: new AbortController(),
        emit: vi.fn(),
        dependencies: harness.dependencies,
      }),
    ).rejects.toThrow(errorText);
    expect(await readdir(outputParentDir)).toEqual([]);
  });
});

describe("page image export IPC boundary", () => {
  it("stays idle when folder selection is cancelled", async () => {
    electronBoundary.showOpenDialog.mockResolvedValue({
      canceled: true,
      filePaths: [],
    });
    const service = makeService();
    registerPageImageExportIpc(makeContext("C:\\data"), service);
    const handler = electronBoundary.handlers.get("page-images:export");

    await expect(handler?.(trustedEvent(), validRequest())).resolves.toBeNull();
    expect(service.assertIdle).toHaveBeenCalledTimes(1);
    expect(service.exportImages).not.toHaveBeenCalled();
  });

  it("passes the user-selected directory to the export service", async () => {
    electronBoundary.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["D:\\exports"],
    });
    const service = makeService();
    service.exportImages.mockResolvedValue({
      status: "completed",
      outputDir: "D:\\exports\\result",
      pageCount: 1,
    });
    const context = makeContext("C:\\data");
    registerPageImageExportIpc(context, service);
    const handler = electronBoundary.handlers.get("page-images:export");
    const request = validRequest();

    await expect(handler?.(trustedEvent(), request)).resolves.toEqual({
      status: "completed",
      outputDir: "D:\\exports\\result",
      pageCount: 1,
    });
    expect(service.exportImages).toHaveBeenCalledWith(
      context,
      request,
      "D:\\exports",
    );
  });

  it("returns an explicit cancellation result from an active export", async () => {
    electronBoundary.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["D:\\exports"],
    });
    const service = makeService();
    service.exportImages.mockResolvedValue({ status: "cancelled" });
    registerPageImageExportIpc(makeContext("C:\\data"), service);
    const handler = electronBoundary.handlers.get("page-images:export");

    await expect(handler?.(trustedEvent(), validRequest())).resolves.toEqual({
      status: "cancelled",
    });
  });

  it("reopens at the last successfully completed export directory", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "page-export-dialog-"));
    tempDirs.push(dataRoot);
    const exportDirectory = join(dataRoot, "exports");
    await mkdir(exportDirectory);
    electronBoundary.showOpenDialog
      .mockResolvedValueOnce({
        canceled: false,
        filePaths: [exportDirectory],
      })
      .mockResolvedValueOnce({ canceled: true, filePaths: [] });
    const service = makeService();
    service.exportImages.mockResolvedValue({
      status: "completed",
      outputDir: join(exportDirectory, "result"),
      pageCount: 1,
    });
    registerPageImageExportIpc(makeContext(dataRoot), service);
    const handler = electronBoundary.handlers.get("page-images:export");

    await handler?.(trustedEvent(), validRequest());
    await handler?.(trustedEvent(), validRequest());

    expect(electronBoundary.showOpenDialog.mock.calls[1]?.[1]).toMatchObject({
      defaultPath: exportDirectory,
    });
  });

  it("does not remember an export directory when the active export is cancelled", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "page-export-cancelled-"));
    tempDirs.push(dataRoot);
    const exportDirectory = join(dataRoot, "exports");
    await mkdir(exportDirectory);
    electronBoundary.showOpenDialog
      .mockResolvedValueOnce({
        canceled: false,
        filePaths: [exportDirectory],
      })
      .mockResolvedValueOnce({ canceled: true, filePaths: [] });
    const service = makeService();
    service.exportImages.mockResolvedValue({ status: "cancelled" });
    registerPageImageExportIpc(makeContext(dataRoot), service);
    const handler = electronBoundary.handlers.get("page-images:export");

    await handler?.(trustedEvent(), validRequest());
    await handler?.(trustedEvent(), validRequest());

    expect(electronBoundary.showOpenDialog.mock.calls[1]?.[1]).toMatchObject({
      defaultPath: undefined,
    });
  });
});

type DependencyOverrides = {
  renderPage?: (page: MangaPage) => Promise<Buffer>;
  openDirectory?: PageImageExportRuntimePort["openDirectory"];
  removeDirectory?: PageImageExportRuntimePort["removeDirectory"];
};

function makeDependencies(
  library: LibraryIndex,
  chapters: ChapterSnapshot[],
  overrides: DependencyOverrides = {},
) {
  const chapterById = new Map(chapters.map((chapter) => [chapter.id, chapter]));
  const renderPage = vi.fn(
    overrides.renderPage ?? (async (_page: MangaPage) => fakePng(10, 10)),
  );
  const closeSession = vi.fn();
  const createSession = vi.fn(async () => ({
    renderPage,
    close: closeSession,
  }));
  const openDirectory = vi.fn(overrides.openDirectory ?? (async () => ""));
  const logError = vi.fn<PageImageExportDependencies["logger"]["error"]>();
  const writePng = vi.fn(async (path: string, content: Buffer) => {
    await writeFile(path, content);
  });
  const runtime: PageImageExportRuntimePort = {
    async createDirectory(path, recursive = false) {
      await mkdir(path, recursive ? { recursive: true } : undefined);
    },
    removeDirectory:
      overrides.removeDirectory ??
      (async (path) => {
        await rm(path, { recursive: true, force: true });
      }),
    writePng,
    openDirectory,
    createTimestamp: () => "2026-01-02T03-04-05-000Z",
  };
  const dependencies: PageImageExportDependencies = {
    repository: {
      listLibrary: async () => library,
      openChapter: async (chapterId) => {
        const chapter = chapterById.get(chapterId);
        if (!chapter) {
          throw new Error(`missing chapter: ${chapterId}`);
        }
        return chapter;
      },
    },
    renderer: { createSession },
    runtime,
    logger: { error: logError },
  };
  return {
    closeSession,
    createSession,
    dependencies,
    logError,
    openDirectory,
    renderPage,
    writePng,
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "page-image-export-"));
  tempDirs.push(dir);
  return dir;
}

function makeLibrary(
  chapters: ChapterSnapshot[],
  title = "Work",
): LibraryIndex {
  return {
    workOrder: ["work-1"],
    works: [
      {
        id: "work-1",
        title,
        chapterOrder: chapters.map((chapter) => chapter.id),
        chapters: chapters.map((chapter) => ({
          id: chapter.id,
          workId: "work-1",
          title: chapter.title,
          status: chapter.status,
          pageCount: chapter.pages.length,
          createdAt: chapter.createdAt,
          updatedAt: chapter.updatedAt,
        })),
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
}

function makeChapter(
  id: string,
  title: string,
  pages: MangaPage[],
): ChapterSnapshot {
  return {
    id,
    workId: "work-1",
    title,
    sourceKind: "images",
    status: "completed",
    pageOrder: pages.map((page) => page.id),
    pages,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function fakePng(width: number, height: number): Buffer {
  const png = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png, 0);
  png.writeUInt32BE(13, 8);
  Buffer.from("IHDR", "ascii").copy(png, 12);
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

function makePage(
  id: string,
  name: string,
  inpaintedImagePath?: string,
): MangaPage {
  return {
    id,
    name,
    imagePath: `source-${id}.png`,
    ...(inpaintedImagePath ? { inpaintedImagePath } : {}),
    dataUrl: "",
    width: 10,
    height: 10,
    blocks: [],
    analysisStatus: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeContext(dataRoot: string): IpcContext {
  const mainWindow = new BrowserWindow();
  const activityGate = new AppActivityGate();
  return {
    appPaths: {
      isPackaged: false,
      repoRoot: dataRoot,
      executableDir: dataRoot,
      resourcesDir: dataRoot,
      dataRoot,
      settingsPath: join(dataRoot, "settings.json"),
      libraryDir: join(dataRoot, "library"),
      fontsDir: join(dataRoot, "fonts"),
      logsDir: join(dataRoot, "logs"),
      logFile: join(dataRoot, "logs", "app.log"),
      runtimeDir: join(dataRoot, "runtime"),
      toolsDir: join(dataRoot, "tools"),
      ocrRuntimeDir: join(dataRoot, "ocr-runtime"),
      llamaRuntimeDir: join(dataRoot, "tools"),
      llamaServerPath: join(dataRoot, "tools", "llama-server"),
    },
    jobs: new ActiveJobStore(undefined, activityGate),
    operations: new AppOperationRegistry(activityGate),
    getMainWindow: () => mainWindow,
    panelWindows: {
      close: () => false,
      closeAll: () => undefined,
      getLastState: () => null,
      getOpenPanelIds: () => [],
      isPanelSender: () => false,
      open: () => false,
      publishState: () => undefined,
    },
    loadSimplePageRuntime: () => {
      throw new Error("not used by page image export");
    },
    decodeImage: async () => null,
  };
}

function makeService() {
  return {
    assertIdle: vi.fn<PageImageExportService["assertIdle"]>(),
    exportImages: vi.fn<PageImageExportService["exportImages"]>(),
  };
}

function validRequest() {
  return {
    workId: "11111111-1111-4111-8111-111111111111",
    selections: [
      {
        chapterId: "22222222-2222-4222-8222-222222222222",
        mode: "all" as const,
      },
    ],
  };
}

function trustedEvent(): Parameters<IpcHandler>[0] {
  return {
    sender: { id: 1 },
    senderFrame: { url: "http://127.0.0.1:5173/" },
  };
}
