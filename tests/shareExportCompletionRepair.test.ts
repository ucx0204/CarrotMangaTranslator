import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  LibraryChapter,
  LibraryWork,
  TranslationCompletionReceipt,
} from "../src/shared/libraryTypes";
import { makePngImage } from "./helpers/imageFixtures";
import { buildMaterializedSharedPage } from "../src/main/libraryStore/shareImportPageRecord";

type AdmZipInstance = {
  getEntries: () => Array<{
    entryName: string;
    getData: () => Buffer;
  }>;
};

const AdmZip = require("adm-zip") as {
  new (archivePath: string): AdmZipInstance;
};

const tempDirs: string[] = [];

describe("share export completion repair", () => {
  afterEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  it("repairs a stale pending receipt only in exported metadata", async () => {
    const rootDir = await createLibraryWithReceipt(
      receipt("pending", ["legacy-old-b"]),
    );
    const chapterPath = localChapterPath(rootDir);
    const before = await readFile(chapterPath, "utf8");
    const sharePath = join(rootDir, "pending.mgtshare");
    const library = await loadLibrary(rootDir);

    await library.exportWorkShareToFile({
      workId: "work-1",
      chapterIds: ["chapter-a"],
      outputPath: sharePath,
    });

    expect(
      readPackageChapter(sharePath).pages[0]?.translationCompletion,
    ).toEqual({
      workflow: "erase-original",
      status: "pending",
    });
    expect(await readFile(chapterPath, "utf8")).toBe(before);
  });

  it("keeps completed status while clearing stale exported ids", async () => {
    const rootDir = await createLibraryWithReceipt(
      receipt("completed", ["legacy-old-b"]),
    );
    const sharePath = join(rootDir, "completed.mgtshare");
    const library = await loadLibrary(rootDir);

    await library.exportWorkShareToFile({
      workId: "work-1",
      chapterIds: ["chapter-a"],
      outputPath: sharePath,
    });

    expect(
      readPackageChapter(sharePath).pages[0]?.translationCompletion,
    ).toEqual({
      workflow: "erase-original",
      status: "completed",
    });
  });

  it("preserves a valid local receipt and package version 1", async () => {
    const rootDir = await createLibraryWithReceipt(
      receipt("failed", ["current-b"]),
    );
    const sharePath = join(rootDir, "valid.mgtshare");
    const library = await loadLibrary(rootDir);

    await library.exportWorkShareToFile({
      workId: "work-1",
      chapterIds: ["chapter-a"],
      outputPath: sharePath,
    });

    expect(
      readPackageChapter(sharePath).pages[0]?.translationCompletion,
    ).toEqual(receipt("failed", ["current-b"]));
    expect(
      readPackageChapter(sharePath).pages[0]?.inpaintMaskPath,
    ).toBeUndefined();
    expect(
      readPackageChapter(sharePath).pages[0]?.maskProvenance,
    ).toBeUndefined();
    const manifest = readJsonEntry<{ version: number }>(
      sharePath,
      "manifest.json",
    );
    expect(manifest.version).toBe(1);
  });

  it("keeps checkpoint and font continuity internals out of share export and import", async () => {
    const rootDir = await createLibraryWithReceipt(undefined);
    const chapter = JSON.parse(
      await readFile(localChapterPath(rootDir), "utf8"),
    ) as LibraryChapter;
    const page = chapter.pages[0];
    if (!page) throw new Error("fixture page missing");
    page.translationCheckpoint = {
      schemaVersion: 1,
      pipelineContractVersion: "whole-page-prepared-v1",
      artifactPath: ".translation-checkpoint-test/checkpoint.json",
      sha256: "a".repeat(64),
      byteSize: 128,
      inputRevision: "page-v1:abc",
      sourceLanguage: "ja",
      targetLanguage: "ko",
      blockMode: "auto",
      savedAt: "2026-01-01T00:00:00.000Z",
    };
    const firstBlock = page.blocks[0];
    if (!firstBlock) throw new Error("fixture block missing");
    page.fontContinuity = makeFontContinuity(page.id, firstBlock.id);
    await writeJson(localChapterPath(rootDir), chapter);
    const sharePath = join(rootDir, "internal-state.mgtshare");
    const library = await loadLibrary(rootDir);

    await library.exportWorkShareToFile({
      workId: "work-1",
      chapterIds: ["chapter-a"],
      outputPath: sharePath,
    });

    const exportedPage = readPackageChapter(sharePath).pages[0];
    expect(exportedPage?.translationCheckpoint).toBeUndefined();
    expect(exportedPage?.fontContinuity).toBeUndefined();

    const imported = buildMaterializedSharedPage({
      packagePage: page,
      pageId: "imported-page",
      imagePath: "C:/imported.png",
      width: page.width,
      height: page.height,
      now: "2026-01-02T00:00:00.000Z",
    });
    expect(imported.translationCheckpoint).toBeUndefined();
    expect(imported.fontContinuity).toBeUndefined();
  });

  it("rejects duplicate local block ids without leaving a target archive", async () => {
    const rootDir = await createLibraryWithReceipt(undefined, true);
    const sharePath = join(rootDir, "duplicate.mgtshare");
    const library = await loadLibrary(rootDir);

    await expect(
      library.exportWorkShareToFile({
        workId: "work-1",
        chapterIds: ["chapter-a"],
        outputPath: sharePath,
      }),
    ).rejects.toThrow(/블록 ID|block ID/i);

    expect(existsSync(sharePath)).toBe(false);
  });
});

function receipt(
  status: TranslationCompletionReceipt["status"],
  erasedBlockIds: readonly string[],
): TranslationCompletionReceipt {
  return {
    workflow: "erase-original",
    status,
    erasedBlockIds,
  };
}

async function createLibraryWithReceipt(
  translationCompletion: TranslationCompletionReceipt | undefined,
  duplicateBlocks = false,
): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "manga-share-repair-"));
  tempDirs.push(rootDir);
  const work: LibraryWork = {
    id: "work-1",
    title: "Work",
    chapterOrder: ["chapter-a"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const pagesDir = join(
    rootDir,
    "works",
    work.id,
    "chapters",
    "chapter-a",
    "pages",
  );
  await mkdir(pagesDir, { recursive: true });
  await writeJson(join(rootDir, "index.json"), { workOrder: [work.id] });
  await writeJson(join(rootDir, "works", work.id, "work.json"), work);
  await writeFile(join(pagesDir, "001-page-a.png"), makePngImage(100, 120));

  const blocks = [makeBlock("current-a"), makeBlock("current-b")];
  if (duplicateBlocks) blocks[1] = makeBlock("current-a");
  const chapter: LibraryChapter = {
    id: "chapter-a",
    workId: work.id,
    title: "Chapter",
    sourceKind: "folder",
    status: "completed",
    pageOrder: ["page-a"],
    pages: [
      {
        id: "page-a",
        name: "page.png",
        imagePath: join(pagesDir, "001-page-a.png"),
        inpaintMaskPath: join(pagesDir, "..", "mask", "001-page-a-mask.png"),
        maskProvenance: "actual-mask",
        width: 100,
        height: 120,
        blocks,
        analysisStatus: "completed",
        translationCompletion,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  await writeJson(localChapterPath(rootDir), chapter);
  return rootDir;
}

function makeBlock(
  id: string,
): LibraryChapter["pages"][number]["blocks"][number] {
  return {
    id,
    type: "nonsolid",
    bbox: { x: 10, y: 10, w: 100, h: 100 },
    sourceText: "source",
    translatedText: "translated",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 18,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 1,
  };
}

function makeFontContinuity(pageId: string, blockId: string) {
  return {
    schemaVersion: 1 as const,
    runtimeContractVersion: "font-matching-continuity-v1" as const,
    observations: [
      {
        pageId,
        blockId,
        role: "dialogue" as const,
        selectedFontId: "font-a",
        confidence: 0.95,
        orientation: "horizontal" as const,
        sourceStyle: {
          serifness: 0.1,
          weight: 0.5,
          width: 0.5,
          roundness: 0.4,
          strokeContrast: 0.3,
          handwritten: 0.1,
          angularity: 0.2,
          irregularity: 0.1,
          slant: 0.1,
          energy: 0.5,
          unknownFields: [],
        },
        modelVersion: "test-v1",
        candidateOrderSha256: "b".repeat(64),
      },
    ],
    savedAt: "2026-01-01T00:00:00.000Z",
  };
}

function localChapterPath(rootDir: string): string {
  return join(
    rootDir,
    "works",
    "work-1",
    "chapters",
    "chapter-a",
    "chapter.json",
  );
}

function readPackageChapter(sharePath: string): LibraryChapter {
  return readJsonEntry<LibraryChapter>(
    sharePath,
    "chapters/chapter-a/chapter.json",
  );
}

function readJsonEntry<T>(sharePath: string, entryName: string): T {
  const zip = new AdmZip(sharePath);
  const entry = zip
    .getEntries()
    .find((candidate) => candidate.entryName.replace(/\\/g, "/") === entryName);
  if (!entry) throw new Error(`Expected zip entry: ${entryName}`);
  return JSON.parse(entry.getData().toString("utf8")) as T;
}

async function loadLibrary(
  rootDir: string,
): Promise<typeof import("../src/main/library")> {
  vi.resetModules();
  vi.doMock("electron", () => ({
    app: { isPackaged: false },
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
      runtimeDir: join(process.cwd(), "src", "main", "runtime"),
      toolsDir: join(rootDir, "tools"),
      llamaRuntimeDir: join(rootDir, "tools", "llama"),
      llamaServerPath: join(rootDir, "tools", "llama", "llama-server.exe"),
    }),
  }));
  return import("../src/main/library");
}

async function writeJson(path: string, payload: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
