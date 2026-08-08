import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("work context reset transaction", () => {
  it("rolls every context file back to its old value after a pre-commit crash", async () => {
    const root = await createSeededContextLibrary();
    const before = await readContextFiles(root);
    const { library, transaction, recovery } = await loadModules(root);
    const restoreInjector = crashOnceAt(transaction, "after-replace-step");
    try {
      await expect(
        library.resetWorkContext("chapter-a"),
      ).rejects.toBeInstanceOf(transaction.SimulatedLibraryTransactionCrash);
    } finally {
      restoreInjector();
    }

    await recovery.recoverLibraryTransactions();
    expect(await readContextFiles(root)).toEqual(before);
  });

  it("keeps every context file reset after the commit point", async () => {
    const root = await createSeededContextLibrary();
    const { library, transaction, recovery } = await loadModules(root);
    const restoreInjector = crashOnceAt(transaction, "after-commit-point");
    try {
      await expect(
        library.resetWorkContext("chapter-a"),
      ).rejects.toBeInstanceOf(transaction.SimulatedLibraryTransactionCrash);
    } finally {
      restoreInjector();
    }

    await recovery.recoverLibraryTransactions();
    const files = await readContextFiles(root);
    expect(files.style.glossary).toEqual([]);
    expect(files.style.characters).toEqual([]);
    expect(files.a.pages).toEqual([]);
    expect(files.b.pages).toEqual([]);
    expect(files.c.pages).toEqual([]);
  });
});

async function createSeededContextLibrary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "context-reset-transaction-"));
  tempDirs.push(root);
  await mkdir(join(root, "logs"), { recursive: true });
  const chapters = ["chapter-a", "chapter-b", "chapter-c"];
  await mkdir(join(root, "works", "work-1", "chapters"), { recursive: true });
  await writeJson(join(root, "index.json"), { workOrder: ["work-1"] });
  await writeJson(join(root, "works", "work-1", "work.json"), {
    id: "work-1",
    title: "Work",
    chapterOrder: chapters,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  for (const [index, chapterId] of chapters.entries()) {
    const chapterRoot = join(root, "works", "work-1", "chapters", chapterId);
    await mkdir(chapterRoot, { recursive: true });
    await writeJson(join(chapterRoot, "chapter.json"), {
      id: chapterId,
      workId: "work-1",
      title: `${index + 1}화`,
      sourceKind: "folder",
      status: "idle",
      pageOrder: [],
      pages: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await writeJson(join(chapterRoot, "story-memory.json"), {
      schemaVersion: 1,
      workId: "work-1",
      chapterId,
      pages: [
        {
          pageId: `page-${index}`,
          pageName: `${index}.png`,
          pageIndex: 0,
          sourceDigest: "source",
          translatedDigest: "translated",
          summary: `old-${chapterId}`,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      updatedAt: "2026-01-01T00:00:00.000Z",
      aiAnalyzedAt: "2026-01-01T00:00:00.000Z",
    });
  }
  await writeJson(join(root, "works", "work-1", "style-guide.json"), {
    schemaVersion: 1,
    workId: "work-1",
    glossary: [
      {
        id: "g1",
        source: "勇者",
        target: "용사",
        category: "term",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    characters: [],
    rules: {
      honorifics: "preserve",
      sfxMode: "translate",
      defaultTone: "natural_korean",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  return root;
}

type ContextFixture = {
  glossary?: unknown[];
  characters?: unknown[];
  pages?: unknown[];
  [key: string]: unknown;
};

async function readContextFiles(root: string) {
  const base = join(root, "works", "work-1");
  const read = async (path: string) =>
    JSON.parse(await readFile(path, "utf8")) as ContextFixture;
  return {
    style: await read(join(base, "style-guide.json")),
    a: await read(join(base, "chapters", "chapter-a", "story-memory.json")),
    b: await read(join(base, "chapters", "chapter-b", "story-memory.json")),
    c: await read(join(base, "chapters", "chapter-c", "story-memory.json")),
  };
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

async function writeJson(path: string, payload: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
