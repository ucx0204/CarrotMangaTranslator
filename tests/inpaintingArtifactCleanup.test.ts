import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LibraryChapter, LibraryWork } from "../src/shared/libraryTypes";
import { createPageJobTargetSnapshot } from "../src/shared/pageRevision";

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

  it("rejects an inpainting update for a page outside the chapter", async () => {
    const rootDir = await createTempLibrary();
    const library = await loadLibrary(rootDir);
    await seedLibrary(rootDir);
    const chapter = await library.openChapter("chapter-a");

    await expect(
      library.updatePagesAfterInpainting(chapter.id, [
        { ...firstPage(chapter), id: "missing-page" },
      ]),
    ).rejects.toThrow("인페인팅 결과를 적용할 페이지를 찾지 못했습니다.");
  });

  it("persists a completed translation workflow receipt with the result", async () => {
    const rootDir = await createTempLibrary();
    const library = await loadLibrary(rootDir);
    await seedLibrary(rootDir);
    const chapter = await library.openChapter("chapter-a");
    const pending = await library.updatePagesAfterInpainting(chapter.id, [
      {
        ...firstPage(chapter),
        translationCompletion: {
          workflow: "erase-original",
          status: "pending",
        },
      },
    ]);
    expect(pending.status).toBe("partial");

    const saved = await library.updatePagesAfterInpainting(chapter.id, [
      {
        ...firstPage(pending),
        translationCompletion: {
          workflow: "erase-original",
          status: "completed",
        },
      },
    ]);

    expect(saved.pages[0]?.translationCompletion).toEqual({
      workflow: "erase-original",
      status: "completed",
    });
    expect(saved.status).toBe("completed");
  });

  it("rejects a stale inpainting result after the target page changes", async () => {
    const rootDir = await createTempLibrary();
    const library = await loadLibrary(rootDir);
    await seedLibrary(rootDir);
    const chapter = await library.openChapter("chapter-a");
    const originalPage = firstPage(chapter);
    const expectedTarget = createPageJobTargetSnapshot(
      chapter.id,
      originalPage,
    );
    const inpaintedDir = join(
      rootDir,
      "works",
      "work-1",
      "chapters",
      chapter.id,
      "inpainted",
    );
    const interveningPath = join(inpaintedDir, "intervening.png");
    const staleResultPath = join(inpaintedDir, "stale-result.png");
    await mkdir(inpaintedDir, { recursive: true });
    await writeFile(interveningPath, "newer");
    await writeFile(staleResultPath, "stale");
    await library.setPageInpaintingResult(
      chapter.id,
      originalPage.id,
      interveningPath,
    );

    await expect(
      library.updatePagesAfterInpainting(
        chapter.id,
        [{ ...originalPage, inpaintedImagePath: staleResultPath }],
        { expectedTargets: [expectedTarget] },
      ),
    ).rejects.toThrow(/오래된 인페인팅 결과/);

    const reopened = await library.openChapter(chapter.id);
    expect(firstPage(reopened).inpaintedImagePath).toBe(interveningPath);
  });

  it("removes the previous same-page inpainted artifact after replacement", async () => {
    const rootDir = await createTempLibrary();
    const library = await loadLibrary(rootDir);
    await seedLibrary(rootDir);

    const inpaintedDir = join(
      rootDir,
      "works",
      "work-1",
      "chapters",
      "chapter-a",
      "inpainted",
    );
    const oldPath = join(inpaintedDir, "001-page-a-retouch-old.png");
    const newPath = join(inpaintedDir, "001-page-a-retouch-new.png");
    await mkdir(inpaintedDir, { recursive: true });
    await writeFile(oldPath, "old");
    await writeFile(newPath, "new");

    const chapter = await library.openChapter("chapter-a");
    const page = firstPage(chapter);
    const withOld = await library.updatePagesAfterInpainting(chapter.id, [
      { ...page, inpaintedImagePath: oldPath },
    ]);
    const withNew = await library.updatePagesAfterInpainting(chapter.id, [
      { ...firstPage(withOld), inpaintedImagePath: newPath },
    ]);

    expect(withNew.pages[0]?.inpaintedImagePath).toBe(newPath);
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(newPath)).toBe(true);
  });

  it("removes the current inpainted artifact when a page is reverted", async () => {
    const rootDir = await createTempLibrary();
    const library = await loadLibrary(rootDir);
    await seedLibrary(rootDir);

    const inpaintedDir = join(
      rootDir,
      "works",
      "work-1",
      "chapters",
      "chapter-a",
      "inpainted",
    );
    const oldPath = join(inpaintedDir, "001-page-a-retouch-old.png");
    await mkdir(inpaintedDir, { recursive: true });
    await writeFile(oldPath, "old");

    const chapter = await library.openChapter("chapter-a");
    const withOld = await library.updatePagesAfterInpainting(chapter.id, [
      { ...firstPage(chapter), inpaintedImagePath: oldPath },
    ]);
    const reverted = await library.updatePagesAfterInpainting(chapter.id, [
      { ...firstPage(withOld), inpaintedImagePath: undefined },
    ]);

    expect(reverted.pages[0]?.inpaintedImagePath).toBeUndefined();
    expect(existsSync(oldPath)).toBe(false);
  });

  it("keeps retained retouch artifacts while replacing an inpainted page result", async () => {
    const rootDir = await createTempLibrary();
    const library = await loadLibrary(rootDir);
    await seedLibrary(rootDir);

    const inpaintedDir = join(
      rootDir,
      "works",
      "work-1",
      "chapters",
      "chapter-a",
      "inpainted",
    );
    const oldPath = join(inpaintedDir, "001-page-a-retouch-old.png");
    const newPath = join(inpaintedDir, "001-page-a-retouch-new.png");
    const orphanPath = join(inpaintedDir, "001-page-a-retouch-orphan.png");
    await mkdir(inpaintedDir, { recursive: true });
    await writeFile(oldPath, "old");
    await writeFile(newPath, "new");
    await writeFile(orphanPath, "orphan");

    const chapter = await library.openChapter("chapter-a");
    const withOld = await library.updatePagesAfterInpainting(chapter.id, [
      { ...firstPage(chapter), inpaintedImagePath: oldPath },
    ]);
    const withNew = await library.updatePagesAfterInpainting(
      chapter.id,
      [{ ...firstPage(withOld), inpaintedImagePath: newPath }],
      { retainedInpaintedArtifactPaths: [oldPath] },
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

    const inpaintedDir = join(
      rootDir,
      "works",
      "work-1",
      "chapters",
      "chapter-a",
      "inpainted",
    );
    const afterPath = join(inpaintedDir, "001-page-a-retouch-after.png");
    await mkdir(inpaintedDir, { recursive: true });
    await writeFile(afterPath, "after");

    const chapter = await library.openChapter("chapter-a");
    const withAfter = await library.updatePagesAfterInpainting(chapter.id, [
      { ...firstPage(chapter), inpaintedImagePath: afterPath },
    ]);
    const pageWithAfter = firstPage(withAfter);
    const undone = await library.setPageInpaintingResult(
      chapter.id,
      pageWithAfter.id,
      undefined,
      {
        retainedInpaintedArtifactPaths: [afterPath],
      },
    );

    expect(undone.pages[0]?.inpaintedImagePath).toBeUndefined();
    expect(existsSync(afterPath)).toBe(true);

    const redone = await library.setPageInpaintingResult(
      chapter.id,
      pageWithAfter.id,
      afterPath,
      {
        retainedInpaintedArtifactPaths: [afterPath],
      },
    );

    expect(redone.pages[0]?.inpaintedImagePath).toBe(afterPath);
    expect(existsSync(afterPath)).toBe(true);
  });

  it("relocates copied chapter image paths from a previous data root", async () => {
    const rootDir = await createTempLibrary();
    const oldRootDir = await createTempLibrary();
    const library = await loadLibrary(rootDir);
    await seedLibrary(rootDir, oldRootDir);

    const chapter = await library.openChapter("chapter-a");

    expect(chapter.pages[0]?.imagePath).toBe(
      join(
        rootDir,
        "works",
        "work-1",
        "chapters",
        "chapter-a",
        "pages",
        "001-page-a.png",
      ),
    );
    expect(chapter.pages[0]?.inpaintedImagePath).toBe(
      join(
        rootDir,
        "works",
        "work-1",
        "chapters",
        "chapter-a",
        "inpainted",
        "001-page-a-inpainted.png",
      ),
    );
  });

  it("retires a deleted page's saved mask in a fresh session while preserving other artifacts", async () => {
    const fixture = await createDeletionMaskFixture("owned");
    const library = await loadLibrary(fixture.rootDir);
    const after = await library.deletePage("chapter-a", "page-a");

    expect(after.pageOrder).toEqual(["page-b"]);
    expect(after.pages).toHaveLength(1);
    expect(after.pages[0]).toMatchObject(fixture.retainedPage);
    expect(existsSync(fixture.maskPath)).toBe(false);
    expect(existsSync(fixture.deletedPage.imagePath)).toBe(false);
    expect(existsSync(fixture.deletedPage.inpaintedImagePath ?? "")).toBe(
      false,
    );
    await expect(
      readFile(fixture.retainedPage.imagePath, "utf8"),
    ).resolves.toBe("image-b");
    await expect(
      readFile(fixture.retainedPage.inpaintedImagePath ?? "", "utf8"),
    ).resolves.toBe("inpainted-b");
    await expect(
      readFile(fixture.retainedPage.inpaintMaskPath ?? "", "utf8"),
    ).resolves.toBe("mask-b");
    await expect(readFile(fixture.historyMaskPath, "utf8")).resolves.toBe(
      "retained-history",
    );
    expect((await library.openChapter("chapter-a")).pageOrder).toEqual([
      "page-b",
    ]);
  });

  it.each(["missing-file", "no-reference"] as const)(
    "deletes a page whose mask has %s without touching the remaining page",
    async (variant) => {
      const fixture = await createDeletionMaskFixture(variant);
      const library = await loadLibrary(fixture.rootDir);
      const after = await library.deletePage("chapter-a", "page-a");
      expect(after.pageOrder).toEqual(["page-b"]);
      expect(after.pages[0]).toMatchObject(fixture.retainedPage);
      expect(existsSync(fixture.retainedPage.inpaintMaskPath ?? "")).toBe(true);
    },
  );

  it("preserves a mask still referenced by another page", async () => {
    const fixture = await createDeletionMaskFixture("shared");
    const library = await loadLibrary(fixture.rootDir);
    const after = await library.deletePage("chapter-a", "page-a");
    expect(after.pageOrder).toEqual(["page-b"]);
    expect(after.pages[0]?.inpaintMaskPath).toBe(fixture.maskPath);
    await expect(readFile(fixture.maskPath, "utf8")).resolves.toBe("mask-b");
  });

  it("preserves a mask reference outside the managed mask directory", async () => {
    const fixture = await createDeletionMaskFixture("unmanaged");
    const library = await loadLibrary(fixture.rootDir);
    const after = await library.deletePage("chapter-a", "page-a");
    expect(after.pageOrder).toEqual(["page-b"]);
    await expect(readFile(fixture.maskPath, "utf8")).resolves.toBe("mask-a");
  });

  it("rejects an external mask reference before deleting page metadata or files", async () => {
    const fixture = await createDeletionMaskFixture("owned");
    const externalRoot = await createTempLibrary();
    const externalMask = join(externalRoot, "external-mask.png");
    await writeFile(externalMask, "external-owner");
    fixture.deletedPage.inpaintMaskPath = externalMask;
    await writeJson(fixture.chapterPath, fixture.chapter);
    const before = await readFile(fixture.chapterPath, "utf8");
    const library = await loadLibrary(fixture.rootDir);

    await expect(library.deletePage("chapter-a", "page-a")).rejects.toThrow(
      "인페인팅 마스크 이미지 경로",
    );
    await expect(readFile(fixture.chapterPath, "utf8")).resolves.toBe(before);
    await expect(readFile(externalMask, "utf8")).resolves.toBe(
      "external-owner",
    );
    expect(existsSync(fixture.deletedPage.imagePath)).toBe(true);
    expect(existsSync(fixture.retainedPage.imagePath)).toBe(true);
  });
});

async function createDeletionMaskFixture(
  variant: "owned" | "missing-file" | "no-reference" | "shared" | "unmanaged",
) {
  const rootDir = await createTempLibrary();
  await seedLibrary(rootDir);
  const chapter = makeChapter(rootDir);
  const chapterDir = join(rootDir, "works", "work-1", "chapters", "chapter-a");
  const maskDir = join(chapterDir, "mask");
  await mkdir(maskDir, { recursive: true });
  const retainedPage = {
    ...firstPage(chapter),
    id: "page-b",
    name: "002.png",
    imagePath: join(chapterDir, "pages", "002-page-b.png"),
    inpaintedImagePath: join(chapterDir, "inpainted", "002-page-b.png"),
    inpaintMaskPath: join(maskDir, "page-b.png"),
  };
  const maskPath =
    variant === "shared"
      ? retainedPage.inpaintMaskPath
      : variant === "unmanaged"
        ? join(chapterDir, "pages", "unmanaged-mask.png")
        : join(maskDir, "page-a.png");
  const deletedPage = firstPage(chapter);
  if (variant !== "no-reference") deletedPage.inpaintMaskPath = maskPath;
  chapter.pages.push(retainedPage);
  chapter.pageOrder.push(retainedPage.id);
  const historyMaskPath = join(maskDir, "page-a-history.png");
  await Promise.all([
    writeFile(retainedPage.imagePath, "image-b"),
    writeFile(retainedPage.inpaintedImagePath, "inpainted-b"),
    writeFile(retainedPage.inpaintMaskPath, "mask-b"),
    writeFile(historyMaskPath, "retained-history"),
  ]);
  if (variant === "owned" || variant === "unmanaged")
    await writeFile(maskPath, "mask-a");
  const chapterPath = join(chapterDir, "chapter.json");
  await writeJson(chapterPath, chapter);
  return {
    rootDir,
    chapter,
    chapterPath,
    deletedPage,
    retainedPage,
    maskPath,
    historyMaskPath,
  };
}

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

async function loadLibrary(
  rootDir: string,
): Promise<typeof import("../src/main/library")> {
  vi.resetModules();
  vi.doMock("electron", () => ({
    app: {
      isPackaged: false,
    },
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
      logsDir: join(rootDir, "logs"),
      logFile: join(rootDir, "logs", "app.log"),
      runtimeDir: join(rootDir, "runtime"),
      toolsDir: join(rootDir, "tools"),
      llamaRuntimeDir: join(rootDir, "tools", "llama"),
      llamaServerPath: join(rootDir, "tools", "llama", "llama-server.exe"),
    }),
  }));
  return import("../src/main/library");
}

async function seedLibrary(
  rootDir: string,
  storedPathRoot = rootDir,
): Promise<void> {
  const work: LibraryWork = {
    id: "work-1",
    title: "원본 작품",
    chapterOrder: ["chapter-a"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  await mkdir(
    join(rootDir, "works", work.id, "chapters", "chapter-a", "pages"),
    { recursive: true },
  );
  await mkdir(
    join(rootDir, "works", work.id, "chapters", "chapter-a", "inpainted"),
    { recursive: true },
  );
  await writeJson(join(rootDir, "index.json"), { workOrder: [work.id] });
  await writeJson(join(rootDir, "works", work.id, "work.json"), work);
  await writeFile(
    join(
      rootDir,
      "works",
      work.id,
      "chapters",
      "chapter-a",
      "pages",
      "001-page-a.png",
    ),
    "image-a",
  );
  await writeFile(
    join(
      rootDir,
      "works",
      work.id,
      "chapters",
      "chapter-a",
      "inpainted",
      "001-page-a-inpainted.png",
    ),
    "inpainted-a",
  );
  await writeJson(
    join(rootDir, "works", work.id, "chapters", "chapter-a", "chapter.json"),
    makeChapter(storedPathRoot),
  );
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
        imagePath: join(
          rootDir,
          "works",
          "work-1",
          "chapters",
          "chapter-a",
          "pages",
          "001-page-a.png",
        ),
        inpaintedImagePath: join(
          rootDir,
          "works",
          "work-1",
          "chapters",
          "chapter-a",
          "inpainted",
          "001-page-a-inpainted.png",
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
