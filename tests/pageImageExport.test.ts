import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const mocks = vi.hoisted(() => ({
  assertNoActiveJob: vi.fn(),
  exportPageImages: vi.fn(),
  handle: vi.fn(),
  handlers: new Map<string, IpcHandler>(),
  listLibrary: vi.fn(),
  openChapter: vi.fn(),
  openPath: vi.fn(),
  renderPage: vi.fn(),
  showOpenDialog: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: class {},
  dialog: { showOpenDialog: mocks.showOpenDialog },
  ipcMain: {
    handle: mocks.handle.mockImplementation(
      (channel: string, handler: IpcHandler) => {
        mocks.handlers.set(channel, handler);
      },
    ),
  },
  nativeImage: {},
  shell: { openPath: mocks.openPath },
}));

vi.mock("../src/main/library", () => ({
  listLibrary: mocks.listLibrary,
  openChapter: mocks.openChapter,
}));

vi.mock("../src/main/pageExport", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/main/pageExport")>();
  return {
    ...actual,
    renderPageWithTranslationBlocksForExport: mocks.renderPage,
  };
});

vi.mock("../src/main/jobs/pageImageExportJobs", () => ({
  assertNoActivePageImageExportJob: mocks.assertNoActiveJob,
  exportPageImages: mocks.exportPageImages,
}));

vi.mock("../src/main/logger", () => ({
  logError: vi.fn(),
}));

import { registerPageImageExportIpc } from "../src/main/ipc/pageImageExportIpc";
import {
  handlePageImageExportError,
  runPageImageExportJob,
} from "../src/main/jobs/pageImageExportJobRunner";

const tempDirs: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  mocks.handle.mockImplementation((channel: string, handler: IpcHandler) => {
    mocks.handlers.set(channel, handler);
  });
  mocks.openPath.mockResolvedValue("");
  mocks.renderPage.mockImplementation(async (page: MangaPage) =>
    Buffer.from(page.id),
  );
});

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("page image export", () => {
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
    mocks.listLibrary.mockResolvedValue(
      makeLibrary([chapter1, chapter2], "My: Work"),
    );
    mocks.openChapter.mockImplementation(async (chapterId: string) =>
      chapterId === chapter1.id ? chapter1 : chapter2,
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
    });

    expect(result.pageCount).toBe(3);
    expect(result.outputDir).toMatch(/My_ Work-/);
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
    expect(
      await readFile(
        join(result.outputDir, "001-Chapter_ One", "003-003.png"),
        "utf8",
      ),
    ).toBe("page-3");
    expect(mocks.renderPage.mock.calls.map(([page]) => page.id)).toEqual([
      "page-1",
      "page-3",
      "page-4",
    ]);
    expect(mocks.openPath).toHaveBeenCalledWith(result.outputDir);
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
    mocks.listLibrary.mockResolvedValue(makeLibrary([chapter]));
    mocks.openChapter.mockResolvedValue(chapter);

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
      }),
    ).rejects.toThrow("같은 페이지");
    expect(await readdir(outputParentDir)).toEqual([]);
    expect(mocks.renderPage).not.toHaveBeenCalled();
  });

  it("cancels after the final page render and removes partial output", async () => {
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
    mocks.listLibrary.mockResolvedValue(makeLibrary([chapter]));
    mocks.openChapter.mockResolvedValue(chapter);
    mocks.renderPage.mockImplementationOnce(async () => {
      abortController.abort();
      return Buffer.from("rendered");
    });

    await expect(
      runPageImageExportJob({
        context: makeContext(outputParentDir),
        request,
        outputParentDir,
        id: "cancelled-export",
        abortController,
        emit: (event) => events.push(event),
      }).catch((error: unknown) =>
        handlePageImageExportError({
          abortController,
          emit: (event) => events.push(event),
          error,
          id: "cancelled-export",
          request,
        }),
      ),
    ).rejects.toThrow("취소");

    expect(await readdir(outputParentDir)).toEqual([]);
    expect(mocks.openPath).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      status: "cancelled",
      progressCurrent: 0,
      progressTotal: 1,
      pageTotal: 1,
    });
    expect(events.some((event) => event.status === "completed")).toBe(false);
  });

  it("keeps a successful output when opening the folder throws", async () => {
    const outputParentDir = await makeTempDir();
    const chapter = makeChapter("chapter-1", "One", [
      makePage("page-1", "001.png"),
    ]);
    mocks.listLibrary.mockResolvedValue(makeLibrary([chapter]));
    mocks.openChapter.mockResolvedValue(chapter);
    mocks.openPath.mockRejectedValueOnce(new Error("shell unavailable"));

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
    });

    expect(result.openError).toBe("shell unavailable");
    expect(await readdir(result.outputDir)).toEqual(["001-One"]);
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
    mocks.listLibrary.mockResolvedValue(makeLibrary([chapter]));
    mocks.openChapter.mockResolvedValue(chapter);

    await expect(
      runPageImageExportJob({
        context: makeContext(outputParentDir),
        request: { workId: "work-1", selections },
        outputParentDir,
        id: "export-job",
        abortController: new AbortController(),
        emit: vi.fn(),
      }),
    ).rejects.toThrow(errorText);
    expect(await readdir(outputParentDir)).toEqual([]);
  });

  it("keeps the export modal flow idle when folder selection is cancelled", async () => {
    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    registerPageImageExportIpc(makeContext("C:\\data"));
    const handler = mocks.handlers.get("page-images:export");
    expect(handler).toBeDefined();

    const result = await handler?.(trustedEvent(), {
      workId: "11111111-1111-4111-8111-111111111111",
      selections: [
        {
          chapterId: "22222222-2222-4222-8222-222222222222",
          mode: "all",
        },
      ],
    });

    expect(result).toBeNull();
    expect(mocks.assertNoActiveJob).toHaveBeenCalledTimes(1);
    expect(mocks.exportPageImages).not.toHaveBeenCalled();
  });

  it("starts every accepted export with the directory selected by the user", async () => {
    const request = {
      workId: "11111111-1111-4111-8111-111111111111",
      selections: [
        {
          chapterId: "22222222-2222-4222-8222-222222222222",
          mode: "all" as const,
        },
      ],
    };
    const expected = { outputDir: "D:\\exports\\result", pageCount: 1 };
    mocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["D:\\exports"],
    });
    mocks.exportPageImages.mockResolvedValue(expected);
    const context = makeContext("C:\\data");
    registerPageImageExportIpc(context);
    const handler = mocks.handlers.get("page-images:export");

    await expect(handler?.(trustedEvent(), request)).resolves.toEqual(expected);
    expect(mocks.showOpenDialog).toHaveBeenCalledTimes(1);
    expect(mocks.exportPageImages).toHaveBeenCalledWith(
      context,
      request,
      "D:\\exports",
    );
  });
});

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
    jobs: { hasActive: false } as IpcContext["jobs"],
    getMainWindow: () =>
      ({
        isDestroyed: () => false,
        webContents: { id: 1, getURL: () => "http://127.0.0.1:5173/" },
      }) as ReturnType<IpcContext["getMainWindow"]>,
    panelWindows: {} as IpcContext["panelWindows"],
    loadSimplePageRuntime: vi.fn(),
    decodeImage: vi.fn(),
  };
}

function trustedEvent(): Parameters<IpcHandler>[0] {
  return {
    sender: { id: 1 },
    senderFrame: { url: "http://127.0.0.1:5173/" },
  };
}
