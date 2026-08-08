import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LibraryChapter, LibraryWork } from "../src/shared/libraryTypes";
import type { LibraryTransactionCrashPoint } from "../src/main/libraryStore/libraryTransaction";

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

describe("delete transaction recovery", () => {
  it.each(["after-replace-step", "after-retire-step"] as const)(
    "restores index and work directory after a pre-commit delete-work crash at %s",
    async (point) => {
      const root = await createSeededLibrary();
      const { library, transaction, recovery } = await loadModules(root);
      const restoreInjector = crashOnceAt(transaction, point);
      try {
        await expect(library.deleteWork("work-1")).rejects.toBeInstanceOf(
          transaction.SimulatedLibraryTransactionCrash,
        );
      } finally {
        restoreInjector();
      }

      await recovery.recoverLibraryTransactions();
      const index = await library.listLibrary();
      expect(index.workOrder).toEqual(["work-1"]);
      expect(existsSync(join(root, "works", "work-1"))).toBe(true);
    },
  );

  it("keeps a work fully deleted after the commit point", async () => {
    const root = await createSeededLibrary();
    const { library, transaction, recovery } = await loadModules(root);
    const restoreInjector = crashOnceAt(transaction, "after-commit-point");
    try {
      await expect(library.deleteWork("work-1")).rejects.toBeInstanceOf(
        transaction.SimulatedLibraryTransactionCrash,
      );
    } finally {
      restoreInjector();
    }

    await recovery.recoverLibraryTransactions();
    expect((await library.listLibrary()).workOrder).toEqual([]);
    expect(existsSync(join(root, "works", "work-1"))).toBe(false);
  });

  it("restores work chapter order and chapter directory after a pre-commit delete-chapter crash", async () => {
    const root = await createSeededLibrary();
    const { library, transaction, recovery } = await loadModules(root);
    const restoreInjector = crashOnceAt(transaction, "after-retire-step");
    try {
      await expect(library.deleteChapter("chapter-a")).rejects.toBeInstanceOf(
        transaction.SimulatedLibraryTransactionCrash,
      );
    } finally {
      restoreInjector();
    }

    await recovery.recoverLibraryTransactions();
    const index = await library.listLibrary();
    expect(index.works[0]?.chapterOrder).toEqual(["chapter-a"]);
    expect(
      existsSync(join(root, "works", "work-1", "chapters", "chapter-a")),
    ).toBe(true);
  });

  it.each([
    ["after-replace-step", "old"],
    ["after-retire-step", "old"],
    ["after-commit-point", "new"],
  ] as const)(
    "recovers delete-page metadata and artifacts as one state after %s",
    async (point, expected) => {
      const root = await createSeededLibrary();
      const { library, transaction, recovery } = await loadModules(root);
      const restoreInjector = crashOnceAt(transaction, point);
      try {
        await expect(
          library.deletePage("chapter-a", "page-a"),
        ).rejects.toBeInstanceOf(transaction.SimulatedLibraryTransactionCrash);
      } finally {
        restoreInjector();
      }

      await recovery.recoverLibraryTransactions();
      const chapter = await library.openChapter("chapter-a");
      const memory = JSON.parse(
        await readFile(
          join(
            root,
            "works",
            "work-1",
            "chapters",
            "chapter-a",
            "story-memory.json",
          ),
          "utf8",
        ),
      ) as { pages: Array<{ pageId: string }> };
      const originalImage = join(
        root,
        "works",
        "work-1",
        "chapters",
        "chapter-a",
        "pages",
        "001-page-a.png",
      );
      const inpaintedImage = join(
        root,
        "works",
        "work-1",
        "chapters",
        "chapter-a",
        "inpainted",
        "001-page-a.png",
      );
      const runArtifact = join(
        root,
        "works",
        "work-1",
        "chapters",
        "chapter-a",
        "runs",
        "run-1",
        "pages",
        "page-a",
      );

      if (expected === "old") {
        expect(chapter.pageOrder).toEqual(["page-a"]);
        expect(memory.pages.map((page) => page.pageId)).toEqual(["page-a"]);
        expect(existsSync(originalImage)).toBe(true);
        expect(existsSync(inpaintedImage)).toBe(true);
        expect(existsSync(runArtifact)).toBe(true);
      } else {
        expect(chapter.pageOrder).toEqual([]);
        expect(memory.pages).toEqual([]);
        expect(existsSync(originalImage)).toBe(false);
        expect(existsSync(inpaintedImage)).toBe(false);
        expect(existsSync(runArtifact)).toBe(false);
      }
    },
  );
});

async function createSeededLibrary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "delete-transaction-recovery-"));
  tempDirs.push(root);
  const chapterRoot = join(root, "works", "work-1", "chapters", "chapter-a");
  const pagesRoot = join(chapterRoot, "pages");
  const inpaintedRoot = join(chapterRoot, "inpainted");
  const runArtifact = join(chapterRoot, "runs", "run-1", "pages", "page-a");
  await mkdir(pagesRoot, { recursive: true });
  await mkdir(inpaintedRoot, { recursive: true });
  await mkdir(runArtifact, { recursive: true });
  await mkdir(join(root, "logs"), { recursive: true });

  const work: LibraryWork = {
    id: "work-1",
    title: "Work",
    chapterOrder: ["chapter-a"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const originalImage = join(pagesRoot, "001-page-a.png");
  const inpaintedImage = join(inpaintedRoot, "001-page-a.png");
  const chapter: LibraryChapter = {
    id: "chapter-a",
    workId: work.id,
    title: "1화",
    sourceKind: "folder",
    status: "completed",
    pageOrder: ["page-a"],
    pages: [
      {
        id: "page-a",
        name: "001.png",
        imagePath: originalImage,
        inpaintedImagePath: inpaintedImage,
        width: 16,
        height: 16,
        blocks: [],
        analysisStatus: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  await writeJson(join(root, "index.json"), { workOrder: [work.id] });
  await writeJson(join(root, "works", work.id, "work.json"), work);
  await writeJson(join(chapterRoot, "chapter.json"), chapter);
  await writeJson(join(chapterRoot, "story-memory.json"), {
    schemaVersion: 1,
    workId: work.id,
    chapterId: chapter.id,
    pages: [
      {
        pageId: "page-a",
        pageName: "001.png",
        pageIndex: 0,
        sourceDigest: "source",
        translatedDigest: "translated",
        summary: "summary",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await writeFile(originalImage, makePngHeader(16, 16));
  await writeFile(inpaintedImage, makePngHeader(16, 16));
  await writeFile(join(runArtifact, "artifact.json"), "{}", "utf8");
  return root;
}

async function loadModules(root: string) {
  vi.resetModules();
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
    runtimeDir: join(root, "runtime"),
    toolsDir: join(root, "tools"),
    ocrRuntimeDir: join(root, "ocr-runtime"),
    llamaRuntimeDir: join(root, "tools", "llama"),
    llamaServerPath: join(root, "tools", "llama", "llama-server.exe"),
  };
}

function makePngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

async function writeJson(path: string, payload: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
