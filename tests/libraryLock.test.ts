import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { AsyncReaderWriterLock } from "../src/main/libraryStore/mutex";

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function waitForTurn(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("AsyncReaderWriterLock", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doUnmock("electron");
    vi.doUnmock("../src/main/appPaths");
    vi.doUnmock("../src/main/libraryStore/libraryMutations");
    vi.doUnmock("../src/main/libraryStore/shareWorkflow");
  });

  it("runs queued reads concurrently", async () => {
    const lock = new AsyncReaderWriterLock();
    const releaseReads = createDeferred();
    let activeReads = 0;
    let peakReads = 0;

    const first = lock.runRead(async () => {
      activeReads += 1;
      peakReads = Math.max(peakReads, activeReads);
      await releaseReads.promise;
      activeReads -= 1;
      return "first";
    });
    const second = lock.runRead(async () => {
      activeReads += 1;
      peakReads = Math.max(peakReads, activeReads);
      await releaseReads.promise;
      activeReads -= 1;
      return "second";
    });

    await waitForTurn();

    expect(peakReads).toBe(2);

    releaseReads.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      "first",
      "second",
    ]);
  });

  it("keeps writes exclusive and blocks later reads behind a queued write", async () => {
    const lock = new AsyncReaderWriterLock();
    const releaseInitialRead = createDeferred();
    const releaseWrite = createDeferred();
    const events: string[] = [];

    const initialRead = lock.runRead(async () => {
      events.push("read:start");
      await releaseInitialRead.promise;
      events.push("read:end");
    });

    await waitForTurn();

    const write = lock.runWrite(async () => {
      events.push("write:start");
      await releaseWrite.promise;
      events.push("write:end");
    });
    const laterRead = lock.runRead(async () => {
      events.push("later-read:start");
      return "later";
    });

    await waitForTurn();

    expect(events).toEqual(["read:start"]);

    releaseInitialRead.resolve();
    await initialRead;
    await waitForTurn();

    expect(events).toEqual(["read:start", "read:end", "write:start"]);

    releaseWrite.resolve();

    await expect(write).resolves.toBeUndefined();
    await expect(laterRead).resolves.toBe("later");
    expect(events).toEqual([
      "read:start",
      "read:end",
      "write:start",
      "write:end",
      "later-read:start",
    ]);
  });

  it("runs share exports through the read lock behind active mutations", async () => {
    const rootDir = "C:\\manga-lock-test";
    const releaseMutation = createDeferred();
    const events: string[] = [];

    vi.doMock("electron", () => ({
      app: {
        isPackaged: false,
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
        libraryDir: join(rootDir, "library"),
        logsDir: join(rootDir, "logs"),
        logFile: join(rootDir, "logs", "app.log"),
        runtimeDir: join(rootDir, "runtime"),
        toolsDir: join(rootDir, "tools"),
        ocrRuntimeDir: join(rootDir, "ocr-runtime"),
        llamaRuntimeDir: join(rootDir, "tools", "llama"),
        llamaServerPath: join(rootDir, "tools", "llama", "llama-server.exe"),
      }),
    }));
    vi.doMock("../src/main/libraryStore/libraryMutations", async () => {
      const actual = await vi.importActual<
        typeof import("../src/main/libraryStore/libraryMutations")
      >("../src/main/libraryStore/libraryMutations");
      return {
        ...actual,
        savePageBlocksUnlocked: vi.fn(async () => {
          events.push("write:start");
          await releaseMutation.promise;
          events.push("write:end");
          return {
            id: "chapter-a",
          } as Awaited<ReturnType<typeof actual.savePageBlocksUnlocked>>;
        }),
      };
    });
    vi.doMock("../src/main/libraryStore/shareWorkflow", () => ({
      exportWorkShareToFile: vi.fn(async () => {
        events.push("export:start");
        return {
          filePath: "share.mgtshare",
          workTitle: "원본 작품",
          chapterCount: 1,
          pageCount: 1,
        };
      }),
      importWorkShareUnlocked: vi.fn(),
      previewWorkShareImport: vi.fn(),
    }));

    const library = await import("../src/main/library");
    const mutation = library.savePageBlocks({
      chapterId: "chapter-a",
      pageId: "page-a",
      blocks: [],
    });
    await waitForTurn();

    expect(events).toEqual(["write:start"]);

    const shareExport = library.exportWorkShareToFile({
      workId: "work-1",
      chapterIds: ["chapter-a"],
      outputPath: "share.mgtshare",
    });
    await waitForTurn();

    expect(events).toEqual(["write:start"]);

    releaseMutation.resolve();

    await expect(mutation).resolves.toMatchObject({ id: "chapter-a" });
    await expect(shareExport).resolves.toMatchObject({
      filePath: "share.mgtshare",
    });
    expect(events).toEqual(["write:start", "write:end", "export:start"]);
  });
});
