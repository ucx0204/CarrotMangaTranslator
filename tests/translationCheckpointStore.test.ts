import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChapterSnapshot,
  LibraryChapter,
  LibraryPageRecord,
  LibraryWork,
} from "../src/shared/libraryTypes";
import { createPageRevision } from "../src/shared/pageRevision";
import type { PreparedTranslationCheckpoint } from "../src/main/pipeline/preparedTranslationCheckpointContract";

const tempDirs: string[] = [];
const TS = "2026-01-01T00:00:00.000Z";

afterEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("translation checkpoint store", () => {
  it("publishes, validates, replaces, and removes one active checkpoint atomically", async () => {
    const root = await createLibrary();
    const library = await loadLibrary(root);
    const original = await library.openChapter("chapter-a");
    const page = requirePage(original, "page-a");
    const revision = createPageRevision(page);

    expect(
      await library.saveTranslationCheckpoint(
        original.id,
        makeCheckpoint(page, TS),
        revision,
      ),
    ).toBe(true);
    const firstSnapshot = await library.openChapter(original.id);
    const firstPage = requirePage(firstSnapshot, page.id);
    const firstMetadata = firstPage.translationCheckpoint;
    if (!firstMetadata) throw new Error("first checkpoint metadata missing");
    const chapterDir = chapterDirectory(root);
    const firstFile = resolve(chapterDir, firstMetadata.artifactPath);
    expect(JSON.parse(await readFile(firstFile, "utf8"))).toMatchObject({
      pageId: page.id,
      inputRevision: revision,
    });
    await expect(
      library.loadTranslationCheckpoint(chapterDir, firstPage),
    ).resolves.toMatchObject({ artifact: { pageId: page.id } });

    expect(
      await library.saveTranslationCheckpoint(
        original.id,
        makeCheckpoint(page, "2026-01-01T00:01:00.000Z"),
        revision,
      ),
    ).toBe(true);
    const secondPage = requirePage(
      await library.openChapter(original.id),
      page.id,
    );
    const secondMetadata = secondPage.translationCheckpoint;
    if (!secondMetadata)
      throw new Error("replacement checkpoint metadata missing");
    expect(secondMetadata.artifactPath).not.toBe(firstMetadata.artifactPath);
    await expect(readFile(firstFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await managedCheckpointDirectories(chapterDir)).toHaveLength(1);

    const finalPage: ChapterSnapshot["pages"][number] = {
      ...secondPage,
      analysisStatus: "completed",
    };
    expect(
      await library.updatePageAfterAnalysis(
        original.id,
        finalPage,
        [],
        "completed",
        undefined,
        revision,
      ),
    ).toBe(true);
    expect(
      requirePage(await library.openChapter(original.id), page.id)
        .translationCheckpoint,
    ).toBeUndefined();
    expect(await managedCheckpointDirectories(chapterDir)).toEqual([]);
  });

  it("rejects a revision conflict without replacing the previous checkpoint", async () => {
    const root = await createLibrary();
    const library = await loadLibrary(root);
    const snapshot = await library.openChapter("chapter-a");
    const page = requirePage(snapshot, "page-a");
    const revision = createPageRevision(page);
    await library.saveTranslationCheckpoint(
      snapshot.id,
      makeCheckpoint(page, TS),
      revision,
    );
    const before = requirePage(
      await library.openChapter(snapshot.id),
      page.id,
    ).translationCheckpoint;

    const chapter = await readChapter(root);
    const editedPage = chapter.pages[0];
    if (!editedPage) throw new Error("fixture page missing");
    chapter.pages[0] = {
      ...editedPage,
      blocks: [makeBlock("server-edit")],
    };
    await writeJson(chapterFile(root), chapter);

    expect(
      await library.saveTranslationCheckpoint(
        snapshot.id,
        makeCheckpoint(page, "2026-01-01T00:02:00.000Z"),
        revision,
      ),
    ).toBe(false);
    expect((await readChapter(root)).pages[0]?.translationCheckpoint).toEqual(
      before,
    );
    expect(
      await managedCheckpointDirectories(chapterDirectory(root)),
    ).toHaveLength(1);
  });

  it("keeps an approved checkpoint across cancellation and later model failure", async () => {
    const root = await createLibrary();
    const library = await loadLibrary(root);
    const snapshot = await library.openChapter("chapter-a");
    const page = requirePage(snapshot, "page-a");
    const revision = createPageRevision(page);
    await library.saveTranslationCheckpoint(
      snapshot.id,
      makeCheckpoint(page, TS),
      revision,
    );

    await library.markChapterPagesRunning(snapshot.id, [page.id]);
    await library.finalizeRunningPages(snapshot.id, [page.id], "idle");
    const afterCancel = requirePage(
      await library.openChapter(snapshot.id),
      page.id,
    );
    expect(afterCancel.translationCheckpoint).toBeDefined();

    expect(
      await library.updatePageAfterAnalysis(
        snapshot.id,
        afterCancel,
        ["model failed"],
        "failed",
        undefined,
        revision,
      ),
    ).toBe(true);
    expect(
      requirePage(await library.openChapter(snapshot.id), page.id)
        .translationCheckpoint,
    ).toBeDefined();
    expect(
      await managedCheckpointDirectories(chapterDirectory(root)),
    ).toHaveLength(1);
  });

  it("hides hash-mismatched and path-escaping checkpoints from opened snapshots", async () => {
    const root = await createLibrary();
    const library = await loadLibrary(root);
    const snapshot = await library.openChapter("chapter-a");
    const page = requirePage(snapshot, "page-a");
    const revision = createPageRevision(page);
    await library.saveTranslationCheckpoint(
      snapshot.id,
      makeCheckpoint(page, TS),
      revision,
    );
    const stored = requirePage(await library.openChapter(snapshot.id), page.id);
    const metadata = stored.translationCheckpoint;
    if (!metadata) throw new Error("checkpoint metadata missing");
    await writeFile(
      resolve(chapterDirectory(root), metadata.artifactPath),
      "tampered",
      "utf8",
    );

    expect(
      requirePage(await library.openChapter(snapshot.id), page.id)
        .translationCheckpoint,
    ).toBeUndefined();

    const chapter = await readChapter(root);
    const escapingPage = chapter.pages[0];
    if (!escapingPage) throw new Error("fixture page missing");
    chapter.pages[0] = {
      ...escapingPage,
      translationCheckpoint: {
        ...metadata,
        artifactPath: "../../outside/checkpoint.json",
      },
    };
    await writeJson(chapterFile(root), chapter);
    expect(
      requirePage(await library.openChapter(snapshot.id), page.id)
        .translationCheckpoint,
    ).toBeUndefined();

    await mkdir(join(chapterDirectory(root), ".translation-checkpoint-orphan"));
    const cleanup = await library.cleanupLibraryOrphans();
    expect(cleanup.checkpointDirsRemoved).toBe(2);
    expect(
      (await readChapter(root)).pages[0]?.translationCheckpoint,
    ).toBeUndefined();
    expect(await managedCheckpointDirectories(chapterDirectory(root))).toEqual(
      [],
    );
  });

  it("replaces rejected path metadata without following it", async () => {
    const root = await createLibrary();
    const library = await loadLibrary(root);
    const snapshot = await library.openChapter("chapter-a");
    const page = requirePage(snapshot, "page-a");
    const revision = createPageRevision(page);
    await library.saveTranslationCheckpoint(
      snapshot.id,
      makeCheckpoint(page, TS),
      revision,
    );

    const chapter = await readChapter(root);
    const storedPage = chapter.pages[0];
    if (!storedPage?.translationCheckpoint) {
      throw new Error("checkpoint fixture metadata missing");
    }
    chapter.pages[0] = {
      ...storedPage,
      translationCheckpoint: {
        ...storedPage.translationCheckpoint,
        artifactPath: "../../outside/checkpoint.json",
      },
    };
    await writeJson(chapterFile(root), chapter);

    await expect(
      library.saveTranslationCheckpoint(
        snapshot.id,
        makeCheckpoint(page, "2026-01-01T00:03:00.000Z"),
        revision,
      ),
    ).resolves.toBe(true);
    expect(
      requirePage(await library.openChapter(snapshot.id), page.id)
        .translationCheckpoint?.artifactPath,
    ).toMatch(/^\.translation-checkpoint-/);

    const cleanup = await library.cleanupLibraryOrphans();
    expect(cleanup.checkpointDirsRemoved).toBe(1);
    expect(
      await managedCheckpointDirectories(chapterDirectory(root)),
    ).toHaveLength(1);
  });

  it("removes managed checkpoint data with page and chapter deletion", async () => {
    const root = await createLibrary();
    const library = await loadLibrary(root);
    const snapshot = await library.openChapter("chapter-a");
    const pageA = requirePage(snapshot, "page-a");
    const pageB = requirePage(snapshot, "page-b");
    await library.saveTranslationCheckpoint(
      snapshot.id,
      makeCheckpoint(pageA, TS),
      createPageRevision(pageA),
    );
    await library.saveTranslationCheckpoint(
      snapshot.id,
      makeCheckpoint(pageB, "2026-01-01T00:01:00.000Z"),
      createPageRevision(pageB),
    );
    expect(
      await managedCheckpointDirectories(chapterDirectory(root)),
    ).toHaveLength(2);

    await library.deletePage(snapshot.id, pageA.id);
    expect(
      await managedCheckpointDirectories(chapterDirectory(root)),
    ).toHaveLength(1);

    await library.deleteChapter(snapshot.id);
    await expect(readdir(chapterDirectory(root))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects an oversized artifact before publishing metadata or files", async () => {
    const root = await createLibrary();
    const library = await loadLibrary(root);
    const snapshot = await library.openChapter("chapter-a");
    const page = requirePage(snapshot, "page-a");
    const checkpoint = makeCheckpoint(page, TS);
    if (checkpoint.prepared.kind !== "ready") {
      throw new Error("expected ready checkpoint fixture");
    }
    checkpoint.prepared.warnings = Array.from({ length: 1_000 }, () =>
      "x".repeat(9_000),
    );

    await expect(
      library.saveTranslationCheckpoint(
        snapshot.id,
        checkpoint,
        createPageRevision(page),
      ),
    ).rejects.toThrow(/허용 크기를 초과/);
    expect(
      (await readChapter(root)).pages[0]?.translationCheckpoint,
    ).toBeUndefined();
    expect(await managedCheckpointDirectories(chapterDirectory(root))).toEqual(
      [],
    );
  });
});

async function createLibrary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mgt-checkpoint-store-"));
  tempDirs.push(root);
  const work: LibraryWork = {
    id: "work-a",
    title: "Work",
    chapterOrder: ["chapter-a"],
    createdAt: TS,
    updatedAt: TS,
  };
  const pages = ["page-a", "page-b"].map((pageId) =>
    makePage(pageId, join(chapterDirectory(root), "pages", `${pageId}.png`)),
  );
  const chapter: LibraryChapter = {
    id: "chapter-a",
    workId: work.id,
    title: "Chapter",
    sourceKind: "images",
    status: "idle",
    pageOrder: pages.map((page) => page.id),
    pages,
    createdAt: TS,
    updatedAt: TS,
  };
  await mkdir(join(chapterDirectory(root), "pages"), { recursive: true });
  await writeJson(join(root, "index.json"), { workOrder: [work.id] });
  await writeJson(join(root, "works", work.id, "work.json"), work);
  await writeJson(chapterFile(root), chapter);
  return root;
}

async function loadLibrary(
  root: string,
): Promise<typeof import("../src/main/library")> {
  vi.resetModules();
  vi.doMock("electron", () => ({ app: { isPackaged: false } }));
  vi.doMock("../src/main/appPaths", () => ({
    getAppPaths: () => ({
      isPackaged: false,
      repoRoot: root,
      executableDir: root,
      resourcesDir: root,
      dataRoot: root,
      settingsPath: join(root, "settings.json"),
      libraryDir: root,
      logsDir: join(root, "logs"),
      logFile: join(root, "logs", "app.log"),
      runtimeDir: join(process.cwd(), "src", "main", "runtime"),
      toolsDir: join(root, "tools"),
      llamaRuntimeDir: join(root, "tools", "llama"),
      llamaServerPath: join(root, "tools", "llama", "llama-server.exe"),
    }),
  }));
  return import("../src/main/library");
}

function makeCheckpoint(
  page: Pick<LibraryPageRecord, "id"> &
    Parameters<typeof createPageRevision>[0],
  savedAt: string,
): PreparedTranslationCheckpoint {
  return {
    schemaVersion: 1,
    pipelineContractVersion: "whole-page-prepared-v1",
    pageId: page.id,
    inputRevision: createPageRevision(page),
    sourceLanguage: "ja",
    targetLanguage: "ko",
    blockMode: "auto",
    savedAt,
    translationDurationMs: 1200,
    prepared: {
      kind: "ready",
      resultKind: "completed",
      blocks: [],
      warnings: [],
      detail: "done",
    },
  };
}

function makePage(id: string, imagePath: string): LibraryPageRecord {
  return {
    id,
    name: `${id}.png`,
    imagePath,
    width: 1000,
    height: 1400,
    blocks: [],
    analysisStatus: "idle",
    createdAt: TS,
    updatedAt: TS,
  };
}

function makeBlock(id: string): LibraryPageRecord["blocks"][number] {
  return {
    id,
    type: "nonsolid",
    bbox: { x: 10, y: 10, w: 100, h: 80 },
    sourceText: "source",
    translatedText: "translated",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 20,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 1,
  };
}

function requirePage(chapter: ChapterSnapshot, pageId: string) {
  const page = chapter.pages.find((candidate) => candidate.id === pageId);
  if (!page) throw new Error(`Expected page ${pageId}`);
  return page;
}

async function readChapter(root: string): Promise<LibraryChapter> {
  return JSON.parse(
    await readFile(chapterFile(root), "utf8"),
  ) as LibraryChapter;
}

function chapterDirectory(root: string): string {
  return join(root, "works", "work-a", "chapters", "chapter-a");
}

function chapterFile(root: string): string {
  return join(chapterDirectory(root), "chapter.json");
}

async function managedCheckpointDirectories(root: string): Promise<string[]> {
  return (await readdir(root, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.startsWith(".translation-checkpoint-"),
    )
    .map((entry) => entry.name)
    .sort();
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
