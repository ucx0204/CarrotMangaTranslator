import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LibraryChapter, LibraryWork } from "../src/shared/libraryTypes";

const tempDirs: string[] = [];

describe("share import cancellation boundaries", () => {
  afterEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doUnmock("node:fs/promises");
    vi.doUnmock("../src/main/libraryStore/shareImportMaterialize");
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rolls back when cancellation arrives after an omitted chapter moves to trash", async () => {
    const rootDir = await createTempLibrary();
    const sharePath = join(rootDir, "abort-rollback.mgtshare");
    const controller = new AbortController();
    let abortedAfterTrashMove = false;
    vi.doMock("node:fs/promises", async () => {
      const actual =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      return {
        ...actual,
        rename: async (
          oldPath: Parameters<typeof actual.rename>[0],
          newPath: Parameters<typeof actual.rename>[1],
        ) => {
          await actual.rename(oldPath, newPath);
          const targetPath = String(newPath).replace(/\\/g, "/");
          if (
            !abortedAfterTrashMove &&
            targetPath.includes("/chapters/.trash/") &&
            targetPath.endsWith("/chapter-a")
          ) {
            abortedAfterTrashMove = true;
            controller.abort(
              new DOMException("cancel after trash", "AbortError"),
            );
          }
        },
      };
    });
    const library = await loadLibrary(rootDir);
    await seedLibrary(rootDir);
    await exportChapterA(library, sharePath);

    await expect(
      library.importWorkShare(mergeRequest(sharePath), controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(abortedAfterTrashMove).toBe(true);
    const work = (await library.listLibrary()).works.find(
      (candidate) => candidate.id === "work-1",
    );
    expect(work?.chapterOrder).toEqual(["chapter-a", "chapter-b"]);
    expect(work?.chapters.map((chapter) => chapter.title)).toEqual([
      "1화",
      "2화",
    ]);
    const chapterDirs = await readdir(
      join(rootDir, "works", "work-1", "chapters"),
    );
    expect(chapterDirs.sort()).toEqual(["chapter-a", "chapter-b"]);
  });

  it("lets the commit win when cancellation arrives during irreversible discard", async () => {
    const rootDir = await createTempLibrary();
    const sharePath = join(rootDir, "abort-commit-wins.mgtshare");
    const controller = new AbortController();
    let abortedDuringDiscard = false;
    vi.doMock("node:fs/promises", async () => {
      const actual =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      return {
        ...actual,
        rm: async (
          path: Parameters<typeof actual.rm>[0],
          options?: Parameters<typeof actual.rm>[1],
        ) => {
          const targetPath = String(path).replace(/\\/g, "/");
          if (
            !abortedDuringDiscard &&
            targetPath.includes("/chapters/.trash/")
          ) {
            abortedDuringDiscard = true;
            controller.abort(
              new DOMException("cancel during discard", "AbortError"),
            );
          }
          await actual.rm(path, options);
        },
      };
    });
    const library = await loadLibrary(rootDir);
    await seedLibrary(rootDir);
    await exportChapterA(library, sharePath);

    const result = await library.importWorkShare(
      mergeRequest(sharePath),
      controller.signal,
    );

    expect(abortedDuringDiscard).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    const work = (await library.listLibrary()).works.find(
      (candidate) => candidate.id === "work-1",
    );
    expect(work?.chapterOrder).toEqual(result.chapterIds);
    expect(work?.chapters.map((chapter) => chapter.title)).toEqual([
      "기존 유지",
      "교체본",
    ]);
    expect(
      existsSync(join(rootDir, "works", "work-1", "chapters", "chapter-a")),
    ).toBe(false);
  });

  it("rolls back a materialized package chapter when cancellation arrives before caller tracking", async () => {
    const rootDir = await createTempLibrary();
    const sharePath = join(rootDir, "abort-after-materialize.mgtshare");
    const controller = new AbortController();
    let materializedChapterId: string | null = null;

    vi.doMock("../src/main/libraryStore/shareImportMaterialize", async () => {
      const actual = await vi.importActual<
        typeof import("../src/main/libraryStore/shareImportMaterialize")
      >("../src/main/libraryStore/shareImportMaterialize");
      return {
        ...actual,
        materializeSharedChapter: async (
          options: Parameters<typeof actual.materializeSharedChapter>[0],
        ) => {
          const chapter = await actual.materializeSharedChapter(options);
          materializedChapterId = chapter.id;
          controller.abort(
            new DOMException("cancel after materialization", "AbortError"),
          );
          return chapter;
        },
      };
    });

    const library = await loadLibrary(rootDir);
    await seedLibrary(rootDir);
    await exportChapterA(library, sharePath);

    await expect(
      library.importWorkShare(mergeRequest(sharePath), controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(materializedChapterId).not.toBeNull();
    const work = (await library.listLibrary()).works.find(
      (candidate) => candidate.id === "work-1",
    );
    expect(work?.chapterOrder).toEqual(["chapter-a", "chapter-b"]);
    expect(work?.chapters.map((chapter) => chapter.title)).toEqual([
      "1화",
      "2화",
    ]);
    if (!materializedChapterId) {
      throw new Error("Expected a materialized chapter id");
    }
    expect(
      existsSync(
        join(rootDir, "works", "work-1", "chapters", materializedChapterId),
      ),
    ).toBe(false);
    const chapterDirs = await readdir(
      join(rootDir, "works", "work-1", "chapters"),
    );
    expect(chapterDirs.sort()).toEqual(["chapter-a", "chapter-b"]);
    expect(chapterDirs).not.toContain(".trash");
  });
});

async function exportChapterA(
  library: typeof import("../src/main/library"),
  outputPath: string,
): Promise<void> {
  await library.exportWorkShareToFile({
    workId: "work-1",
    chapterIds: ["chapter-a"],
    outputPath,
  });
}

function mergeRequest(packagePath: string) {
  return {
    packagePath,
    target: { mode: "existing" as const, workId: "work-1" },
    entries: [
      {
        source: "existing" as const,
        chapterId: "chapter-b",
        title: "기존 유지",
      },
      {
        source: "package" as const,
        packageChapterId: "chapter-a",
        title: "교체본",
      },
    ],
  };
}

async function createTempLibrary(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "share-import-cancel-"));
  tempDirs.push(rootDir);
  return rootDir;
}

async function loadLibrary(
  rootDir: string,
): Promise<typeof import("../src/main/library")> {
  vi.resetModules();
  vi.doMock("electron", () => ({
    app: { isPackaged: false },
    nativeImage: {
      createFromPath: () => ({
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
      fontsDir: join(rootDir, "fonts"),
      logsDir: join(rootDir, "logs"),
      logFile: join(rootDir, "logs", "app.log"),
      runtimeDir: join(rootDir, "runtime"),
      toolsDir: join(rootDir, "tools"),
      ocrRuntimeDir: join(rootDir, "ocr-runtime"),
      llamaRuntimeDir: join(rootDir, "tools", "llama"),
      llamaServerPath: join(rootDir, "tools", "llama", "llama-server.exe"),
    }),
  }));
  return import("../src/main/library");
}

async function seedLibrary(rootDir: string): Promise<void> {
  const work: LibraryWork = {
    id: "work-1",
    title: "원본 작품",
    chapterOrder: ["chapter-a", "chapter-b"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  for (const chapterId of work.chapterOrder) {
    await mkdir(
      join(rootDir, "works", work.id, "chapters", chapterId, "pages"),
      { recursive: true },
    );
  }
  await writeJson(join(rootDir, "index.json"), { workOrder: [work.id] });
  await writeJson(join(rootDir, "works", work.id, "work.json"), work);
  await seedChapter(rootDir, "chapter-a", "1화", "page-a");
  await seedChapter(rootDir, "chapter-b", "2화", "page-b");
}

async function seedChapter(
  rootDir: string,
  chapterId: string,
  title: string,
  pageId: string,
): Promise<void> {
  const chapter = makeChapter(rootDir, chapterId, title, pageId);
  await writeFile(chapter.pages[0]?.imagePath ?? "", `image-${pageId}`);
  await writeJson(
    join(rootDir, "works", "work-1", "chapters", chapterId, "chapter.json"),
    chapter,
  );
}

function makeChapter(
  rootDir: string,
  chapterId: string,
  title: string,
  pageId: string,
): LibraryChapter {
  return {
    id: chapterId,
    workId: "work-1",
    title,
    sourceKind: "folder",
    status: "completed",
    pageOrder: [pageId],
    pages: [
      {
        id: pageId,
        name: "001.png",
        imagePath: join(
          rootDir,
          "works",
          "work-1",
          "chapters",
          chapterId,
          "pages",
          `001-${pageId}.png`,
        ),
        width: 100,
        height: 120,
        blocks: [],
        analysisStatus: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function writeJson(path: string, payload: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
