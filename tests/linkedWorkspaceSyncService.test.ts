import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChapterSnapshot,
  LibraryIndex,
  MangaPage,
} from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
import { DEFAULT_RASTER_EXPORT_SETTINGS } from "../src/shared/linkedWorkspaceTypes";

const boundary = vi.hoisted(() => ({
  chapter: null as ChapterSnapshot | null,
  library: null as LibraryIndex | null,
  openPath: vi.fn(async () => ""),
  createSession: vi.fn(),
  sessions: [] as Array<{
    renderPage: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
  }>,
  updatePagesAfterInpainting: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getVersion: () => "1.18.2" },
  shell: { openPath: boundary.openPath },
}));

import { LinkedWorkspaceSyncService } from "../src/main/linkedWorkspace/linkedWorkspaceSyncService";

const WORK_ID = "11111111-1111-4111-8111-111111111111";
const CHAPTER_ID = "22222222-2222-4222-8222-222222222222";
const PAGE_ID = "33333333-3333-4333-8333-333333333333";
const tempDirs: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"));
  boundary.chapter = makeChapter();
  boundary.library = makeLibrary();
  boundary.openPath.mockResolvedValue("");
  boundary.sessions.length = 0;
  boundary.createSession.mockImplementation(async () => {
    const session = makeRenderSession();
    boundary.sessions.push(session);
    return session;
  });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.clearAllMocks();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("LinkedWorkspaceSyncService", () => {
  it("uses Results/work/chapter as the default automatic-save location", async () => {
    vi.useRealTimers();
    const { dataRoot, root, service } = await makeConnectedService("managed");
    expect(root).toBe(join(dataRoot, "results", "테스트 작품", "1화"));
    expect(service.getStatus(CHAPTER_ID)).toMatchObject({
      destinationKind: "managed",
      rootPath: root,
    });
    expect(await readFile(join(root, "originals", "001.png"), "utf8")).toBe(
      "source",
    );
    await expect(
      service.viewResults({ chapterId: CHAPTER_ID }),
    ).resolves.toEqual({ status: "opened", syncedPages: 1 });
    expect(boundary.openPath).toHaveBeenCalledWith(join(root, "result"));
    await service.dispose();
  });

  it("does not mix a managed chapter with an unowned existing folder", async () => {
    vi.useRealTimers();
    const { dataRoot, root, service } = await makeConnectedService(
      "managed",
      async (preferredRoot) => {
        await mkdir(preferredRoot, { recursive: true });
        await writeFile(join(preferredRoot, "기존 파일.txt"), "keep");
      },
    );
    const preferredRoot = join(dataRoot, "results", "테스트 작품", "1화");
    expect(root).toBe(`${preferredRoot} (2)`);
    expect(await readFile(join(preferredRoot, "기존 파일.txt"), "utf8")).toBe(
      "keep",
    );
    await service.dispose();
  });

  it("resumes a managed folder whose recovery mirror owns the chapter", async () => {
    vi.useRealTimers();
    const { dataRoot, root, service } = await makeConnectedService(
      "managed",
      async (preferredRoot) => {
        await mkdir(preferredRoot, { recursive: true });
        await writeFile(
          join(preferredRoot, "manga-translator-1화.json"),
          JSON.stringify({ chapters: [{ id: CHAPTER_ID }] }),
        );
      },
    );
    expect(root).toBe(join(dataRoot, "results", "테스트 작품", "1화"));
    await service.dispose();
  });

  it("can restore a custom chapter destination to the managed default", async () => {
    vi.useRealTimers();
    const { dataRoot, service } = await makeConnectedService();
    const connectionId = service.getStatus(CHAPTER_ID).connectionId;
    if (!connectionId) throw new Error("missing automatic-save record");
    await expect(service.resetToManaged(connectionId)).resolves.toMatchObject({
      destinationKind: "managed",
      rootPath: join(dataRoot, "results", "테스트 작품", "1화"),
    });
    await service.dispose();
  });

  it("keeps existing results viewable while automatic saving is disabled", async () => {
    vi.useRealTimers();
    const { root, service } = await makeConnectedService();
    const connectionId = service.getStatus(CHAPTER_ID).connectionId;
    if (!connectionId) throw new Error("missing automatic-save record");
    await service.update({ connectionId, enabled: false });
    await expect(
      service.viewResults({ chapterId: CHAPTER_ID }),
    ).resolves.toEqual({ status: "opened", syncedPages: 0 });
    expect(boundary.openPath).toHaveBeenCalledWith(join(root, "result"));
    expect(boundary.createSession).not.toHaveBeenCalled();
    await service.dispose();
  });

  it("renders an import-time mirror-only page before opening results", async () => {
    vi.useRealTimers();
    const { root, service } = await makeConnectedService();

    await expect(
      service.viewResults({
        chapterId: CHAPTER_ID,
        currentPageId: PAGE_ID,
      }),
    ).resolves.toEqual({ status: "opened", syncedPages: 1 });
    expect(boundary.createSession).toHaveBeenCalledTimes(1);
    expect(await readFile(join(root, "result", "001.png"), "utf8")).toBe(
      "render-1",
    );
    await service.dispose();
  });

  it("keeps import-time metadata mirror-only and renders visual edits after 3 seconds", async () => {
    const { root, service } = await makeConnectedService();
    const page = requirePage();
    requireBlock(page).sourceText = "更新した原文";
    await service.notifyPagesSaved(CHAPTER_ID, [PAGE_ID]);

    await advanceAndDrain(service, 2_999);
    expect(boundary.createSession).not.toHaveBeenCalled();
    await advanceAndDrain(service, 1);
    expect(boundary.createSession).not.toHaveBeenCalled();
    expect(service.getStatus(CHAPTER_ID).state).toBe("idle");

    requireBlock(page).translatedText = "바뀐 번역";
    service.reportActivity({ type: "pulse" });
    await service.notifyPagesSaved(CHAPTER_ID, [PAGE_ID]);
    await advanceAndDrain(service, 2_999);
    expect(boundary.createSession).not.toHaveBeenCalled();
    await advanceAndDrain(service, 1);
    expect(boundary.createSession).toHaveBeenCalledTimes(1);
    expect(await readFile(join(root, "result", "001.png"), "utf8")).toBe(
      "render-1",
    );

    const latest = service.viewResults({
      chapterId: CHAPTER_ID,
      currentPageId: PAGE_ID,
    });
    await advanceAndDrain(service, 0);
    await expect(latest).resolves.toEqual({ status: "opened", syncedPages: 0 });
    expect(boundary.openPath).toHaveBeenCalledWith(join(root, "result"));
    await service.dispose();
  });

  it("republishes a missing result before opening its folder", async () => {
    vi.useRealTimers();
    const { root, service } = await makeConnectedService();
    await expect(
      service.viewResults({ chapterId: CHAPTER_ID }),
    ).resolves.toEqual({ status: "opened", syncedPages: 1 });

    await rm(join(root, "result", "001.png"));
    boundary.openPath.mockClear();
    await expect(
      service.viewResults({ chapterId: CHAPTER_ID }),
    ).resolves.toEqual({ status: "opened", syncedPages: 1 });
    expect(boundary.sessions[0]?.renderPage).toHaveBeenCalledTimes(2);
    expect(boundary.openPath).toHaveBeenCalledWith(join(root, "result"));
    await service.dispose();
  });

  it("does not start rendering during pointer interaction and resumes after idle", async () => {
    const { service } = await makeConnectedService();
    await advanceAndDrain(service, 3_000);
    const page = requirePage();
    requireBlock(page).translatedText = "visual edit";
    service.reportActivity({ type: "start", interaction: "pointer" });
    await service.notifyPagesSaved(CHAPTER_ID, [PAGE_ID]);
    await advanceAndDrain(service, 10_000);
    expect(boundary.createSession).not.toHaveBeenCalled();

    service.reportActivity({ type: "end", interaction: "pointer" });
    await advanceAndDrain(service, 2_999);
    expect(boundary.createSession).not.toHaveBeenCalled();
    await advanceAndDrain(service, 1);
    expect(boundary.createSession).toHaveBeenCalledTimes(1);
    await service.dispose();
  });

  it("discards a render interrupted by new activity and later publishes only fresh output", async () => {
    const { root, service } = await makeConnectedService();
    await advanceAndDrain(service, 3_000);
    const page = requirePage();
    requireBlock(page).translatedText = "first visual";
    await service.notifyPagesSaved(CHAPTER_ID, [PAGE_ID]);
    await advanceAndDrain(service, 3_000);
    expect(await readFile(join(root, "result", "001.png"), "utf8")).toBe(
      "render-1",
    );

    const staleRender = deferred<Buffer>();
    boundary.sessions[0]?.renderPage.mockImplementationOnce(
      () => staleRender.promise,
    );
    requireBlock(page).translatedText = "second visual";
    service.reportActivity({ type: "pulse" });
    await service.notifyPagesSaved(CHAPTER_ID, [PAGE_ID]);
    await vi.advanceTimersByTimeAsync(3_000);
    await flushAsyncWork();
    expect(boundary.createSession).toHaveBeenCalledTimes(1);

    service.reportActivity({ type: "pulse" });
    staleRender.resolve(Buffer.from("stale-output"));
    await flushAsyncWork();
    expect(await readFile(join(root, "result", "001.png"), "utf8")).toBe(
      "render-1",
    );
    await advanceAndDrain(service, 3_000);
    expect(await readFile(join(root, "result", "001.png"), "utf8")).toBe(
      "render-2",
    );
    await service.dispose();
  });
});

async function makeConnectedService(
  destination: "custom" | "managed" = "custom",
  prepareManagedRoot?: (rootPath: string) => Promise<void>,
): Promise<{
  dataRoot: string;
  root: string;
  service: LinkedWorkspaceSyncService;
}> {
  const dataRoot = await makeTempDir("data");
  const customRoot = await makeTempDir("output");
  const internalImagePath = join(dataRoot, "001.png");
  await writeFile(internalImagePath, "source");
  requirePage().imagePath = internalImagePath;
  const service = new LinkedWorkspaceSyncService({
    dataRoot,
    jobs: {
      get hasActive() {
        return false;
      },
    } as never,
    decodeImage: async () => null,
    getMainWindow: () => null,
    reportError: vi.fn(),
    dependencies: {
      listLibrary: async () => requireLibrary(),
      openChapter: async () => requireChapter(),
      updatePagesAfterInpainting: boundary.updatePagesAfterInpainting,
      createPageExportRenderSession: boundary.createSession,
    },
  });
  await service.initialize();
  const preferredManagedRoot = join(dataRoot, "results", "테스트 작품", "1화");
  await prepareManagedRoot?.(preferredManagedRoot);
  await service.connect({
    workId: WORK_ID,
    chapterId: CHAPTER_ID,
    ...(destination === "custom" ? { rootPath: customRoot } : {}),
    output: { ...DEFAULT_RASTER_EXPORT_SETTINGS, destinationMode: "fixed" },
    enqueueExistingPages: false,
  });
  const root = service.getStatus(CHAPTER_ID).rootPath ?? customRoot;
  return { dataRoot, root, service };
}

function makeRenderSession(render?: () => Promise<Buffer>) {
  const index = boundary.createSession.mock.calls.length;
  return {
    renderPage: vi.fn(render ?? (async () => Buffer.from(`render-${index}`))),
    close: vi.fn(),
    cancel: vi.fn(),
  };
}

async function advanceAndDrain(
  service: LinkedWorkspaceSyncService,
  milliseconds: number,
): Promise<void> {
  await vi.advanceTimersByTimeAsync(milliseconds);
  for (let index = 0; index < 6; index += 1) {
    const active = Reflect.get(service, "activeDrainPromise") as unknown;
    if (active instanceof Promise) await active;
    await vi.advanceTimersByTimeAsync(0);
    await flushAsyncWork();
    if (!(Reflect.get(service, "activeDrainPromise") as unknown)) {
      break;
    }
  }
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function requirePage(): MangaPage {
  const page = boundary.chapter?.pages[0];
  if (!page) throw new Error("missing test page");
  return page;
}

function requireChapter(): ChapterSnapshot {
  if (!boundary.chapter) throw new Error("missing test chapter");
  return boundary.chapter;
}

function requireLibrary(): LibraryIndex {
  if (!boundary.library) throw new Error("missing test library");
  return boundary.library;
}

function requireBlock(page: MangaPage): TranslationBlock {
  const block = page.blocks[0];
  if (!block) throw new Error("missing test block");
  return block;
}

function makeChapter(): ChapterSnapshot {
  const timestamp = "2026-08-24T00:00:00.000Z";
  const block = {
    id: "block-1",
    bbox: { x: 100, y: 100, w: 300, h: 200 },
    sourceText: "原文",
    translatedText: "번역",
    confidence: 0.9,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 24,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    outlineColor: "#ffffff",
    outlineWidthScale: 1,
    backgroundColor: "#ffffff",
    opacity: 1,
  } as TranslationBlock;
  return {
    id: CHAPTER_ID,
    workId: WORK_ID,
    title: "1화",
    sourceKind: "folder",
    status: "completed",
    pageOrder: [PAGE_ID],
    pages: [
      {
        id: PAGE_ID,
        name: "001.png",
        imagePath: "C:/internal/001.png",
        sourceFileName: "001.png",
        sourceRelativePath: "001.png",
        dataUrl: "",
        width: 1000,
        height: 1500,
        blocks: [block],
        blockOrder: [block.id],
        analysisStatus: "completed",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function makeLibrary(): LibraryIndex {
  const chapter = boundary.chapter ?? makeChapter();
  return {
    workOrder: [WORK_ID],
    works: [
      {
        id: WORK_ID,
        title: "테스트 작품",
        chapterOrder: [CHAPTER_ID],
        chapters: [
          {
            id: CHAPTER_ID,
            workId: WORK_ID,
            title: chapter.title,
            status: chapter.status,
            pageCount: 1,
            createdAt: chapter.createdAt,
            updatedAt: chapter.updatedAt,
          },
        ],
        createdAt: chapter.createdAt,
        updatedAt: chapter.updatedAt,
      },
    ],
  };
}

async function makeTempDir(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `mgt-linked-${label}-`));
  tempDirs.push(path);
  return path;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
