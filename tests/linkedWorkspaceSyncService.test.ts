import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
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

import {
  LinkedWorkspaceSyncService,
  MAX_LINKED_WORKSPACE_SYNC_CONCURRENCY,
} from "../src/main/linkedWorkspace/linkedWorkspaceSyncService";

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
    expect(boundary.sessions[0]?.renderPage).toHaveBeenCalledWith(
      expect.objectContaining({ id: PAGE_ID }),
      { format: "png", resolutionMode: "original" },
    );
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

  it("automatically saves at most four rendered pages concurrently", async () => {
    vi.useRealTimers();
    boundary.chapter = makeChapter(8);
    boundary.library = makeLibrary();
    const pages = requireChapter().pages;
    const gates = new Map(
      pages.map((page) => [page.id, deferred<void>()] as const),
    );
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;
    boundary.createSession.mockImplementation(async () => {
      const session = makeRenderSession(async (page) => {
        const gate = gates.get(page.id);
        if (!gate) throw new Error(`missing render gate: ${page.id}`);
        started.push(page.id);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gate.promise;
        active -= 1;
        return Buffer.from(`render-${page.name}`);
      });
      boundary.sessions.push(session);
      return session;
    });
    const { root, service } = await makeConnectedService();

    const viewing = service.viewResults({ chapterId: CHAPTER_ID });
    await vi.waitFor(() => {
      expect(started).toHaveLength(MAX_LINKED_WORKSPACE_SYNC_CONCURRENCY);
    });
    expect(active).toBe(MAX_LINKED_WORKSPACE_SYNC_CONCURRENCY);
    expect(maxActive).toBe(MAX_LINKED_WORKSPACE_SYNC_CONCURRENCY);
    expect(service.getStatus(CHAPTER_ID).state).toBe("syncing");

    gates.get(started[0] ?? "")?.resolve(undefined);
    await vi.waitFor(() => {
      expect(started).toHaveLength(MAX_LINKED_WORKSPACE_SYNC_CONCURRENCY + 1);
    });
    expect(maxActive).toBe(MAX_LINKED_WORKSPACE_SYNC_CONCURRENCY);

    for (const gate of gates.values()) gate.resolve(undefined);
    await expect(viewing).resolves.toEqual({
      status: "opened",
      syncedPages: pages.length,
    });
    expect(maxActive).toBe(MAX_LINKED_WORKSPACE_SYNC_CONCURRENCY);
    expect(boundary.createSession).toHaveBeenCalledTimes(
      MAX_LINKED_WORKSPACE_SYNC_CONCURRENCY,
    );
    await expect(
      Promise.all(
        pages.map(async (page) =>
          readFile(join(root, "result", page.name), "utf8"),
        ),
      ),
    ).resolves.toEqual(pages.map((page) => `render-${page.name}`));

    const mirrorName = (await readdir(root)).find(
      (name) => name.startsWith("manga-translator-") && name.endsWith(".json"),
    );
    if (!mirrorName) throw new Error("missing automatic-save mirror");
    const mirror = JSON.parse(
      await readFile(join(root, mirrorName), "utf8"),
    ) as {
      chapters: Array<{
        pages: Array<{ id: string; result?: { path: string } }>;
      }>;
    };
    expect(mirror.chapters[0]?.pages).toHaveLength(pages.length);
    expect(
      mirror.chapters[0]?.pages.every((page) => Boolean(page.result?.path)),
    ).toBe(true);
    await service.dispose();
  });

  it("keeps other automatic saves moving when one parallel render must retry", async () => {
    boundary.chapter = makeChapter(5);
    boundary.library = makeLibrary();
    let firstPageAttempts = 0;
    boundary.createSession.mockImplementation(async () => {
      const session = makeRenderSession(async (page) => {
        if (page.id === PAGE_ID && firstPageAttempts === 0) {
          firstPageAttempts += 1;
          throw new Error("temporary render failure");
        }
        return Buffer.from(`render-${page.name}`);
      });
      boundary.sessions.push(session);
      return session;
    });
    const { root, service } = await makeConnectedService();
    for (const page of requireChapter().pages) {
      requireBlock(page).translatedText = `edited-${page.name}`;
    }

    await service.notifyPagesSaved(
      CHAPTER_ID,
      requireChapter().pages.map((page) => page.id),
      { immediate: true, priority: 60 },
    );
    await advanceAndDrain(service, 3_000);
    expect(service.getStatus(CHAPTER_ID)).toMatchObject({
      state: "pending",
      pendingCount: 1,
    });
    expect(
      boundary.sessions.flatMap((session) => session.renderPage.mock.calls),
    ).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(firstPageAttempts).toBe(1);

    await advanceAndDrain(service, 1);
    expect(service.getStatus(CHAPTER_ID).state).toBe("idle");
    expect(firstPageAttempts).toBe(1);
    expect(await readFile(join(root, "result", "001.png"), "utf8")).toBe(
      "render-001.png",
    );
    await service.dispose();
  });

  it("cancels every active parallel renderer before publishing fresh output", async () => {
    vi.useRealTimers();
    boundary.chapter = makeChapter(MAX_LINKED_WORKSPACE_SYNC_CONCURRENCY);
    boundary.library = makeLibrary();
    const staleGates = new Map(
      requireChapter().pages.map(
        (page) => [page.id, deferred<void>()] as const,
      ),
    );
    const staleStarted: string[] = [];
    boundary.createSession.mockImplementation(async () => {
      const sessionNumber = boundary.createSession.mock.calls.length;
      const session = makeRenderSession(async (page) => {
        if (sessionNumber <= MAX_LINKED_WORKSPACE_SYNC_CONCURRENCY) {
          const gate = staleGates.get(page.id);
          if (!gate) throw new Error(`missing stale gate: ${page.id}`);
          staleStarted.push(page.id);
          await gate.promise;
          return Buffer.from(`stale-${page.name}`);
        }
        return Buffer.from(`fresh-${page.name}`);
      });
      boundary.sessions.push(session);
      return session;
    });
    const { root, service } = await makeConnectedService();

    const firstViewing = service.viewResults({ chapterId: CHAPTER_ID });
    await vi.waitFor(() => {
      expect(staleStarted).toHaveLength(MAX_LINKED_WORKSPACE_SYNC_CONCURRENCY);
    });
    service.reportActivity({ type: "pulse" });
    expect(
      boundary.sessions
        .slice(0, MAX_LINKED_WORKSPACE_SYNC_CONCURRENCY)
        .every((session) => session.cancel.mock.calls.length === 1),
    ).toBe(true);
    for (const gate of staleGates.values()) gate.resolve(undefined);
    const interruptedDrain = Reflect.get(
      service,
      "activeDrainPromise",
    ) as Promise<void> | null;
    await interruptedDrain;

    const secondViewing = service.viewResults({ chapterId: CHAPTER_ID });
    await expect(secondViewing).resolves.toEqual({
      status: "opened",
      syncedPages: MAX_LINKED_WORKSPACE_SYNC_CONCURRENCY,
    });
    await expect(firstViewing).resolves.toEqual({
      status: "opened",
      syncedPages: MAX_LINKED_WORKSPACE_SYNC_CONCURRENCY,
    });
    expect(boundary.createSession).toHaveBeenCalledTimes(
      MAX_LINKED_WORKSPACE_SYNC_CONCURRENCY * 2,
    );
    await expect(
      Promise.all(
        requireChapter().pages.map((page) =>
          readFile(join(root, "result", page.name), "utf8"),
        ),
      ),
    ).resolves.toEqual(
      requireChapter().pages.map((page) => `fresh-${page.name}`),
    );
    await service.dispose();
  });

  it("closes every parallel automatic-save renderer after the idle timeout", async () => {
    boundary.chapter = makeChapter(MAX_LINKED_WORKSPACE_SYNC_CONCURRENCY);
    boundary.library = makeLibrary();
    const { service } = await makeConnectedService();

    const viewing = service.viewResults({ chapterId: CHAPTER_ID });
    await vi.waitFor(() => {
      expect(boundary.sessions).toHaveLength(
        MAX_LINKED_WORKSPACE_SYNC_CONCURRENCY,
      );
    });
    await advanceAndDrain(service, 0);
    await expect(viewing).resolves.toMatchObject({ status: "opened" });
    expect(
      boundary.sessions.every(
        (session) => session.close.mock.calls.length === 0,
      ),
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(
      boundary.sessions.every(
        (session) => session.close.mock.calls.length === 1,
      ),
    ).toBe(true);
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
  for (const page of requireChapter().pages) {
    const internalImagePath = join(dataRoot, page.name);
    await writeFile(
      internalImagePath,
      page.id === PAGE_ID ? "source" : `source-${page.name}`,
    );
    page.imagePath = internalImagePath;
  }
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

function makeRenderSession(render?: (page: MangaPage) => Promise<Buffer>) {
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

function makeChapter(pageCount = 1): ChapterSnapshot {
  const timestamp = "2026-08-24T00:00:00.000Z";
  const pages = Array.from({ length: pageCount }, (_, index) => {
    const pageNumber = index + 1;
    const name = `${String(pageNumber).padStart(3, "0")}.png`;
    const block = {
      id: `block-${pageNumber}`,
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
      id: pageNumber === 1 ? PAGE_ID : makePageId(pageNumber),
      name,
      imagePath: `C:/internal/${name}`,
      sourceFileName: name,
      sourceRelativePath: name,
      dataUrl: "",
      width: 1000,
      height: 1500,
      blocks: [block],
      blockOrder: [block.id],
      analysisStatus: "completed",
      createdAt: timestamp,
      updatedAt: timestamp,
    } satisfies MangaPage;
  });
  return {
    id: CHAPTER_ID,
    workId: WORK_ID,
    title: "1화",
    sourceKind: "folder",
    status: "completed",
    pageOrder: pages.map((page) => page.id),
    pages,
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
            pageCount: chapter.pages.length,
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

function makePageId(pageNumber: number): string {
  return `33333333-3333-4333-8333-${String(pageNumber).padStart(12, "0")}`;
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
