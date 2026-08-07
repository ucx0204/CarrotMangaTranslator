import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppActivityGate } from "../src/main/appActivityGate";
import { AppOperationRegistry } from "../src/main/appOperationRegistry";
import type { IpcContext } from "../src/main/ipc/context";
import {
  registerImportShareIpc,
  type ImportShareIpcService,
} from "../src/main/ipc/importShareIpc";
import { ActiveJobStore } from "../src/main/jobs/activeJob";
import type { WorkShareImportPreview } from "../src/shared/shareTypes";

type IpcHandler = (
  event: {
    sender: { id: number };
    senderFrame?: { url: string };
  },
  ...args: unknown[]
) => Promise<unknown> | unknown;

const electronBoundary = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
}));

vi.mock("electron", () => ({
  dialog: {
    showOpenDialog: electronBoundary.showOpenDialog,
    showSaveDialog: electronBoundary.showSaveDialog,
  },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => {
      electronBoundary.handlers.set(channel, handler);
    },
  },
  nativeImage: {},
}));

const WORK_ID = "11111111-1111-4111-8111-111111111111";
const PACKAGE_CHAPTER_ID = "22222222-2222-4222-8222-222222222222";
const IMPORTED_CHAPTER_ID = "33333333-3333-4333-8333-333333333333";
const tempDirs: string[] = [];

beforeEach(() => {
  electronBoundary.handlers.clear();
  electronBoundary.showOpenDialog.mockReset();
  electronBoundary.showSaveDialog.mockReset();
});

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("work share managed operation lifecycle", () => {
  it("registers share export after the dialog and passes its signal", async () => {
    const dataRoot = await makeTempDir();
    const context = createContext(dataRoot);
    const service = makeService();
    registerImportShareIpc(context, service);
    service.listLibrary.mockResolvedValue(makeLibraryIndex());
    const outputPath = join(dataRoot, "shared.mgtshare");
    electronBoundary.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: outputPath,
    });
    let capturedSignal: AbortSignal | undefined;
    service.exportWorkShareToFile.mockImplementation(
      async (request: { outputPath: string }, signal?: AbortSignal) => {
        capturedSignal = signal;
        expect(context.operations.current).toMatchObject({
          kind: "work-share-export",
          mutatesLibrary: false,
        });
        return {
          filePath: request.outputPath,
          workTitle: "Shared Work",
          chapterCount: 1,
          pageCount: 2,
        };
      },
    );

    await expect(
      getHandler("share:export-work")(trustedEvent(), {
        workId: WORK_ID,
        chapterIds: [PACKAGE_CHAPTER_ID],
      }),
    ).resolves.toMatchObject({ filePath: outputPath });

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(false);
    expect(context.operations.current).toBeNull();
  });

  it("does not start export when another activity begins while the dialog is open", async () => {
    const dataRoot = await makeTempDir();
    const context = createContext(dataRoot);
    const service = makeService();
    registerImportShareIpc(context, service);
    service.listLibrary.mockResolvedValue(makeLibraryIndex());
    const dialogGate = createDeferred<{
      canceled: boolean;
      filePath: string;
    }>();
    electronBoundary.showSaveDialog.mockReturnValue(dialogGate.promise);

    const exporting = getHandler("share:export-work")(trustedEvent(), {
      workId: WORK_ID,
      chapterIds: [PACKAGE_CHAPTER_ID],
    }) as Promise<unknown>;
    await vi.waitFor(() => {
      expect(electronBoundary.showSaveDialog).toHaveBeenCalledTimes(1);
    });
    context.jobs.start({
      id: "translation-during-dialog",
      kind: "gemma-analysis",
      abortController: new AbortController(),
    });
    dialogGate.resolve({
      canceled: false,
      filePath: join(dataRoot, "late-share.mgtshare"),
    });

    await expect(exporting).rejects.toThrow();
    expect(service.exportWorkShareToFile).not.toHaveBeenCalled();
    context.jobs.clearIfCurrent("translation-during-dialog");
  });

  it("retains the import preview for busy, failure, and cancellation, then deletes it after success", async () => {
    const dataRoot = await makeTempDir();
    const context = createContext(dataRoot);
    const service = makeService();
    registerImportShareIpc(context, service);
    const preview = await createSharePreview(dataRoot, service);

    context.jobs.start({
      id: "active-job",
      kind: "gemma-analysis",
      abortController: new AbortController(),
    });
    await expect(invokeShareImport(preview)).rejects.toThrow();
    expect(service.importWorkShare).not.toHaveBeenCalled();
    context.jobs.clearIfCurrent("active-job");

    const failure = new Error("package invalid");
    service.importWorkShare.mockRejectedValueOnce(failure);
    await expect(invokeShareImport(preview)).rejects.toBe(failure);
    expect(context.operations.current).toBeNull();

    const abort = new DOMException("cancel share import", "AbortError");
    service.importWorkShare.mockRejectedValueOnce(abort);
    await expect(invokeShareImport(preview)).rejects.toBe(abort);
    expect(context.operations.current).toBeNull();

    let capturedSignal: AbortSignal | undefined;
    service.importWorkShare.mockImplementationOnce(
      async (_request: unknown, signal?: AbortSignal) => {
        capturedSignal = signal;
        expect(context.operations.current?.kind).toBe("work-share-import");
        return {
          workId: WORK_ID,
          chapterIds: [IMPORTED_CHAPTER_ID],
        };
      },
    );
    await expect(invokeShareImport(preview)).resolves.toMatchObject({
      workId: WORK_ID,
    });
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(context.operations.current).toBeNull();

    await expect(invokeShareImport(preview)).rejects.toThrow();
    expect(service.importWorkShare).toHaveBeenCalledTimes(3);
  });

  it("waits for share import unwind after app-quit abort", async () => {
    const dataRoot = await makeTempDir();
    const context = createContext(dataRoot);
    const service = makeService();
    registerImportShareIpc(context, service);
    const preview = await createSharePreview(dataRoot, service);
    const unwindGate = createDeferred<void>();
    let capturedSignal: AbortSignal | undefined;
    service.importWorkShare.mockImplementation(
      async (_request: unknown, signal?: AbortSignal) => {
        capturedSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              void unwindGate.promise.then(() =>
                reject(
                  signal.reason instanceof Error
                    ? signal.reason
                    : new DOMException("Aborted", "AbortError"),
                ),
              );
            },
            { once: true },
          );
        });
        throw new Error("unreachable");
      },
    );

    const importing = invokeShareImport(preview);
    await vi.waitFor(() => {
      expect(context.operations.current?.kind).toBe("work-share-import");
    });
    let settled = false;
    const waiting = context.operations
      .abortCurrentAndWait("app-quit")
      .then((x) => {
        settled = true;
        return x;
      });

    await vi.waitFor(() => expect(capturedSignal?.aborted).toBe(true));
    expect(settled).toBe(false);
    unwindGate.resolve(undefined);
    await expect(importing).rejects.toMatchObject({ name: "AbortError" });
    await expect(waiting).resolves.toMatchObject({ kind: "work-share-import" });
    expect(context.operations.current).toBeNull();
  });
});

async function createSharePreview(
  dataRoot: string,
  service: ReturnType<typeof makeService>,
): Promise<WorkShareImportPreview> {
  const packagePath = join(dataRoot, "incoming.mgtshare");
  electronBoundary.showOpenDialog.mockResolvedValueOnce({
    canceled: false,
    filePaths: [packagePath],
  });
  service.previewWorkShareImport.mockResolvedValueOnce({
    workTitle: "Incoming Work",
    chapters: [
      {
        packageChapterId: PACKAGE_CHAPTER_ID,
        title: "Chapter 1",
        pageCount: 2,
      },
    ],
  });

  const preview = (await getHandler("share:preview-import")(
    trustedEvent(),
  )) as WorkShareImportPreview | null;
  if (!preview) {
    throw new Error("Expected work-share preview");
  }
  return preview;
}

function makeLibraryIndex() {
  const now = "2026-08-07T00:00:00.000Z";
  return {
    workOrder: [WORK_ID],
    works: [
      {
        id: WORK_ID,
        title: "Shared Work",
        chapterOrder: [],
        chapters: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

function makeService() {
  return {
    exportWorkShareToFile:
      vi.fn<ImportShareIpcService["exportWorkShareToFile"]>(),
    importWorkShare: vi.fn<ImportShareIpcService["importWorkShare"]>(),
    listLibrary: vi.fn<ImportShareIpcService["listLibrary"]>(),
    previewWorkShareImport:
      vi.fn<ImportShareIpcService["previewWorkShareImport"]>(),
  } satisfies ImportShareIpcService;
}

function invokeShareImport(preview: WorkShareImportPreview): Promise<unknown> {
  return getHandler("share:import")(trustedEvent(), {
    previewId: preview.previewId,
    target: { mode: "new", title: "Imported Work" },
    entries: [
      {
        source: "package",
        packageChapterId: PACKAGE_CHAPTER_ID,
        title: "Chapter 1",
      },
    ],
  }) as Promise<unknown>;
}

function createContext(dataRoot: string): IpcContext {
  const activityGate = new AppActivityGate();
  return {
    appPaths: {
      isPackaged: false,
      repoRoot: dataRoot,
      executableDir: dataRoot,
      resourcesDir: dataRoot,
      dataRoot,
      settingsPath: join(dataRoot, "settings.json"),
      libraryDir: join(dataRoot, "library"),
      fontsDir: join(dataRoot, "fonts"),
      logsDir: join(dataRoot, "logs"),
      logFile: join(dataRoot, "logs", "app.log"),
      runtimeDir: join(dataRoot, "runtime"),
      toolsDir: join(dataRoot, "tools"),
      ocrRuntimeDir: join(dataRoot, "ocr-runtime"),
      llamaRuntimeDir: join(dataRoot, "llama"),
      llamaServerPath: join(dataRoot, "llama", "server.exe"),
    },
    jobs: new ActiveJobStore(undefined, activityGate),
    operations: new AppOperationRegistry(activityGate),
    getMainWindow: () =>
      ({
        isDestroyed: () => false,
        webContents: {
          id: 1,
          getURL: () => "http://127.0.0.1:5173/",
        },
      }) as ReturnType<IpcContext["getMainWindow"]>,
    panelWindows: {
      close: () => false,
      closeAll: () => undefined,
      getLastState: () => null,
      getOpenPanelIds: () => [],
      isPanelSender: () => false,
      open: () => false,
      publishState: () => undefined,
    },
    loadSimplePageRuntime: () => {
      throw new Error("not used by work-share lifecycle tests");
    },
    decodeImage: async () => null,
  };
}

function getHandler(channel: string): IpcHandler {
  const handler = electronBoundary.handlers.get(channel);
  if (!handler) {
    throw new Error(`Missing IPC handler: ${channel}`);
  }
  return handler;
}

function trustedEvent(): Parameters<IpcHandler>[0] {
  return {
    sender: { id: 1 },
    senderFrame: { url: "http://127.0.0.1:5173/" },
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "share-operation-lifecycle-"));
  tempDirs.push(dir);
  return dir;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
