import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  LibraryChapter,
  LibraryWork,
  MangaPage,
} from "../src/shared/libraryTypes";
import type { InpaintingMutationMaintenance } from "../src/main/libraryStore/libraryInpaintingMutations";

const tempDirs: string[] = [];

describe("InpaintingRevisionStore", () => {
  afterEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("undoes and redoes a multi-chapter transaction atomically", async () => {
    const rootDir = await createTempLibrary();
    const paths = await seedLibrary(rootDir);
    const { InpaintingRevisionStore, library } = await loadModules(rootDir);
    const store = new InpaintingRevisionStore();
    const transactionId = store.beginTransaction();
    store.addChange(transactionId, {
      chapterId: CHAPTER_A_ID,
      pageId: PAGE_A_ID,
      beforePath: paths.beforeA,
      afterPath: paths.afterA,
    });
    store.addChange(transactionId, {
      chapterId: CHAPTER_B_ID,
      pageId: PAGE_B_ID,
      beforePath: undefined,
      afterPath: paths.afterB,
    });

    const undone = await store.applyTransaction({
      transactionId,
      direction: "undo",
    });
    expect(undone.pagesChanged).toBe(2);
    expect(undone.invalidated).toBe(false);
    expect(undone.chapters.map((chapter) => chapter.id)).toEqual([
      CHAPTER_A_ID,
      CHAPTER_B_ID,
    ]);
    expect(
      firstPage(await library.openChapter(CHAPTER_A_ID)).inpaintedImagePath,
    ).toBe(paths.beforeA);
    expect(
      firstPage(await library.openChapter(CHAPTER_B_ID)).inpaintedImagePath,
    ).toBeUndefined();

    const redone = await store.applyTransaction({
      transactionId,
      direction: "redo",
    });
    expect(redone.pagesChanged).toBe(2);
    expect(redone.invalidated).toBe(false);
    expect(
      firstPage(await library.openChapter(CHAPTER_A_ID)).inpaintedImagePath,
    ).toBe(paths.afterA);
    expect(
      firstPage(await library.openChapter(CHAPTER_B_ID)).inpaintedImagePath,
    ).toBe(paths.afterB);
    expect(existsSync(paths.beforeA)).toBe(true);
    expect(existsSync(paths.afterA)).toBe(true);
    expect(existsSync(paths.afterB)).toBe(true);
  });

  it("rejects a stale transaction without moving or deleting it", async () => {
    const rootDir = await createTempLibrary();
    const paths = await seedLibrary(rootDir);
    const { InpaintingRevisionStore, library } = await loadModules(rootDir);
    const store = new InpaintingRevisionStore();
    const transactionId = store.beginTransaction();
    store.addChange(transactionId, {
      chapterId: CHAPTER_A_ID,
      pageId: PAGE_A_ID,
      beforePath: paths.beforeA,
      afterPath: paths.afterA,
    });
    await library.setPageInpaintingResult(
      CHAPTER_A_ID,
      PAGE_A_ID,
      paths.otherA,
      {
        retainedInpaintedArtifactPaths: store.getRetainedArtifactPaths(
          CHAPTER_A_ID,
          [paths.otherA],
        ),
      },
    );

    await expect(
      store.applyTransaction({ transactionId, direction: "undo" }),
    ).rejects.toThrow(/다른 작업/);
    expect(store.getReference(transactionId)).toEqual({ transactionId });
    expect(
      firstPage(await library.openChapter(CHAPTER_A_ID)).inpaintedImagePath,
    ).toBe(paths.otherA);

    await library.setPageInpaintingResult(
      CHAPTER_A_ID,
      PAGE_A_ID,
      paths.afterA,
      {
        retainedInpaintedArtifactPaths:
          store.getRetainedArtifactPaths(CHAPTER_A_ID),
      },
    );
    await store.applyTransaction({ transactionId, direction: "undo" });
    expect(
      firstPage(await library.openChapter(CHAPTER_A_ID)).inpaintedImagePath,
    ).toBe(paths.beforeA);
  });

  it("garbage-collects released artifacts while preserving the live image", async () => {
    const rootDir = await createTempLibrary();
    const paths = await seedLibrary(rootDir);
    const { InpaintingRevisionStore } = await loadModules(rootDir);
    const store = new InpaintingRevisionStore();
    const transactionId = store.beginTransaction();
    store.addChange(transactionId, {
      chapterId: CHAPTER_A_ID,
      pageId: PAGE_A_ID,
      beforePath: paths.beforeA,
      afterPath: paths.afterA,
    });

    expect(
      await store.releaseTransactions([transactionId, transactionId]),
    ).toBe(1);
    expect(existsSync(paths.afterA)).toBe(true);
    expect(existsSync(paths.beforeA)).toBe(false);
    expect(store.getReference(transactionId)).toBeUndefined();
  });

  it.each(["releaseTransactions", "releaseAll"] as const)(
    "serializes %s behind an active apply before garbage collection",
    async (releaseMethod) => {
      const rootDir = await createTempLibrary();
      const paths = await seedLibrary(rootDir);
      const applyGate = createVoidDeferred();
      let mutationCount = 0;
      const { InpaintingRevisionStore, library, revisionRepository } =
        await loadModules(rootDir);
      const repository = {
        ...revisionRepository,
        runMutation: async <T>(operation: () => Promise<T>) => {
          mutationCount += 1;
          if (mutationCount === 1) {
            await applyGate.promise;
          }
          return operation();
        },
      };

      try {
        const store = new InpaintingRevisionStore(repository);
        const transactionId = store.beginTransaction();
        store.addChange(transactionId, {
          chapterId: CHAPTER_A_ID,
          pageId: PAGE_A_ID,
          beforePath: paths.beforeA,
          afterPath: paths.afterA,
        });

        const applying = store.applyTransaction({
          transactionId,
          direction: "undo",
        });
        await vi.waitFor(() => expect(mutationCount).toBe(1));
        const releasing =
          releaseMethod === "releaseAll"
            ? store.releaseAll()
            : store.releaseTransactions([transactionId]);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        expect(mutationCount).toBe(1);
        expect(store.getReference(transactionId)).toEqual({ transactionId });
        expect(existsSync(paths.beforeA)).toBe(true);

        applyGate.resolve();
        const [applied, released] = await Promise.all([applying, releasing]);
        expect(applied.invalidated).toBe(false);
        expect(released).toBe(1);
        expect(mutationCount).toBe(2);
        expect(
          firstPage(await library.openChapter(CHAPTER_A_ID)).inpaintedImagePath,
        ).toBe(paths.beforeA);
        expect(existsSync(paths.beforeA)).toBe(true);
        expect(existsSync(paths.afterA)).toBe(false);
      } finally {
        applyGate.resolve();
      }
    },
  );

  it("creates a fresh immutable output path for every inpainting result", async () => {
    const rootDir = await createTempLibrary();
    await mockAppPaths(rootDir);
    const { resolveInpaintedImagePath } =
      await import("../src/main/inpainting/imageIO");
    const source = join(
      rootDir,
      "works",
      WORK_ID,
      "chapters",
      CHAPTER_A_ID,
      "pages",
      "001-page-a.png",
    );

    const first = resolveInpaintedImagePath(source, "pattern");
    const second = resolveInpaintedImagePath(source, "pattern");
    expect(first).not.toBe(second);
    expect(first).toMatch(/[\\/]inpainted[\\/]pattern-[0-9a-f-]{36}\.png$/i);
    expect(second).toMatch(/[\\/]inpainted[\\/]pattern-[0-9a-f-]{36}\.png$/i);
    expect(basename(first).length).toBeLessThanOrEqual(57);
  });

  it("keeps generated artifact names bounded regardless of the source name", async () => {
    const rootDir = await createTempLibrary();
    await mockAppPaths(rootDir);
    const { resolveInpaintedImagePath } =
      await import("../src/main/inpainting/imageIO");
    const source = join(
      rootDir,
      "works",
      WORK_ID,
      "chapters",
      CHAPTER_A_ID,
      "pages",
      `${"source-name-".repeat(18)}.png`,
    );

    const output = resolveInpaintedImagePath(
      source,
      `suffix-${"x".repeat(100)}`,
    );

    expect(dirname(output)).toBe(
      join(rootDir, "works", WORK_ID, "chapters", CHAPTER_A_ID, "inpainted"),
    );
    expect(basename(output).length).toBeLessThanOrEqual(57);
    expect(basename(output)).not.toContain("source-name");
  });

  it("keeps the reported installed result path safely below MAX_PATH", async () => {
    const rootDir = await createTempLibrary();
    await mockAppPaths(rootDir);
    const { resolveInpaintedImagePath } =
      await import("../src/main/inpainting/imageIO");
    const reportedLibraryRoot =
      "C:\\Users\\USER\\AppData\\Local\\Programs\\carrot-manga-translator\\data\\library";
    const reportedLegacyPath = win32.join(
      reportedLibraryRoot,
      "works",
      "ac7d39e9-cdb8-459f-a6bb-3dea736b0567",
      "chapters",
      "11b7563c-d12f-4e29-bc10-74179c992472",
      "inpainted",
      "001-2019aaa2-d470-4a7a-8de0-249087e7948a-pattern-48b791ce-6855-426b-89f6-bcc664215890.png",
    );
    const output = resolveInpaintedImagePath(
      join(rootDir, "pages", "source.png"),
      "x".repeat(100),
    );
    const reportedNewPath = win32.join(
      win32.dirname(reportedLegacyPath),
      basename(output),
    );

    expect(reportedLegacyPath.length).toBe(262);
    expect(reportedNewPath.length).toBeLessThan(252);
  });

  it("keeps a committed image revision when post-commit cleanup fails", async () => {
    const rootDir = await createTempLibrary();
    const paths = await seedLibrary(rootDir);
    const removeArtifacts = vi.fn().mockRejectedValue(new Error("locked"));
    const warn = vi.fn();
    const { InpaintingRevisionStore, library, mutationOperations } =
      await loadModules(rootDir, {
        collectManagedArtifacts: vi.fn(async () => [paths.beforeA]),
        removeUnreferencedArtifacts: removeArtifacts,
        touchWork: vi.fn(async () => {}),
        warn,
      });
    const store = new InpaintingRevisionStore();
    const chapter = await library.openChapter(CHAPTER_A_ID);
    const page = firstPage(chapter);
    const transactionId = store.beginTransaction();
    store.addChange(transactionId, {
      chapterId: CHAPTER_A_ID,
      pageId: PAGE_A_ID,
      beforePath: page.inpaintedImagePath,
      afterPath: paths.otherA,
    });

    const saved = await mutationOperations.updatePagesAfterInpaintingUnlocked(
      CHAPTER_A_ID,
      [{ ...page, inpaintedImagePath: paths.otherA }],
      {
        retainedInpaintedArtifactPaths:
          store.getRetainedArtifactPaths(CHAPTER_A_ID),
      },
    );

    expect(firstPage(saved).inpaintedImagePath).toBe(paths.otherA);
    expect(store.getReference(transactionId)).toEqual({ transactionId });
    expect(
      firstPage(await library.openChapter(CHAPTER_A_ID)).inpaintedImagePath,
    ).toBe(paths.otherA);
    expect(removeArtifacts).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "Failed to clean artifacts after committing inpainting paths",
      expect.objectContaining({ chapterId: CHAPTER_A_ID }),
    );
  });
});

const WORK_ID = "11111111-1111-4111-8111-111111111111";
const CHAPTER_A_ID = "22222222-2222-4222-8222-222222222222";
const CHAPTER_B_ID = "33333333-3333-4333-8333-333333333333";
const PAGE_A_ID = "44444444-4444-4444-8444-444444444444";
const PAGE_B_ID = "55555555-5555-4555-8555-555555555555";

async function createTempLibrary(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "manga-inpainting-revisions-"));
  tempDirs.push(rootDir);
  return rootDir;
}

async function loadModules(
  rootDir: string,
  maintenance?: InpaintingMutationMaintenance,
) {
  await mockAppPaths(rootDir);
  const [
    { InpaintingRevisionStore },
    library,
    { libraryInpaintingRevisionRepository: revisionRepository },
    {
      createInpaintingMutationOperations,
      setPageInpaintingResultUnlocked,
      updatePagesAfterInpaintingUnlocked,
    },
  ] = await Promise.all([
    import("../src/main/inpainting/inpaintingRevisionStore"),
    import("../src/main/library"),
    import("../src/main/inpainting/inpaintingRevisionRepository"),
    import("../src/main/libraryStore/libraryInpaintingMutations"),
  ]);
  return {
    InpaintingRevisionStore,
    library,
    revisionRepository,
    mutationOperations: maintenance
      ? createInpaintingMutationOperations(maintenance)
      : {
          updatePagesAfterInpaintingUnlocked,
          setPageInpaintingResultUnlocked,
        },
  };
}

async function mockAppPaths(rootDir: string): Promise<void> {
  vi.resetModules();
  vi.doMock("electron", () => ({
    app: { isPackaged: false },
    nativeImage: {
      createFromPath: () => ({
        isEmpty: () => false,
        getSize: () => ({ width: 64, height: 96 }),
      }),
    },
  }));
  vi.doMock("../src/main/appPaths", () => ({
    getAppPaths: () => ({
      isPackaged: false,
      repoRoot: rootDir,
      executableDir: rootDir,
      resourcesDir: rootDir,
      dataRoot: rootDir,
      settingsPath: join(rootDir, "settings.json"),
      libraryDir: rootDir,
      logsDir: join(rootDir, "logs"),
      logFile: join(rootDir, "logs", "app.log"),
      runtimeDir: join(rootDir, "runtime"),
      toolsDir: join(rootDir, "tools"),
      llamaRuntimeDir: join(rootDir, "tools", "llama"),
      llamaServerPath: join(rootDir, "tools", "llama", "llama-server.exe"),
    }),
  }));
}

async function seedLibrary(rootDir: string) {
  const work: LibraryWork = {
    id: WORK_ID,
    title: "원본 작품",
    chapterOrder: [CHAPTER_A_ID, CHAPTER_B_ID],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  await writeJson(join(rootDir, "index.json"), { workOrder: [WORK_ID] });
  await writeJson(join(rootDir, "works", WORK_ID, "work.json"), work);

  const beforeA = await seedImage(rootDir, CHAPTER_A_ID, "a-before.png");
  const afterA = await seedImage(rootDir, CHAPTER_A_ID, "a-after.png");
  const otherA = await seedImage(rootDir, CHAPTER_A_ID, "a-other.png");
  const afterB = await seedImage(rootDir, CHAPTER_B_ID, "b-after.png");
  await seedChapter(rootDir, CHAPTER_A_ID, PAGE_A_ID, afterA);
  await seedChapter(rootDir, CHAPTER_B_ID, PAGE_B_ID, afterB);
  return { beforeA, afterA, otherA, afterB };
}

async function seedChapter(
  rootDir: string,
  chapterId: string,
  pageId: string,
  inpaintedImagePath: string,
): Promise<void> {
  const pagesDir = join(
    rootDir,
    "works",
    WORK_ID,
    "chapters",
    chapterId,
    "pages",
  );
  await mkdir(pagesDir, { recursive: true });
  const imagePath = join(pagesDir, `${pageId}.png`);
  await writeFile(imagePath, "source");
  const chapter: LibraryChapter = {
    id: chapterId,
    workId: WORK_ID,
    title: chapterId,
    sourceKind: "images",
    status: "completed",
    pageOrder: [pageId],
    pages: [
      {
        id: pageId,
        name: `${pageId}.png`,
        imagePath,
        inpaintedImagePath,
        width: 64,
        height: 96,
        blocks: [],
        analysisStatus: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  await writeJson(
    join(rootDir, "works", WORK_ID, "chapters", chapterId, "chapter.json"),
    chapter,
  );
}

async function seedImage(
  rootDir: string,
  chapterId: string,
  fileName: string,
): Promise<string> {
  const imagePath = join(
    rootDir,
    "works",
    WORK_ID,
    "chapters",
    chapterId,
    "inpainted",
    fileName,
  );
  await mkdir(dirname(imagePath), { recursive: true });
  await writeFile(imagePath, fileName);
  return imagePath;
}

function firstPage(chapter: { pages: MangaPage[] }): MangaPage {
  const page = chapter.pages[0];
  if (!page) {
    throw new Error("Expected a page");
  }
  return page;
}

function createVoidDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
