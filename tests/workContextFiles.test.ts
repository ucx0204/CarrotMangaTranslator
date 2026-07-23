import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LibraryChapter, LibraryWork } from "../src/shared/libraryTypes";

const tempDirs: string[] = [];

describe("work context files", () => {
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

  it("returns defaults when files are missing and persists style guide/story memory", async () => {
    const rootDir = await createTempLibrary();
    const library = await loadLibrary(rootDir);
    await seedLibrary(rootDir);

    const defaultGuide = await library.getWorkStyleGuide("work-1");
    expect(defaultGuide.workId).toBe("work-1");
    expect(defaultGuide.glossary).toEqual([]);

    const savedGuide = await library.saveWorkStyleGuide({
      ...defaultGuide,
      glossary: [
        {
          id: "glossary-1",
          source: "魔王",
          target: "마왕",
          category: "term",
          enabled: true,
          createdAt: defaultGuide.createdAt,
          updatedAt: defaultGuide.updatedAt,
        },
      ],
    });
    expect(
      (await library.getWorkStyleGuide("work-1")).glossary[0]?.target,
    ).toBe(savedGuide.glossary[0]?.target);

    const defaultMemory = await library.getChapterStoryMemory("chapter-a");
    expect(defaultMemory.chapterId).toBe("chapter-a");
    expect(defaultMemory.pages).toEqual([]);

    const savedMemory = await library.saveChapterStoryMemory({
      ...defaultMemory,
      pages: [
        {
          pageId: "page-a",
          pageName: "001.png",
          pageIndex: 0,
          sourceDigest: "こんにちは",
          translatedDigest: "안녕",
          summary: "인사",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(
      (await library.getChapterStoryMemory("chapter-a")).pages[0]?.summary,
    ).toBe(savedMemory.pages[0]?.summary);
  });

  it("rejects excessive glossary entries and mismatched story memory locations", async () => {
    const rootDir = await createTempLibrary();
    const library = await loadLibrary(rootDir);
    await seedLibrary(rootDir);
    const guide = await library.getWorkStyleGuide("work-1");
    const entries = Array.from({ length: 1001 }, (_, index) => ({
      id: `glossary-${index}`,
      source: `源${index}`,
      target: `번역${index}`,
      category: "term" as const,
      enabled: true,
      createdAt: guide.createdAt,
      updatedAt: guide.updatedAt,
    }));

    await expect(
      library.saveWorkStyleGuide({ ...guide, glossary: entries }),
    ).rejects.toThrow(/style-guide|형식|glossary/);

    const memory = await library.getChapterStoryMemory("chapter-a");
    await expect(
      library.saveChapterStoryMemory({ ...memory, workId: "other-work" }),
    ).rejects.toThrow(/스토리 메모리/);
  });

  it("reindexes story memory on page reorder and removes deleted page memory", async () => {
    const rootDir = await createTempLibrary();
    const library = await loadLibrary(rootDir);
    await seedLibrary(rootDir);
    const memory = await library.getChapterStoryMemory("chapter-a");
    await library.saveChapterStoryMemory({
      ...memory,
      pages: ["page-a", "page-b", "page-c"].map((pageId, pageIndex) => ({
        pageId,
        pageName: `${String(pageIndex + 1).padStart(3, "0")}.png`,
        pageIndex,
        sourceDigest: `source-${pageId}`,
        translatedDigest: `translated-${pageId}`,
        summary: `summary-${pageId}`,
        updatedAt: "2026-01-01T00:00:00.000Z",
      })),
    });

    await library.reorderPages("chapter-a", ["page-c", "page-a", "page-b"]);
    expect(
      (await library.getChapterStoryMemory("chapter-a")).pages.map((page) => [
        page.pageId,
        page.pageIndex,
      ]),
    ).toEqual([
      ["page-c", 0],
      ["page-a", 1],
      ["page-b", 2],
    ]);

    await library.deletePage("chapter-a", "page-a");
    expect(
      (await library.getChapterStoryMemory("chapter-a")).pages.map((page) => [
        page.pageId,
        page.pageIndex,
      ]),
    ).toEqual([
      ["page-c", 0],
      ["page-b", 1],
    ]);
  });

  it("resets terms and story memory for every chapter without changing pages or rules", async () => {
    const rootDir = await createTempLibrary();
    const library = await loadLibrary(rootDir);
    await seedLibrary(rootDir, ["chapter-a", "chapter-b"]);
    const guide = await library.getWorkStyleGuide("work-1");
    const customRules = {
      honorifics: "preserve" as const,
      sfxMode: "note" as const,
      defaultTone: "literal" as const,
    };
    await library.saveWorkStyleGuide({
      ...guide,
      rules: customRules,
      glossary: [
        {
          id: "term-1",
          source: "魔王",
          target: "마왕",
          category: "term",
          enabled: true,
          createdAt: guide.createdAt,
          updatedAt: guide.updatedAt,
        },
      ],
      characters: [
        {
          id: "character-1",
          displayName: "마왕",
          sourceNames: ["魔王"],
          targetName: "마왕",
          speechStyle: "rough",
          note: "용사와 적대 관계",
          enabled: true,
          createdAt: guide.createdAt,
          updatedAt: guide.updatedAt,
        },
      ],
    });
    for (const [chapterId, pageId] of [
      ["chapter-a", "page-a"],
      ["chapter-b", "chapter-b-page-a"],
    ] as const) {
      const memory = await library.getChapterStoryMemory(chapterId);
      await library.saveChapterStoryMemory({
        ...memory,
        aiAnalyzedAt: "2026-01-02T00:00:00.000Z",
        pages: [
          {
            pageId,
            pageName: "001.png",
            pageIndex: 0,
            sourceDigest: "source",
            translatedDigest: "translated",
            summary: "story",
            visualSummary: "visual",
            visualSummarySource: "ai",
            glossaryEntryIds: ["term-1"],
            characterIds: ["character-1"],
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        ],
      });
    }
    const chapterBeforeReset = await library.openChapter("chapter-a");

    const result = await library.resetWorkContext("chapter-a");

    expect(result.resetChapterCount).toBe(2);
    expect(result.storyMemory).toMatchObject({
      chapterId: "chapter-a",
      pages: [],
    });
    const resetGuide = await library.getWorkStyleGuide("work-1");
    expect(resetGuide.glossary).toEqual([]);
    expect(resetGuide.characters).toEqual([]);
    expect(resetGuide.rules).toEqual(customRules);
    for (const chapterId of ["chapter-a", "chapter-b"]) {
      const memory = await library.getChapterStoryMemory(chapterId);
      expect(memory.pages).toEqual([]);
      expect(memory.aiAnalyzedAt).toBeUndefined();
    }
    expect(await library.openChapter("chapter-a")).toEqual(chapterBeforeReset);

    await expect(library.resetWorkContext("chapter-a")).resolves.toMatchObject({
      resetChapterCount: 2,
      storyMemory: { pages: [] },
    });
  });

  it("wraps malformed context JSON with the file name", async () => {
    const rootDir = await createTempLibrary();
    const library = await loadLibrary(rootDir);
    await seedLibrary(rootDir);
    await writeFile(
      join(rootDir, "works", "work-1", "style-guide.json"),
      "{ broken",
      "utf8",
    );

    await expect(library.getWorkStyleGuide("work-1")).rejects.toThrow(
      /style-guide\.json/,
    );
  });
});

async function createTempLibrary(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "manga-context-files-"));
  tempDirs.push(rootDir);
  return rootDir;
}

async function loadLibrary(
  rootDir: string,
): Promise<typeof import("../src/main/library")> {
  vi.resetModules();
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
  chapterIds: string[] = ["chapter-a"],
): Promise<void> {
  const work: LibraryWork = {
    id: "work-1",
    title: "원본 작품",
    chapterOrder: chapterIds,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  await writeJson(join(rootDir, "index.json"), { workOrder: ["work-1"] });
  await writeJson(join(rootDir, "works", "work-1", "work.json"), work);
  for (const [chapterIndex, chapterId] of chapterIds.entries()) {
    const pageIds =
      chapterId === "chapter-a"
        ? ["page-a", "page-b", "page-c"]
        : [`${chapterId}-page-a`];
    const chapter: LibraryChapter = {
      id: chapterId,
      workId: "work-1",
      title: `${chapterIndex + 1}화`,
      sourceKind: "folder",
      status: "completed",
      pageOrder: pageIds,
      pages: pageIds.map((id, index) => ({
        id,
        name: `${String(index + 1).padStart(3, "0")}.png`,
        imagePath: join(
          rootDir,
          "works",
          "work-1",
          "chapters",
          chapterId,
          "pages",
          `${String(index + 1).padStart(3, "0")}.png`,
        ),
        width: 100,
        height: 120,
        blocks: [],
        analysisStatus: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      })),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await mkdir(
      join(rootDir, "works", "work-1", "chapters", chapterId, "pages"),
      { recursive: true },
    );
    await Promise.all(
      chapter.pages.map((page) => writeFile(page.imagePath, "image", "utf8")),
    );
    await writeJson(
      join(rootDir, "works", "work-1", "chapters", chapterId, "chapter.json"),
      chapter,
    );
  }
}

async function writeJson(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
