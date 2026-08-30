import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppActivityGate } from "../src/main/appActivityGate";
import { AppOperationRegistry } from "../src/main/appOperationRegistry";
import type { IpcContext } from "../src/main/ipc/context";
import { discardImportPreviewSession } from "../src/main/ipc/importPreviewSessionStore";
import { registerWebImportIpc } from "../src/main/ipc/webImportIpc";
import { ActiveJobStore } from "../src/main/jobs/activeJob";
import type { WebImportSessionManager } from "../src/main/webImportSessionManager";
import { webImportIpcContracts } from "../src/shared/ipcWebImportContracts";

type IpcHandler = (
  event: {
    sender: {
      id: number;
      isDestroyed?: () => boolean;
      send?: (channel: string, payload: unknown) => void;
    };
    senderFrame?: { url: string };
  },
  ...args: unknown[]
) => Promise<unknown> | unknown;

const electronBoundary = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => {
      electronBoundary.handlers.set(channel, handler);
    },
  },
  nativeImage: {},
}));

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const CANDIDATE_ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  electronBoundary.handlers.clear();
});

afterEach(async () => {
  const sessions = await import("../src/main/ipc/importPreviewSessionStore");
  await sessions.disposeImportPreviewSessions();
});

describe("web import background IPC", () => {
  it("publishes scan progress through the work center and renderer event", async () => {
    const scan = vi.fn<WebImportSessionManager["scan"]>(
      async (request, _signal, onProgress) => {
        onProgress({
          requestId: request.requestId,
          stage: "loading",
          completed: 1,
          total: 2,
        });
        return { status: "ready", result: scanResult() };
      },
    );
    const { context, manager } = createContext({ scan });
    const activity: Array<{
      status: string;
      phase?: string;
      progressCurrent?: number;
      progressTotal?: number;
    }> = [];
    context.operations.subscribeActivity((event) => activity.push(event));
    registerWebImportIpc(context);
    const send = vi.fn();

    await expect(
      getHandler(webImportIpcContracts.scanWebImport.channel)(
        trustedEvent(send),
        {
          requestId: REQUEST_ID,
          url: "https://example.com/chapter",
        },
      ),
    ).resolves.toEqual({ status: "ready", result: scanResult() });

    expect(send).toHaveBeenCalledWith(
      "web-import:progress",
      expect.objectContaining({ stage: "loading", completed: 1, total: 2 }),
    );
    expect(activity).toEqual([
      expect.objectContaining({ status: "running", phase: "web-validating" }),
      expect.objectContaining({
        status: "running",
        phase: "web-loading",
        progressCurrent: 1,
        progressTotal: 2,
      }),
      expect.objectContaining({ status: "completed", phase: "web-loading" }),
    ]);

    await expect(
      getHandler(webImportIpcContracts.cancelWebImportScan.channel)(
        trustedEvent(),
        REQUEST_ID,
      ),
    ).resolves.toEqual({ completed: true });
    await expect(
      getHandler(webImportIpcContracts.discardWebImportSession.channel)(
        trustedEvent(),
        SESSION_ID,
      ),
    ).resolves.toEqual({ completed: false });
    expect(manager.cancelScan).toHaveBeenCalledWith(REQUEST_ID);
    expect(manager.discardSession).toHaveBeenCalledWith(SESSION_ID);
  });

  it("marks a rejected scan as failed without blocking the renderer", async () => {
    const { context } = createContext({
      scan: vi.fn<WebImportSessionManager["scan"]>(async () => ({
        status: "rejected",
        reason: "private-address",
      })),
    });
    const activity: Array<{ status: string; failureCode?: string }> = [];
    context.operations.subscribeActivity((event) => activity.push(event));
    registerWebImportIpc(context);

    await expect(
      getHandler(webImportIpcContracts.scanWebImport.channel)(trustedEvent(), {
        requestId: REQUEST_ID,
        url: "https://example.com/private",
      }),
    ).resolves.toEqual({ status: "rejected", reason: "private-address" });
    expect(activity.at(-1)).toMatchObject({
      status: "failed",
      failureCode: "WEB_PRIVATE_ADDRESS",
    });
  });

  it("moves preparation ownership into an import preview after reporting progress", async () => {
    const cleanup = vi.fn(async () => undefined);
    const prepareImport = vi.fn<WebImportSessionManager["prepareImport"]>(
      async (_sessionId, _selectedIds, _signal, onProgress) => {
        onProgress?.(0, 1);
        onProgress?.(1, 1);
        return {
          preview: {
            mode: "single",
            sourceKind: "images",
            suggestedWorkTitle: "Prepared web chapter",
            chapters: [
              {
                draftId: "web-draft",
                title: "Prepared web chapter",
                sourceKind: "images",
                pages: [
                  {
                    name: "1.jpg",
                    sourcePath: "C:\\private\\web-import\\1.jpg",
                    sourceKind: "file",
                    storageStem: "1",
                  },
                ],
              },
            ],
          },
          cleanup,
        };
      },
    );
    const { context } = createContext({ prepareImport });
    const activity: Array<{
      status: string;
      phase?: string;
      progressCurrent?: number;
    }> = [];
    context.operations.subscribeActivity((event) => activity.push(event));
    registerWebImportIpc(context);

    const preview = (await getHandler(
      webImportIpcContracts.prepareWebImport.channel,
    )(trustedEvent(), {
      sessionId: SESSION_ID,
      selectedCandidateIds: [CANDIDATE_ID],
    })) as { previewId: string; chapters: Array<{ pages: unknown[] }> };

    expect(prepareImport).toHaveBeenCalledWith(
      SESSION_ID,
      [CANDIDATE_ID],
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(preview.chapters[0]?.pages).toEqual([
      expect.objectContaining({ sourcePath: "web-import-staged://1" }),
    ]);
    expect(activity).toEqual([
      expect.objectContaining({ status: "running", phase: "web-preparing" }),
      expect.objectContaining({
        status: "running",
        phase: "web-preparing",
        progressCurrent: 0,
      }),
      expect.objectContaining({
        status: "running",
        phase: "web-preparing",
        progressCurrent: 1,
      }),
      expect.objectContaining({ status: "completed", phase: "web-preparing" }),
    ]);
    expect(cleanup).not.toHaveBeenCalled();
    await expect(discardImportPreviewSession(preview.previewId)).resolves.toBe(
      true,
    );
    expect(cleanup).toHaveBeenCalledOnce();
  });
});

function createContext(
  overrides: Partial<Pick<WebImportSessionManager, "scan" | "prepareImport">>,
): { context: IpcContext; manager: WebImportSessionManager } {
  const activityGate = new AppActivityGate();
  const manager = asWebImportManager({
    scan: vi.fn<WebImportSessionManager["scan"]>(),
    cancelScan: vi.fn(async () => true),
    discardSession: vi.fn(async () => false),
    prepareImport: vi.fn<WebImportSessionManager["prepareImport"]>(),
    ...overrides,
  });
  const context = {
    appPaths: {
      isPackaged: false,
      repoRoot: process.cwd(),
      executableDir: process.cwd(),
      resourcesDir: process.cwd(),
      dataRoot: process.cwd(),
      settingsPath: "settings.json",
      libraryDir: "library",
      fontsDir: "fonts",
      logsDir: "logs",
      logFile: "logs/app.log",
      runtimeDir: "runtime",
      toolsDir: "tools",
      ocrRuntimeDir: "ocr-runtime",
      llamaRuntimeDir: "llama",
      llamaServerPath: "llama/server.exe",
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
      throw new Error("not used by web import IPC tests");
    },
    decodeImage: async () => null,
    webImportManager: manager,
  } satisfies IpcContext;
  return { context, manager };
}

function asWebImportManager(value: unknown): WebImportSessionManager {
  return value as WebImportSessionManager;
}

function getHandler(channel: string): IpcHandler {
  const handler = electronBoundary.handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return handler;
}

function trustedEvent(send?: (channel: string, payload: unknown) => void) {
  return {
    sender: {
      id: 1,
      isDestroyed: () => false,
      send,
    },
    senderFrame: { url: "http://127.0.0.1:5173/" },
  };
}

function scanResult() {
  return {
    sessionId: SESSION_ID,
    pageTitle: "Web chapter",
    sourceHost: "example.com",
    candidates: [
      {
        id: CANDIDATE_ID,
        previewUrl: `mgt-import-preview://${SESSION_ID}/${CANDIDATE_ID}`,
        width: 100,
        height: 200,
        pixelCount: 20_000,
        byteSize: 1_024,
        format: "jpeg" as const,
        storedExtension: ".jpg" as const,
        pageIndex: 0,
      },
    ],
    skipped: { unsupported: 0, failed: 0, duplicate: 0, blocked: 0 },
    truncated: false,
  };
}
