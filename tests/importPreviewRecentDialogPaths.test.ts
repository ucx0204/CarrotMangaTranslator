import { BrowserWindow, type OpenDialogOptions } from "electron";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppActivityGate } from "../src/main/appActivityGate";
import { AppOperationRegistry } from "../src/main/appOperationRegistry";
import { ActiveJobStore } from "../src/main/jobs/activeJob";
import type { IpcContext } from "../src/main/ipc/context";
import { registerImportPreviewIpc } from "../src/main/ipc/importPreviewIpc";
import type { ImportPreviewIpcService } from "../src/main/ipc/importPreviewService";
import {
  recentDialogPathKeys,
  rememberRecentDialogDirectory,
} from "../src/main/recentDialogPaths";
import type {
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
  app: {
    getPath: () => "",
    isPackaged: false,
  },
  BrowserWindow: class {
    readonly webContents = {
      id: 1,
      getURL: () => "http://127.0.0.1:5173/",
    };

    isDestroyed(): boolean {
      return false;
    }
  },
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

describe("archive import recent dialog path integration", () => {
  it("waits for successful createImport before remembering the previewed archive folder", async () => {
    const fixture = await makeArchiveFixture();
    const service = makeService();
    rememberArchiveDirectory(fixture.dataRoot, fixture.previousDir);
    service.previewZip.mockResolvedValue(
      makeArchivePreview(fixture.archivePath),
    );
    service.createImport.mockResolvedValue({
      workId: WORK_ID,
      chapterIds: [CHAPTER_ID],
    });
    electronBoundary.showOpenDialog
      .mockResolvedValueOnce({
        canceled: false,
        filePaths: [fixture.archivePath],
      })
      .mockResolvedValueOnce({ canceled: true, filePaths: [] })
      .mockResolvedValueOnce({ canceled: true, filePaths: [] });
    registerImportPreviewIpc(makeContext(fixture.dataRoot), service);

    const preview = await invokeArchivePreview();
    expect(preview).not.toBeNull();
    expect(latestOpenDialogOptions().defaultPath).toBe(fixture.previousDir);
    await expect(readStoredArchiveDirectory(fixture.dataRoot)).resolves.toBe(
      fixture.previousDir,
    );

    await expect(invokeArchivePreview()).resolves.toBeNull();
    expect(latestOpenDialogOptions().defaultPath).toBe(fixture.previousDir);
    await expect(readStoredArchiveDirectory(fixture.dataRoot)).resolves.toBe(
      fixture.previousDir,
    );

    await expect(invokeCreateImport(requirePreview(preview))).resolves.toEqual({
      workId: WORK_ID,
      chapterIds: [CHAPTER_ID],
    });

    await expect(invokeArchivePreview()).resolves.toBeNull();
    expect(latestOpenDialogOptions().defaultPath).toBe(fixture.selectedDir);
    await expect(readStoredArchiveDirectory(fixture.dataRoot)).resolves.toBe(
      fixture.selectedDir,
    );
  });

  it("preserves the prior folder when archive selection is cancelled", async () => {
    const fixture = await makeArchiveFixture();
    const service = makeService();
    rememberArchiveDirectory(fixture.dataRoot, fixture.previousDir);
    electronBoundary.showOpenDialog.mockResolvedValue({
      canceled: true,
      filePaths: [],
    });
    registerImportPreviewIpc(makeContext(fixture.dataRoot), service);

    await expect(invokeArchivePreview()).resolves.toBeNull();

    expect(latestOpenDialogOptions().defaultPath).toBe(fixture.previousDir);
    expect(service.previewZip).not.toHaveBeenCalled();
    await expect(readStoredArchiveDirectory(fixture.dataRoot)).resolves.toBe(
      fixture.previousDir,
    );
  });

  it("preserves the prior folder when archive preview fails", async () => {
    const fixture = await makeArchiveFixture();
    const service = makeService();
    rememberArchiveDirectory(fixture.dataRoot, fixture.previousDir);
    service.previewZip.mockRejectedValueOnce(
      new Error("archive is unreadable"),
    );
    electronBoundary.showOpenDialog
      .mockResolvedValueOnce({
        canceled: false,
        filePaths: [fixture.archivePath],
      })
      .mockResolvedValueOnce({ canceled: true, filePaths: [] });
    registerImportPreviewIpc(makeContext(fixture.dataRoot), service);

    await expect(invokeArchivePreview()).rejects.toThrow(
      "archive is unreadable",
    );
    await expect(invokeArchivePreview()).resolves.toBeNull();

    expect(latestOpenDialogOptions().defaultPath).toBe(fixture.previousDir);
    await expect(readStoredArchiveDirectory(fixture.dataRoot)).resolves.toBe(
      fixture.previousDir,
    );
  });

  it("preserves the prior folder when final import creation fails", async () => {
    const fixture = await makeArchiveFixture();
    const service = makeService();
    rememberArchiveDirectory(fixture.dataRoot, fixture.previousDir);
    service.previewZip.mockResolvedValue(
      makeArchivePreview(fixture.archivePath),
    );
    service.createImport.mockRejectedValueOnce(
      new Error("library write failed"),
    );
    electronBoundary.showOpenDialog
      .mockResolvedValueOnce({
        canceled: false,
        filePaths: [fixture.archivePath],
      })
      .mockResolvedValueOnce({ canceled: true, filePaths: [] });
    registerImportPreviewIpc(makeContext(fixture.dataRoot), service);

    const preview = requirePreview(await invokeArchivePreview());
    await expect(invokeCreateImport(preview)).rejects.toThrow(
      "library write failed",
    );
    await expect(invokeArchivePreview()).resolves.toBeNull();

    expect(latestOpenDialogOptions().defaultPath).toBe(fixture.previousDir);
    await expect(readStoredArchiveDirectory(fixture.dataRoot)).resolves.toBe(
      fixture.previousDir,
    );
  });
});

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

function makeArchivePreview(archivePath: string): ImportPreviewResult {
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
            sourcePath: archivePath,
            sourceKind: "zip-entry",
            zipEntryName: "001.png",
          },
        ],
      },
    ],
  };
}

function invokeArchivePreview(): Promise<ImportPreviewSession | null> {
  return getHandler("import:preview-zip")(
    trustedEvent(),
  ) as Promise<ImportPreviewSession | null>;
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

function requirePreview(
  preview: ImportPreviewSession | null,
): ImportPreviewSession {
  if (!preview) {
    throw new Error("Expected archive preview session");
  }
  return preview;
}

function latestOpenDialogOptions(): OpenDialogOptions {
  const call = electronBoundary.showOpenDialog.mock.calls.at(-1);
  if (!call) {
    throw new Error("Open dialog was not called");
  }
  return call[1] as OpenDialogOptions;
}

function rememberArchiveDirectory(dataRoot: string, path: string): void {
  rememberRecentDialogDirectory(
    dataRoot,
    recentDialogPathKeys.archiveImport,
    path,
  );
}

async function readStoredArchiveDirectory(
  dataRoot: string,
): Promise<string | undefined> {
  const stored = JSON.parse(
    await readFile(join(dataRoot, "recent-dialog-paths.json"), "utf8"),
  ) as Record<string, string>;
  return stored.archiveImport;
}

async function makeArchiveFixture(): Promise<{
  archivePath: string;
  dataRoot: string;
  previousDir: string;
  selectedDir: string;
}> {
  const dataRoot = await makeTempDir();
  const previousDir = join(dataRoot, "previous");
  const selectedDir = join(dataRoot, "selected");
  const archivePath = join(selectedDir, "chapter.cbz");
  await Promise.all([
    mkdir(previousDir, { recursive: true }),
    mkdir(selectedDir, { recursive: true }),
  ]);
  await writeFile(archivePath, "archive", "utf8");
  return { archivePath, dataRoot, previousDir, selectedDir };
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "import-preview-dialog-paths-"));
  tempDirs.push(dir);
  return dir;
}

function makeContext(dataRoot: string): IpcContext {
  const mainWindow = new BrowserWindow();
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
      llamaRuntimeDir: join(dataRoot, "tools"),
      llamaServerPath: join(dataRoot, "tools", "llama-server"),
    },
    jobs: new ActiveJobStore(undefined, activityGate),
    operations: new AppOperationRegistry(activityGate),
    getMainWindow: () => mainWindow,
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
      throw new Error("Runtime is not used by archive import tests");
    },
    decodeImage: async () => null,
  };
}

function trustedEvent(): Parameters<IpcHandler>[0] {
  return {
    sender: { id: 1 },
    senderFrame: { url: "http://127.0.0.1:5173/" },
  };
}
