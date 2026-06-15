import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LibraryChapter, LibraryWork } from "../src/shared/types";

const tempDirs: string[] = [];

describe("inpainting artifact cleanup", () => {
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

  it("removes the previous same-page inpainted artifact after replacement", async () => {
    const rootDir = await createTempLibrary();
    const library = await loadLibrary(rootDir);
    await seedLibrary(rootDir);

    const inpaintedDir = join(rootDir, "works", "work-1", "chapters", "chapter-a", "inpainted");
    const oldPath = join(inpaintedDir, "001-page-a-retouch-old.png");
    const newPath = join(inpaintedDir, "001-page-a-retouch-new.png");
    await mkdir(inpaintedDir, { recursive: true });
    await writeFile(oldPath, "old");
    await writeFile(newPath, "new");

    const chapter = await library.openChapter("chapter-a");
    const page = firstPage(chapter);
    const withOld = await library.updatePagesAfterInpainting(chapter.id, [{ ...page, inpaintedImagePath: oldPath }]);
    const withNew = await library.updatePagesAfterInpainting(chapter.id, [{ ...firstPage(withOld), inpaintedImagePath: newPath }]);

    expect(withNew.pages[0]?.inpaintedImagePath).toBe(newPath);
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(newPath)).toBe(true);
  });

  it("removes the current inpainted artifact when a page is reverted", async () => {
    const rootDir = await createTempLibrary();
    const library = await loadLibrary(rootDir);
    await seedLibrary(rootDir);

    const inpaintedDir = join(rootDir, "works", "work-1", "chapters", "chapter-a", "inpainted");
    const oldPath = join(inpaintedDir, "001-page-a-retouch-old.png");
    await mkdir(inpaintedDir, { recursive: true });
    await writeFile(oldPath, "old");

    const chapter = await library.openChapter("chapter-a");
    const withOld = await library.updatePagesAfterInpainting(chapter.id, [{ ...firstPage(chapter), inpaintedImagePath: oldPath }]);
    const reverted = await library.updatePagesAfterInpainting(chapter.id, [{ ...firstPage(withOld), inpaintedImagePath: undefined }]);

    expect(reverted.pages[0]?.inpaintedImagePath).toBeUndefined();
    expect(existsSync(oldPath)).toBe(false);
  });

  it("keeps retained retouch artifacts while replacing an inpainted page result", async () => {
    const rootDir = await createTempLibrary();
    const library = await loadLibrary(rootDir);
    await seedLibrary(rootDir);

    const inpaintedDir = join(rootDir, "works", "work-1", "chapters", "chapter-a", "inpainted");
    const oldPath = join(inpaintedDir, "001-page-a-retouch-old.png");
    const newPath = join(inpaintedDir, "001-page-a-retouch-new.png");
    const orphanPath = join(inpaintedDir, "001-page-a-retouch-orphan.png");
    await mkdir(inpaintedDir, { recursive: true });
    await writeFile(oldPath, "old");
    await writeFile(newPath, "new");
    await writeFile(orphanPath, "orphan");

    const chapter = await library.openChapter("chapter-a");
    const withOld = await library.updatePagesAfterInpainting(chapter.id, [{ ...firstPage(chapter), inpaintedImagePath: oldPath }]);
    const withNew = await library.updatePagesAfterInpainting(
      chapter.id,
      [{ ...firstPage(withOld), inpaintedImagePath: newPath }],
      { retainedInpaintedArtifactPaths: [oldPath] }
    );

    expect(withNew.pages[0]?.inpaintedImagePath).toBe(newPath);
    expect(existsSync(oldPath)).toBe(true);
    expect(existsSync(newPath)).toBe(true);
    expect(existsSync(orphanPath)).toBe(false);
  });

  it("keeps retained retouch artifacts while undoing and redoing a page result", async () => {
    const rootDir = await createTempLibrary();
    const library = await loadLibrary(rootDir);
    await seedLibrary(rootDir);

    const inpaintedDir = join(rootDir, "works", "work-1", "chapters", "chapter-a", "inpainted");
    const afterPath = join(inpaintedDir, "001-page-a-retouch-after.png");
    await mkdir(inpaintedDir, { recursive: true });
    await writeFile(afterPath, "after");

    const chapter = await library.openChapter("chapter-a");
    const withAfter = await library.updatePagesAfterInpainting(chapter.id, [{ ...firstPage(chapter), inpaintedImagePath: afterPath }]);
    const pageWithAfter = firstPage(withAfter);
    const undone = await library.setPageInpaintingResult(chapter.id, pageWithAfter.id, undefined, {
      retainedInpaintedArtifactPaths: [afterPath]
    });

    expect(undone.pages[0]?.inpaintedImagePath).toBeUndefined();
    expect(existsSync(afterPath)).toBe(true);

    const redone = await library.setPageInpaintingResult(chapter.id, pageWithAfter.id, afterPath, {
      retainedInpaintedArtifactPaths: [afterPath]
    });

    expect(redone.pages[0]?.inpaintedImagePath).toBe(afterPath);
    expect(existsSync(afterPath)).toBe(true);
  });

  it("relocates copied chapter image paths from a previous data root", async () => {
    const rootDir = await createTempLibrary();
    const oldRootDir = await createTempLibrary();
    const library = await loadLibrary(rootDir);
    await seedLibrary(rootDir, oldRootDir);

    const chapter = await library.openChapter("chapter-a");

    expect(chapter.pages[0]?.imagePath).toBe(join(rootDir, "works", "work-1", "chapters", "chapter-a", "pages", "001-page-a.png"));
    expect(chapter.pages[0]?.inpaintedImagePath).toBe(
      join(rootDir, "works", "work-1", "chapters", "chapter-a", "inpainted", "001-page-a-inpainted.png")
    );
  });
});

async function createTempLibrary(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "manga-inpainting-cleanup-"));
  tempDirs.push(rootDir);
  return rootDir;
}

function firstPage<T>(chapter: { pages: T[] }): T {
  const page = chapter.pages[0];
  if (!page) {
    throw new Error("Expected chapter to contain a page");
  }
  return page;
}

async function loadLibrary(rootDir: string): Promise<typeof import("../src/main/library")> {
  vi.resetModules();
  vi.doMock("electron", () => ({
    app: {
      isPackaged: false
    },
    nativeImage: {
      createFromPath: () => ({
        getSize: () => ({ width: 64, height: 96 })
      })
    }
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
      llamaServerPath: join(rootDir, "tools", "llama", "llama-server.exe")
    })
  }));
  return import("../src/main/library");
}

async function seedLibrary(rootDir: string, storedPathRoot = rootDir): Promise<void> {
  const work: LibraryWork = {
    id: "work-1",
    title: "원본 작품",
    chapterOrder: ["chapter-a"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  await mkdir(join(rootDir, "works", work.id, "chapters", "chapter-a", "pages"), { recursive: true });
  await mkdir(join(rootDir, "works", work.id, "chapters", "chapter-a", "inpainted"), { recursive: true });
  await writeJson(join(rootDir, "index.json"), { workOrder: [work.id] });
  await writeJson(join(rootDir, "works", work.id, "work.json"), work);
  await writeFile(join(rootDir, "works", work.id, "chapters", "chapter-a", "pages", "001-page-a.png"), "image-a");
  await writeFile(join(rootDir, "works", work.id, "chapters", "chapter-a", "inpainted", "001-page-a-inpainted.png"), "inpainted-a");
  await writeJson(join(rootDir, "works", work.id, "chapters", "chapter-a", "chapter.json"), makeChapter(storedPathRoot));
}

function makeChapter(rootDir: string): LibraryChapter {
  return {
    id: "chapter-a",
    workId: "work-1",
    title: "1화",
    sourceKind: "folder",
    status: "completed",
    pageOrder: ["page-a"],
    pages: [
      {
        id: "page-a",
        name: "001.png",
        imagePath: join(rootDir, "works", "work-1", "chapters", "chapter-a", "pages", "001-page-a.png"),
        inpaintedImagePath: join(rootDir, "works", "work-1", "chapters", "chapter-a", "inpainted", "001-page-a-inpainted.png"),
        width: 100,
        height: 120,
        blocks: [],
        analysisStatus: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

async function writeJson(path: string, payload: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
