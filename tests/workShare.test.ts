import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LibraryChapter, LibraryWork } from "../src/shared/types";

type AdmZipInstance = {
  addFile: (entryName: string, content: Buffer | string) => void;
  getEntries: () => Array<{ entryName: string; isDirectory: boolean; getData: () => Buffer }>;
  writeZip: (targetPath: string) => void;
};

const AdmZip = require("adm-zip") as { new (archivePath?: string): AdmZipInstance };

const tempDirs: string[] = [];

describe("work share packages", () => {
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

  it("exports only selected chapters with relative image paths", async () => {
    const rootDir = await createTempLibrary();
    const sharePath = join(rootDir, "selected.mgtshare");
    const library = await loadLibrary(rootDir);
    await seedLibrary(rootDir);

    const result = await library.exportWorkShareToFile({
      workId: "work-1",
      chapterIds: ["chapter-a"],
      outputPath: sharePath
    });

    expect(result.chapterCount).toBe(1);
    expect(result.pageCount).toBe(1);

    const zip = new AdmZip(sharePath);
    const entryNames = zip.getEntries().map((entry) => entry.entryName.replace(/\\/g, "/"));
    expect(entryNames).toContain("manifest.json");
    expect(entryNames).toContain("chapters/chapter-a/chapter.json");
    expect(entryNames.some((entryName) => entryName.includes("chapter-b"))).toBe(false);
    expect(entryNames.some((entryName) => entryName.includes("runs/"))).toBe(false);

    const chapterEntry = zip.getEntries().find((entry) => entry.entryName.replace(/\\/g, "/") === "chapters/chapter-a/chapter.json");
    const chapter = JSON.parse(chapterEntry!.getData().toString("utf8")) as LibraryChapter;
    expect(chapter.pages[0]?.imagePath).toMatch(/^chapters\/chapter-a\/pages\//);
    expect(chapter.pages[0]?.imagePath).not.toMatch(/^[A-Za-z]:/);
  });

  it("imports shared chapters as new ids and preserves blocks", async () => {
    const rootDir = await createTempLibrary();
    const sharePath = join(rootDir, "import-new.mgtshare");
    const library = await loadLibrary(rootDir);
    await seedLibrary(rootDir);
    await library.exportWorkShareToFile({
      workId: "work-1",
      chapterIds: ["chapter-a"],
      outputPath: sharePath
    });

    const result = await library.importWorkShare({
      packagePath: sharePath,
      target: { mode: "new", title: "가져온 작품" },
      entries: [{ source: "package", packageChapterId: "chapter-a", title: "고화질 1화" }]
    });

    expect(result.workId).not.toBe("work-1");
    expect(result.chapterIds[0]).not.toBe("chapter-a");
    expect(result.openedChapter?.title).toBe("고화질 1화");
    expect(result.openedChapter?.pages[0]?.id).not.toBe("page-a");
    expect(result.openedChapter?.pages[0]?.blocks[0]?.id).not.toBe("block-a");
    expect(result.openedChapter?.pages[0]?.blocks[0]?.translatedText).toBe("안녕");
    expect(existsSync(result.openedChapter?.pages[0]?.imagePath ?? "")).toBe(true);
  });

  it("merges into an existing work in final order and deletes omitted existing chapters", async () => {
    const rootDir = await createTempLibrary();
    const sharePath = join(rootDir, "merge.mgtshare");
    const library = await loadLibrary(rootDir);
    await seedLibrary(rootDir);
    await library.exportWorkShareToFile({
      workId: "work-1",
      chapterIds: ["chapter-a"],
      outputPath: sharePath
    });

    const result = await library.importWorkShare({
      packagePath: sharePath,
      target: { mode: "existing", workId: "work-1" },
      entries: [
        { source: "existing", chapterId: "chapter-b", title: "기존 유지" },
        { source: "package", packageChapterId: "chapter-a", title: "교체본" }
      ]
    });

    const index = await library.listLibrary();
    const work = index.works.find((candidate) => candidate.id === "work-1");
    expect(work?.chapterOrder).toEqual(result.chapterIds);
    expect(work?.chapters.map((chapter) => chapter.title)).toEqual(["기존 유지", "교체본"]);
    expect(result.chapterIds[0]).toBe("chapter-b");
    expect(result.chapterIds[1]).not.toBe("chapter-a");
    expect(existsSync(join(rootDir, "works", "work-1", "chapters", "chapter-a"))).toBe(false);
  });

  it("rejects traversal paths in share zips", async () => {
    const rootDir = await createTempLibrary();
    const sharePath = join(rootDir, "bad.mgtshare");
    const library = await loadLibrary(rootDir);
    const zip = new AdmZip();
    zip.addFile("manifest.json", JSON.stringify({
      format: "manga-gemma-translator-share",
      version: 1,
      exportedAt: new Date().toISOString(),
      work: { id: "bad-work", title: "Bad" },
      chapterOrder: ["chapter-a"]
    }));
    zip.addFile("chapters/chapter-a/chapter.json", JSON.stringify({
      id: "chapter-a",
      workId: "bad-work",
      title: "Bad",
      sourceKind: "folder",
      status: "idle",
      pageOrder: ["page-a"],
      pages: [
        {
          id: "page-a",
          name: "001.png",
          imagePath: "../evil.png",
          width: 1,
          height: 1,
          blocks: [],
          analysisStatus: "idle",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }));
    zip.addFile("../evil.png", "evil");
    zip.writeZip(sharePath);

    await expect(library.previewWorkShareImport(sharePath)).rejects.toThrow(/안전하지 않은 경로|이미지 경로/);
  });

  it("does not leave an empty work when import creation has no selected chapters", async () => {
    const rootDir = await createTempLibrary();
    const library = await loadLibrary(rootDir);
    await writeFile(join(rootDir, "001.png"), "image");

    await expect(
      library.createImport({
        preview: {
          mode: "single",
          sourceKind: "images",
          suggestedWorkTitle: "새 작품",
          chapters: [
            {
              draftId: "draft-a",
              title: "1화",
              sourceKind: "images",
              pages: [{ name: "001.png", sourceKind: "file", sourcePath: join(rootDir, "001.png") }]
            }
          ]
        },
        target: { mode: "new", title: "새 작품" },
        selections: [{ draftId: "draft-a", title: "1화", enabled: false }]
      })
    ).rejects.toThrow(/생성할 화/);

    const index = await library.listLibrary();
    expect(index.works).toHaveLength(0);
  });

  it("rolls back a new work import when a later chapter draft fails", async () => {
    const rootDir = await createTempLibrary();
    const library = await loadLibrary(rootDir);
    const goodImagePath = join(rootDir, "001.png");
    await writeFile(goodImagePath, "image");

    await expect(
      library.createImport({
        preview: {
          mode: "batch",
          sourceKind: "folder",
          suggestedWorkTitle: "실패할 작품",
          chapters: [
            {
              draftId: "draft-a",
              title: "1화",
              sourceKind: "folder",
              pages: [{ name: "001.png", sourceKind: "file", sourcePath: goodImagePath }]
            },
            {
              draftId: "draft-b",
              title: "2화",
              sourceKind: "folder",
              pages: [{ name: "missing.png", sourceKind: "file", sourcePath: join(rootDir, "missing.png") }]
            }
          ]
        },
        target: { mode: "new", title: "실패할 작품" },
        selections: [
          { draftId: "draft-a", title: "1화", enabled: true },
          { draftId: "draft-b", title: "2화", enabled: true }
        ]
      })
    ).rejects.toThrow();

    const index = await library.listLibrary();
    expect(index.works).toHaveLength(0);
  });

  it("does not append partial chapters to an existing work when import creation fails", async () => {
    const rootDir = await createTempLibrary();
    const library = await loadLibrary(rootDir);
    await seedLibrary(rootDir);
    const goodImagePath = join(rootDir, "001.png");
    await writeFile(goodImagePath, "image");

    await expect(
      library.createImport({
        preview: {
          mode: "batch",
          sourceKind: "folder",
          suggestedWorkTitle: "추가 실패",
          chapters: [
            {
              draftId: "draft-a",
              title: "3화",
              sourceKind: "folder",
              pages: [{ name: "001.png", sourceKind: "file", sourcePath: goodImagePath }]
            },
            {
              draftId: "draft-b",
              title: "4화",
              sourceKind: "folder",
              pages: [{ name: "missing.png", sourceKind: "file", sourcePath: join(rootDir, "missing.png") }]
            }
          ]
        },
        target: { mode: "existing", workId: "work-1" },
        selections: [
          { draftId: "draft-a", title: "3화", enabled: true },
          { draftId: "draft-b", title: "4화", enabled: true }
        ]
      })
    ).rejects.toThrow();

    const index = await library.listLibrary();
    const work = index.works.find((candidate) => candidate.id === "work-1");
    expect(work?.chapterOrder).toEqual(["chapter-a", "chapter-b"]);

    const chapterDirs = await readdir(join(rootDir, "works", "work-1", "chapters"));
    expect(chapterDirs.sort()).toEqual(["chapter-a", "chapter-b"]);
  });

  it("cleans stale work and chapter directories without touching indexed data", async () => {
    const rootDir = await createTempLibrary();
    const library = await loadLibrary(rootDir);
    await seedLibrary(rootDir);
    await writeJson(join(rootDir, "index.json"), { workOrder: ["work-1", "missing-work"] });
    await mkdir(join(rootDir, "works", "orphan-work"), { recursive: true });
    await mkdir(join(rootDir, "works", "work-1", "chapters", "orphan-chapter"), { recursive: true });

    const result = await library.cleanupLibraryOrphans();

    expect(result.missingWorkReferencesRemoved).toBe(1);
    expect(result.workDirsRemoved).toBe(1);
    expect(result.chapterDirsRemoved).toBe(1);
    expect(existsSync(join(rootDir, "works", "orphan-work"))).toBe(false);
    expect(existsSync(join(rootDir, "works", "work-1", "chapters", "orphan-chapter"))).toBe(false);

    const index = await library.listLibrary();
    expect(index.workOrder).toEqual(["work-1"]);
    expect(index.works[0]?.chapterOrder).toEqual(["chapter-a", "chapter-b"]);
  });

  it("rejects saving a chapter snapshot under a forged work id", async () => {
    const rootDir = await createTempLibrary();
    const library = await loadLibrary(rootDir);
    await seedLibrary(rootDir);
    const chapter = await library.openChapter("chapter-a");

    await expect(library.saveChapterSnapshot({ ...chapter, workId: "work-forged" })).rejects.toThrow(/보관함 위치/);
  });
});

async function createTempLibrary(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "manga-work-share-"));
  tempDirs.push(rootDir);
  return rootDir;
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

async function seedLibrary(rootDir: string): Promise<void> {
  const work: LibraryWork = {
    id: "work-1",
    title: "원본 작품",
    chapterOrder: ["chapter-a", "chapter-b"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  await mkdir(join(rootDir, "works", work.id, "chapters", "chapter-a", "pages"), { recursive: true });
  await mkdir(join(rootDir, "works", work.id, "chapters", "chapter-b", "pages"), { recursive: true });
  await mkdir(join(rootDir, "works", work.id, "chapters", "chapter-a", "runs", "run-1"), { recursive: true });
  await writeJson(join(rootDir, "index.json"), { workOrder: [work.id] });
  await writeJson(join(rootDir, "works", work.id, "work.json"), work);
  await writeFile(join(rootDir, "works", work.id, "chapters", "chapter-a", "pages", "001-page-a.png"), "image-a");
  await writeFile(join(rootDir, "works", work.id, "chapters", "chapter-b", "pages", "001-page-b.png"), "image-b");
  await writeJson(join(rootDir, "works", work.id, "chapters", "chapter-a", "chapter.json"), makeChapter(rootDir, "chapter-a", "1화", "page-a", "block-a"));
  await writeJson(join(rootDir, "works", work.id, "chapters", "chapter-b", "chapter.json"), makeChapter(rootDir, "chapter-b", "2화", "page-b", "block-b"));
  await writeFile(join(rootDir, "works", work.id, "chapters", "chapter-a", "runs", "run-1", "debug.txt"), "skip");
}

function makeChapter(rootDir: string, chapterId: string, title: string, pageId: string, blockId: string): LibraryChapter {
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
        imagePath: join(rootDir, "works", "work-1", "chapters", chapterId, "pages", `001-${pageId}.png`),
        width: 100,
        height: 120,
        blocks: [
          {
            id: blockId,
            type: "nonsolid",
            bbox: { x: 10, y: 10, w: 100, h: 100 },
            bboxSpace: "normalized_1000",
            sourceText: "こんにちは",
            translatedText: "안녕",
            confidence: 0.95,
            sourceDirection: "vertical",
            renderDirection: "vertical",
            fontSizePx: 18,
            lineHeight: 1.2,
            textAlign: "center",
            textColor: "#111111",
            backgroundColor: "#ffffff",
            opacity: 0.8,
            autoFitText: true
          }
        ],
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
