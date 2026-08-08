import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LibraryChapter, LibraryWork } from "../src/shared/libraryTypes";
import type { LibraryTransactionCrashPoint } from "../src/main/libraryStore/libraryTransaction";
import { makePngImage } from "./helpers/imageFixtures";

const tempDirs: string[] = [];

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

describe("share import transaction recovery", () => {
  it("does not publish a partial new shared work after a pre-commit crash", async () => {
    const fixture = await createShareFixture();
    const { library, transaction, recovery } = await loadModules(fixture.root);
    await library.exportWorkShareToFile({
      workId: "work-1",
      chapterIds: ["chapter-a"],
      outputPath: fixture.sharePath,
    });
    const restoreInjector = crashOnceAt(transaction, "after-publish-step");
    try {
      await expect(
        library.importWorkShare(newWorkRequest(fixture.sharePath)),
      ).rejects.toBeInstanceOf(transaction.SimulatedLibraryTransactionCrash);
    } finally {
      restoreInjector();
    }

    await recovery.recoverLibraryTransactions();
    const index = await library.listLibrary();
    expect(index.workOrder).toEqual(["work-1"]);
    expect(index.works).toHaveLength(1);
  });

  it("keeps a complete new shared work, including final image paths, after the commit point", async () => {
    const fixture = await createShareFixture();
    const { library, transaction, recovery } = await loadModules(fixture.root);
    await library.exportWorkShareToFile({
      workId: "work-1",
      chapterIds: ["chapter-a"],
      outputPath: fixture.sharePath,
    });
    const restoreInjector = crashOnceAt(transaction, "after-commit-point");
    try {
      await expect(
        library.importWorkShare(newWorkRequest(fixture.sharePath)),
      ).rejects.toBeInstanceOf(transaction.SimulatedLibraryTransactionCrash);
    } finally {
      restoreInjector();
    }

    await recovery.recoverLibraryTransactions();
    const index = await library.listLibrary();
    expect(index.workOrder).toHaveLength(2);
    const importedWork = index.works.find((work) => work.id !== "work-1");
    const importedChapterId = importedWork?.chapterOrder[0];
    if (!importedWork || !importedChapterId) {
      throw new Error("Expected imported work and chapter");
    }
    const importedChapter = await library.openChapter(importedChapterId);
    const imagePath = importedChapter.pages[0]?.imagePath;
    expect(imagePath).toContain(join("works", importedWork.id, "chapters"));
    expect(imagePath).not.toContain(".transactions");
    expect(existsSync(imagePath ?? "")).toBe(true);
    expect(
      existsSync(
        join(fixture.root, "works", importedWork.id, "style-guide.json"),
      ),
    ).toBe(true);
  });

  it("restores original titles, order, and directories after an existing-work share import crashes before commit", async () => {
    const fixture = await createShareFixture();
    const { library, transaction, recovery } = await loadModules(fixture.root);
    await library.exportWorkShareToFile({
      workId: "work-1",
      chapterIds: ["chapter-a"],
      outputPath: fixture.sharePath,
    });
    const restoreInjector = crashOnceAt(transaction, "after-retire-step");
    try {
      await expect(
        library.importWorkShare(existingWorkRequest(fixture.sharePath)),
      ).rejects.toBeInstanceOf(transaction.SimulatedLibraryTransactionCrash);
    } finally {
      restoreInjector();
    }

    await recovery.recoverLibraryTransactions();
    const index = await library.listLibrary();
    expect(index.works[0]?.chapterOrder).toEqual(["chapter-a"]);
    const chapter = await library.openChapter("chapter-a");
    expect(chapter.title).toBe("원본 1화");
    expect(
      existsSync(
        join(fixture.root, "works", "work-1", "chapters", "chapter-a"),
      ),
    ).toBe(true);
  });

  it("keeps the fully replaced existing-work share state after commit", async () => {
    const fixture = await createShareFixture();
    const { library, transaction, recovery } = await loadModules(fixture.root);
    await library.exportWorkShareToFile({
      workId: "work-1",
      chapterIds: ["chapter-a"],
      outputPath: fixture.sharePath,
    });
    const restoreInjector = crashOnceAt(transaction, "after-commit-point");
    try {
      await expect(
        library.importWorkShare(existingWorkRequest(fixture.sharePath)),
      ).rejects.toBeInstanceOf(transaction.SimulatedLibraryTransactionCrash);
    } finally {
      restoreInjector();
    }

    await recovery.recoverLibraryTransactions();
    const index = await library.listLibrary();
    const chapterIds = index.works[0]?.chapterOrder ?? [];
    expect(chapterIds).toHaveLength(1);
    expect(chapterIds).not.toContain("chapter-a");
    const chapter = await library.openChapter(chapterIds[0] ?? "");
    expect(chapter.title).toBe("교체 1화");
    expect(
      existsSync(
        join(fixture.root, "works", "work-1", "chapters", "chapter-a"),
      ),
    ).toBe(false);
  });
});

async function createShareFixture(): Promise<{
  root: string;
  sharePath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "share-transaction-recovery-"));
  tempDirs.push(root);
  const chapterRoot = join(root, "works", "work-1", "chapters", "chapter-a");
  const pagesRoot = join(chapterRoot, "pages");
  await mkdir(pagesRoot, { recursive: true });
  await mkdir(join(root, "logs"), { recursive: true });
  const imagePath = join(pagesRoot, "001-page-a.png");
  const work: LibraryWork = {
    id: "work-1",
    title: "원본 작품",
    chapterOrder: ["chapter-a"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const chapter: LibraryChapter = {
    id: "chapter-a",
    workId: "work-1",
    title: "원본 1화",
    sourceKind: "folder",
    status: "completed",
    pageOrder: ["page-a"],
    pages: [
      {
        id: "page-a",
        name: "001.png",
        imagePath,
        width: 100,
        height: 120,
        blocks: [
          {
            id: "block-a",
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
            autoFitText: true,
          },
        ],
        analysisStatus: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  await writeJson(join(root, "index.json"), { workOrder: ["work-1"] });
  await writeJson(join(root, "works", "work-1", "work.json"), work);
  await writeJson(join(chapterRoot, "chapter.json"), chapter);
  await writeJson(join(root, "works", "work-1", "style-guide.json"), {
    schemaVersion: 1,
    workId: "work-1",
    glossary: [],
    characters: [],
    rules: {
      honorifics: "preserve",
      sfxMode: "translate",
      defaultTone: "natural_korean",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await writeFile(imagePath, makePngImage(100, 120));
  return { root, sharePath: join(root, "fixture.mgtshare") };
}

async function loadModules(root: string) {
  vi.resetModules();
  vi.doMock("electron", () => ({
    app: { isPackaged: false },
    nativeImage: {
      createFromPath: () => ({
        getSize: () => ({ width: 100, height: 120 }),
      }),
    },
  }));
  vi.doMock("../src/main/appPaths", () => ({
    getAppPaths: () => makeAppPaths(root),
  }));
  const [library, transaction, recovery] = await Promise.all([
    import("../src/main/library"),
    import("../src/main/libraryStore/libraryTransaction"),
    import("../src/main/libraryStore/libraryTransactionRecovery"),
  ]);
  return { library, transaction, recovery };
}

function newWorkRequest(packagePath: string) {
  return {
    packagePath,
    target: { mode: "new" as const, title: "공유 새 작품" },
    entries: [
      {
        source: "package" as const,
        packageChapterId: "chapter-a",
        title: "가져온 1화",
      },
    ],
  };
}

function existingWorkRequest(packagePath: string) {
  return {
    packagePath,
    target: { mode: "existing" as const, workId: "work-1" },
    entries: [
      {
        source: "package" as const,
        packageChapterId: "chapter-a",
        title: "교체 1화",
      },
    ],
  };
}

function crashOnceAt(
  transaction: typeof import("../src/main/libraryStore/libraryTransaction"),
  point: LibraryTransactionCrashPoint,
): () => void {
  let crashed = false;
  return transaction.setLibraryTransactionCrashInjectorForTests(
    (currentPoint) => {
      if (!crashed && currentPoint === point) {
        crashed = true;
        throw new transaction.SimulatedLibraryTransactionCrash(currentPoint);
      }
    },
  );
}

function makeAppPaths(root: string) {
  return {
    isPackaged: false,
    repoRoot: root,
    executableDir: root,
    resourcesDir: root,
    dataRoot: root,
    settingsPath: join(root, "settings.json"),
    libraryDir: root,
    fontsDir: join(root, "fonts"),
    logsDir: join(root, "logs"),
    logFile: join(root, "logs", "app.log"),
    runtimeDir: join(process.cwd(), "src", "main", "runtime"),
    toolsDir: join(root, "tools"),
    ocrRuntimeDir: join(root, "ocr-runtime"),
    llamaRuntimeDir: join(root, "tools", "llama"),
    llamaServerPath: join(root, "tools", "llama", "llama-server.exe"),
  };
}

async function writeJson(path: string, payload: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
