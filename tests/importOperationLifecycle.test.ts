import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppActivityGate } from "../src/main/appActivityGate";
import { AppOperationRegistry } from "../src/main/appOperationRegistry";
import type { IpcContext } from "../src/main/ipc/context";
import {
  registerImportPreviewIpc,
  type ImportPreviewIpcService,
} from "../src/main/ipc/importPreviewIpc";
import { ActiveJobStore } from "../src/main/jobs/activeJob";
import type { ImportImageRuntime } from "../src/main/libraryStore/importImageRuntime";
import type {
  DroppedImportPreviewResponse,
  ImportPreviewResult,
  ImportPreviewSession,
} from "../src/shared/importTypes";

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
}));

vi.mock("electron", () => ({
  dialog: {
    showOpenDialog: electronBoundary.showOpenDialog,
  },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => {
      electronBoundary.handlers.set(channel, handler);
    },
  },
  nativeImage: {},
}));

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
const WORK_ID = "22222222-2222-4222-8222-222222222222";
const CHAPTER_ID = "33333333-3333-4333-8333-333333333333";
const tempDirs: string[] = [];

beforeEach(() => {
  electronBoundary.handlers.clear();
  electronBoundary.showOpenDialog.mockReset();
});

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("library import managed operation lifecycle", () => {
  it("creates a reusable import preview from dropped image paths", async () => {
    const dataRoot = await makeTempDir();
    const { context } = createContext(dataRoot);
    const service = makeService();
    const imagePaths = [join(dataRoot, "001.png"), join(dataRoot, "002.jpg")];
    service.classifyDroppedImportPaths.mockImplementation(async (paths) => {
      expect(context.operations.current?.kind).toBe("library-import-preview");
      return { status: "accepted", kind: "images", filePaths: paths };
    });
    service.previewImages.mockResolvedValue(makeImagePreview(imagePaths));
    registerImportPreviewIpc(context, service);

    const response = (await getHandler("import:preview-dropped")(
      trustedEvent(),
      imagePaths,
    )) as DroppedImportPreviewResponse;

    expect(response.status).toBe("ready");
    if (response.status === "ready") {
      expect(response.preview.sourceKind).toBe("images");
      expect(
        response.preview.chapters[0]?.pages.map((page) => page.sourcePath),
      ).toEqual(imagePaths);
    }
    expect(context.operations.current).toBeNull();
    if (response.status !== "ready") {
      throw new Error("Expected a ready dropped import preview");
    }
    service.createImport.mockResolvedValue({
      workId: WORK_ID,
      chapterIds: [CHAPTER_ID],
    });
    await expect(invokeCreateImport(response.preview)).resolves.toEqual({
      workId: WORK_ID,
      chapterIds: [CHAPTER_ID],
    });
  });

  it("returns a busy rejection before inspecting dropped paths", async () => {
    const dataRoot = await makeTempDir();
    const { context } = createContext(dataRoot);
    const service = makeService();
    context.jobs.start({
      id: "translation-active",
      kind: "gemma-analysis",
      abortController: new AbortController(),
    });
    registerImportPreviewIpc(context, service);

    await expect(
      getHandler("import:preview-dropped")(trustedEvent(), [
        join(dataRoot, "001.png"),
      ]),
    ).resolves.toEqual({ status: "rejected", reason: "busy" });
    expect(service.classifyDroppedImportPaths).not.toHaveBeenCalled();
  });

  it("passes classification rejections through without previewing", async () => {
    const dataRoot = await makeTempDir();
    const { context } = createContext(dataRoot);
    const service = makeService();
    const rejection = {
      status: "rejected" as const,
      reason: "unsupported-files" as const,
      names: ["notes.txt"],
      count: 1,
    };
    service.classifyDroppedImportPaths.mockResolvedValue(rejection);
    registerImportPreviewIpc(context, service);

    await expect(
      getHandler("import:preview-dropped")(trustedEvent(), [
        join(dataRoot, "notes.txt"),
      ]),
    ).resolves.toEqual(rejection);
    expect(service.previewImages).not.toHaveBeenCalled();
    expect(service.previewFolder).not.toHaveBeenCalled();
    expect(service.previewZip).not.toHaveBeenCalled();
  });

  it.each([
    ["folder", "folder-no-images"],
    ["archive", "archive-no-images"],
  ] as const)(
    "returns a friendly rejection when a dropped %s has no images",
    async (kind, reason) => {
      const dataRoot = await makeTempDir();
      const { context } = createContext(dataRoot);
      const service = makeService();
      const sourcePath = join(
        dataRoot,
        kind === "folder" ? "empty" : "empty.zip",
      );
      service.classifyDroppedImportPaths.mockResolvedValue(
        kind === "folder"
          ? { status: "accepted", kind, folderPath: sourcePath }
          : { status: "accepted", kind, archivePath: sourcePath },
      );
      const emptyPreview: ImportPreviewResult = {
        mode: "single",
        sourceKind: kind === "folder" ? "folder" : "zip",
        suggestedWorkTitle: "Empty",
        chapters: [],
      };
      if (kind === "folder") {
        service.previewFolder.mockResolvedValue(emptyPreview);
      } else {
        service.previewZip.mockResolvedValue(emptyPreview);
      }
      registerImportPreviewIpc(context, service);

      await expect(
        getHandler("import:preview-dropped")(trustedEvent(), [sourcePath]),
      ).resolves.toEqual({ status: "rejected", reason });
    },
  );

  it("registers before service entry and passes the registry signal", async () => {
    const dataRoot = await makeTempDir();
    const { context } = createContext(dataRoot);
    const service = makeService();
    const preview = await createPreview(context, service);
    let capturedSignal: AbortSignal | undefined;
    service.createImport.mockImplementation(async (_request, signal) => {
      capturedSignal = signal;
      expect(context.operations.current).toMatchObject({
        kind: "library-import",
        mutatesLibrary: true,
      });
      return {
        workId: WORK_ID,
        chapterIds: [CHAPTER_ID],
      };
    });

    await expect(invokeCreateImport(preview)).resolves.toEqual({
      workId: WORK_ID,
      chapterIds: [CHAPTER_ID],
    });

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(false);
    expect(context.operations.current).toBeNull();
  });

  it("does not call the import service while a job is active and retains the preview", async () => {
    const dataRoot = await makeTempDir();
    const { context } = createContext(dataRoot);
    const service = makeService();
    const preview = await createPreview(context, service);
    context.jobs.start({
      id: "translation-active",
      kind: "gemma-analysis",
      abortController: new AbortController(),
    });

    await expect(invokeCreateImport(preview)).rejects.toThrow();
    expect(service.createImport).not.toHaveBeenCalled();

    context.jobs.clearIfCurrent("translation-active");
    service.createImport.mockResolvedValue({
      workId: WORK_ID,
      chapterIds: [CHAPTER_ID],
    });
    await expect(invokeCreateImport(preview)).resolves.toMatchObject({
      workId: WORK_ID,
    });
  });

  it("retains the preview after failure or cancellation and releases the operation", async () => {
    const dataRoot = await makeTempDir();
    const { context } = createContext(dataRoot);
    const service = makeService();
    const failedPreview = await createPreview(context, service);
    const failure = new Error("library write failed");
    service.createImport.mockRejectedValueOnce(failure);

    await expect(invokeCreateImport(failedPreview)).rejects.toBe(failure);
    expect(context.operations.current).toBeNull();

    service.createImport.mockResolvedValueOnce({
      workId: WORK_ID,
      chapterIds: [CHAPTER_ID],
    });
    await expect(invokeCreateImport(failedPreview)).resolves.toMatchObject({
      workId: WORK_ID,
    });

    const cancelledPreview = await createPreview(context, service);
    const abort = new DOMException("cancel import", "AbortError");
    service.createImport.mockRejectedValueOnce(abort);
    await expect(invokeCreateImport(cancelledPreview)).rejects.toBe(abort);
    expect(context.operations.current).toBeNull();

    service.createImport.mockResolvedValueOnce({
      workId: WORK_ID,
      chapterIds: [CHAPTER_ID],
    });
    await expect(invokeCreateImport(cancelledPreview)).resolves.toMatchObject({
      workId: WORK_ID,
    });
  });

  it("rolls back a newly created work when cancellation reaches page materialization", async () => {
    const dataRoot = await makeTempDir();
    const firstImage = join(dataRoot, "001.webp");
    const secondImage = join(dataRoot, "002.webp");
    const webpBytes = Buffer.from(
      "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
      "base64",
    );
    await writeFile(firstImage, webpBytes);
    await writeFile(secondImage, webpBytes);

    vi.resetModules();
    vi.doMock("../src/main/appPaths", () => ({
      getAppPaths: () => ({
        isPackaged: false,
        repoRoot: dataRoot,
        executableDir: dataRoot,
        resourcesDir: dataRoot,
        dataRoot,
        settingsPath: join(dataRoot, "settings.json"),
        libraryDir: dataRoot,
        fontsDir: join(dataRoot, "fonts"),
        logsDir: join(dataRoot, "logs"),
        logFile: join(dataRoot, "logs", "app.log"),
        runtimeDir: join(dataRoot, "runtime"),
        toolsDir: join(dataRoot, "tools"),
        ocrRuntimeDir: join(dataRoot, "ocr-runtime"),
        llamaRuntimeDir: join(dataRoot, "llama"),
        llamaServerPath: join(dataRoot, "llama", "server.exe"),
      }),
    }));
    const controller = new AbortController();
    let decodeCount = 0;
    const imageRuntime: ImportImageRuntime = {
      validateImageFile: vi.fn(async () => undefined),
      convertWebpToPngFile: vi.fn(async (_sourcePath, outputPath) => {
        await writeFile(
          outputPath,
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
            "base64",
          ),
        );
        decodeCount += 1;
        if (decodeCount === 2) {
          controller.abort(new DOMException("cancel import", "AbortError"));
        }
      }),
    };
    const library = await import("../src/main/library");
    const service = library.createLibraryImportService({
      image: imageRuntime,
      runMutation: (operation) => operation(),
    });

    await expect(
      service.createImport(
        {
          preview: {
            mode: "single",
            sourceKind: "images",
            suggestedWorkTitle: "Cancelled Work",
            chapters: [
              {
                draftId: DRAFT_ID,
                title: "Chapter 1",
                sourceKind: "images",
                pages: [
                  {
                    name: "001.webp",
                    sourceKind: "file",
                    sourcePath: firstImage,
                  },
                  {
                    name: "002.webp",
                    sourceKind: "file",
                    sourcePath: secondImage,
                  },
                ],
              },
            ],
          },
          target: { mode: "new", title: "Cancelled Work" },
          selections: [
            {
              draftId: DRAFT_ID,
              title: "Chapter 1",
              enabled: true,
            },
          ],
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(decodeCount).toBe(2);
    await expect(library.listLibrary()).resolves.toMatchObject({ works: [] });
  });

  it("aborts the active import and waits for the service to unwind", async () => {
    const dataRoot = await makeTempDir();
    const { context } = createContext(dataRoot);
    const service = makeService();
    const preview = await createPreview(context, service);
    const unwindGate = createDeferred<void>();
    let seenSignal: AbortSignal | undefined;
    service.createImport.mockImplementation(async (_request, signal) => {
      seenSignal = signal;
      await new Promise<void>((_resolve, reject) => {
        const onAbort = async () => {
          await unwindGate.promise;
          reject(
            signal?.reason instanceof Error
              ? signal.reason
              : new DOMException("Aborted", "AbortError"),
          );
        };
        signal?.addEventListener("abort", () => void onAbort(), { once: true });
      });
      throw new Error("unreachable");
    });

    const importing = invokeCreateImport(preview);
    await vi.waitFor(() => {
      expect(context.operations.current?.kind).toBe("library-import");
    });
    let quitWaitSettled = false;
    const quitWait = context.operations
      .abortCurrentAndWait("app-quit")
      .then((value) => {
        quitWaitSettled = true;
        return value;
      });

    await vi.waitFor(() => expect(seenSignal?.aborted).toBe(true));
    expect(quitWaitSettled).toBe(false);
    unwindGate.resolve(undefined);
    await expect(importing).rejects.toMatchObject({ name: "AbortError" });
    await expect(quitWait).resolves.toMatchObject({ kind: "library-import" });
    expect(context.operations.current).toBeNull();
  });
});

async function createPreview(
  context: IpcContext,
  service: ReturnType<typeof makeService>,
): Promise<ImportPreviewSession> {
  service.previewZip.mockResolvedValue(makePreview());
  electronBoundary.showOpenDialog.mockResolvedValueOnce({
    canceled: false,
    filePaths: ["C:\\fixture\\chapter.cbz"],
  });
  registerImportPreviewIpc(context, service);
  const preview = (await getHandler("import:preview-zip")(
    trustedEvent(),
  )) as ImportPreviewSession | null;
  if (!preview) {
    throw new Error("Expected preview session");
  }
  return preview;
}

function makePreview(): ImportPreviewResult {
  return {
    mode: "single",
    sourceKind: "zip",
    suggestedWorkTitle: "Work",
    chapters: [
      {
        draftId: DRAFT_ID,
        title: "Chapter 1",
        sourceKind: "zip",
        pages: [
          {
            name: "001.png",
            sourcePath: "C:\\fixture\\chapter.cbz",
            sourceKind: "zip-entry",
            zipEntryName: "001.png",
          },
        ],
      },
    ],
  };
}

function makeImagePreview(filePaths: string[]): ImportPreviewResult {
  return {
    mode: "single",
    sourceKind: "images",
    suggestedWorkTitle: "Dropped images",
    chapters: [
      {
        draftId: DRAFT_ID,
        title: "Chapter 1",
        sourceKind: "images",
        pages: filePaths.map((sourcePath) => ({
          name: sourcePath.split(/[\\/]/).at(-1) ?? sourcePath,
          sourcePath,
          sourceKind: "file",
        })),
      },
    ],
  };
}

function makeService() {
  return {
    classifyDroppedImportPaths:
      vi.fn<ImportPreviewIpcService["classifyDroppedImportPaths"]>(),
    createImport: vi.fn<ImportPreviewIpcService["createImport"]>(),
    previewFolder: vi.fn<ImportPreviewIpcService["previewFolder"]>(),
    previewImages: vi.fn<ImportPreviewIpcService["previewImages"]>(),
    previewZip: vi.fn<ImportPreviewIpcService["previewZip"]>(),
    previewZipFolder: vi.fn<ImportPreviewIpcService["previewZipFolder"]>(),
  } satisfies ImportPreviewIpcService;
}

function createContext(dataRoot: string): {
  context: IpcContext;
  activityGate: AppActivityGate;
} {
  const activityGate = new AppActivityGate();
  return {
    activityGate,
    context: {
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
        throw new Error("not used by import lifecycle tests");
      },
      decodeImage: async () => null,
    },
  };
}

function invokeCreateImport(preview: ImportPreviewSession): Promise<unknown> {
  return getHandler("import:create")(trustedEvent(), {
    previewId: preview.previewId,
    target: { mode: "new", title: "Work" },
    selections: [
      {
        draftId: DRAFT_ID,
        title: "Chapter 1",
        enabled: true,
      },
    ],
  }) as Promise<unknown>;
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
  const dir = await mkdtemp(join(tmpdir(), "import-operation-lifecycle-"));
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
