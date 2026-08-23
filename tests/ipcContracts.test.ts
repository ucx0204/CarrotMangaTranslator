import { shell, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { beforeEach, expect, it, vi } from "vitest";
import { AppActivityGate } from "../src/main/appActivityGate";
import { AppOperationRegistry } from "../src/main/appOperationRegistry";
import type { AppPaths } from "../src/main/appPaths";
import type { IpcContext } from "../src/main/ipc/context";
import {
  createContractInvoker,
  type ContractInvoker,
  type IpcInvokePort,
} from "../src/preload/ipcContracts";
import { createMangaApi, type IpcEventPort } from "../src/preload/mangaApi";
import {
  ipcEventContracts,
  inpaintingIpcContracts,
  importShareIpcContracts,
  ipcInvokeContracts,
  libraryIpcContracts,
  pageImageExportIpcContracts,
  type IpcContract,
} from "../src/shared/ipcContracts";
import { defineIpcContract } from "../src/shared/ipcContractCore";

type InvokeHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => Promise<unknown> | unknown;

const electronBoundary = vi.hoisted(() => {
  const handlers = new Map<string, InvokeHandler>();
  const handle = vi.fn((channel: string, handler: InvokeHandler) => {
    if (handlers.has(channel)) {
      throw new Error(`Duplicate IPC handler: ${channel}`);
    }
    handlers.set(channel, handler);
  });
  return { handle, handlers };
});

vi.mock("electron", () => ({
  app: {
    exit: vi.fn(),
    getLocale: () => "ko",
    getPath: () => "C:\\test",
    getVersion: () => "1.0.0",
    isPackaged: false,
    relaunch: vi.fn(),
  },
  BrowserWindow: class {
    static getAllWindows(): unknown[] {
      return [];
    }
  },
  clipboard: { writeText: vi.fn() },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
  },
  ipcMain: { handle: electronBoundary.handle },
  nativeImage: {},
  protocol: {},
  screen: { getAllDisplays: () => [] },
  shell: {
    openExternal: vi.fn(),
    openPath: vi.fn(),
    showItemInFolder: vi.fn(),
  },
}));

const invokeContractEntries = Object.entries(ipcInvokeContracts);

beforeEach(() => {
  electronBoundary.handle.mockClear();
  electronBoundary.handlers.clear();
  vi.mocked(shell.openExternal).mockClear();
});

it("requires an explicit invalidation state for history transaction results", () => {
  const result = {
    transactionId: "11111111-1111-4111-8111-111111111111",
    direction: "undo",
    chapters: [],
    pagesChanged: 2,
    invalidated: true,
  };

  expect(
    inpaintingIpcContracts.applyInpaintingHistoryTransaction.result.parse(
      result,
    ),
  ).toEqual(result);
  expect(
    inpaintingIpcContracts.applyInpaintingHistoryTransaction.result.safeParse({
      ...result,
      invalidated: undefined,
    }).success,
  ).toBe(false);
});

it("accepts the missing-inpainting issue returned by textless export preflight", () => {
  const result = {
    workTitle: "테스트 작품",
    chapterCount: 1,
    pageCount: 1,
    sampleRelativePath: "001-1화\\001-page.png",
    outputPolicy: "new-timestamped-folder" as const,
    issues: [
      {
        code: "inpainted-image-missing" as const,
        severity: "warning" as const,
        chapterId: "chapter-1",
        chapterTitle: "1화",
        pageId: "page-1",
        pageName: "page.png",
      },
    ],
    targets: [],
  };

  expect(
    pageImageExportIpcContracts.preflightPageImages.result.parse(result),
  ).toEqual(result);
});

it("keeps invoke API keys and channels unique and explicit", () => {
  const keys = invokeContractEntries.map(([, contract]) => contract.apiKey);
  const channels = invokeContractEntries.map(
    ([, contract]) => contract.channel,
  );

  expect(new Set(keys).size).toBe(keys.length);
  expect(new Set(channels).size).toBe(channels.length);
  for (const [name, contract] of invokeContractEntries) {
    expect(contract.apiKey).toBe(name);
  }
});

it("binds every preload invoke API to its contract and forwards arguments", () => {
  const calls: Array<{
    contract: IpcContract;
    args: unknown[];
  }> = [];
  const invoke: ContractInvoker = (contract, ...args) => {
    calls.push({ contract, args });
    return new Promise<never>(() => undefined);
  };
  const api = createMangaApi({
    invoke,
    events: createEventBoundary().port,
    getPathForFile: vi.fn(() => "C:\\fixture\\page.png"),
    warn: vi.fn(),
  });

  for (const contract of Object.values(ipcInvokeContracts)) {
    const marker = { apiKey: contract.apiKey };
    const method = api[contract.apiKey];
    expect(typeof method).toBe("function");
    Reflect.apply(method, api, [marker]);
    expect(calls.at(-1)).toEqual({ contract, args: [marker] });
  }
});

it("resolves dropped File paths locally without sending File objects over IPC", () => {
  const invoke = vi.fn(async () => undefined);
  const getPathForFile = vi.fn(() => "C:\\fixture\\page.png");
  const api = createMangaApi({
    invoke: createContractInvoker({ invoke }),
    events: createEventBoundary().port,
    getPathForFile,
    warn: vi.fn(),
  });
  const file = { name: "page.png" } as File;

  expect(api.getPathForFile(file)).toBe("C:\\fixture\\page.png");
  expect(getPathForFile).toHaveBeenCalledWith(file);
  expect(invoke).not.toHaveBeenCalled();
});

it("caps dropped path lists at the shared IPC list limit", () => {
  const paths = Array.from(
    { length: 2000 },
    (_, index) => `C:\\fixture\\${index}.png`,
  );

  expect(
    importShareIpcContracts.previewDroppedImport.args.safeParse([paths])
      .success,
  ).toBe(true);
  expect(
    importShareIpcContracts.previewDroppedImport.args.safeParse([
      [...paths, "C:\\fixture\\overflow.png"],
    ]).success,
  ).toBe(false);
});

it("validates preload arguments before invoking the renderer boundary", async () => {
  const invoke = vi.fn(
    async (_channel: string, ..._args: unknown[]): Promise<unknown> => ({
      ok: true,
    }),
  );
  const invokeContract = createContractInvoker({
    invoke,
  } satisfies IpcInvokePort);

  expect(() =>
    invokeContract(libraryIpcContracts.renameWork, "", "제목"),
  ).toThrow();
  expect(invoke).not.toHaveBeenCalled();

  await invokeContract(libraryIpcContracts.renameWork, "work-1", "제목");
  expect(invoke).toHaveBeenCalledWith(
    libraryIpcContracts.renameWork.channel,
    "work-1",
    "제목",
  );
});

it("registers and removes every preload event listener on its contract channel", () => {
  const boundary = createEventBoundary();
  const api = createMangaApi({
    invoke: pendingInvoker,
    events: boundary.port,
    getPathForFile: vi.fn(() => "C:\\fixture\\page.png"),
    warn: vi.fn(),
  });
  const subscriptions = [
    ["onErrorIncident", ipcEventContracts.errorIncident],
    ["onFontLibraryChanged", ipcEventContracts.fontLibraryChanged],
    ["onUiLocaleChanged", ipcEventContracts.uiLocaleChanged],
    ["onJobEvent", ipcEventContracts.jobEvent],
    ["onModelTestEvent", ipcEventContracts.modelTestProgress],
    ["onWebImportProgress", ipcEventContracts.webImportProgress],
    ["onPanelState", ipcEventContracts.panelState],
    ["onPanelCommand", ipcEventContracts.panelCommand],
    ["onPanelWindowsChanged", ipcEventContracts.panelWindowsChanged],
  ] as const;

  for (const [apiKey, contract] of subscriptions) {
    const unsubscribe = Reflect.apply(api[apiKey], api, [vi.fn()]);
    const listener = boundary.listeners.get(contract.channel);
    expect(listener).toBeTypeOf("function");
    expect(boundary.on).toHaveBeenLastCalledWith(contract.channel, listener);
    unsubscribe();
    expect(boundary.removeListener).toHaveBeenLastCalledWith(
      contract.channel,
      listener,
    );
  }
});

it("delivers only payloads accepted by the event contract", () => {
  const boundary = createEventBoundary();
  const warn = vi.fn();
  const callback = vi.fn();
  const api = createMangaApi({
    invoke: pendingInvoker,
    events: boundary.port,
    getPathForFile: vi.fn(() => "C:\\fixture\\page.png"),
    warn,
  });
  api.onUiLocaleChanged(callback);
  const listener = boundary.listeners.get(
    ipcEventContracts.uiLocaleChanged.channel,
  );
  if (!listener) {
    throw new Error("UI locale listener was not registered.");
  }

  listener({}, "ko");
  listener({}, "not-a-locale");

  expect(callback).toHaveBeenCalledOnce();
  expect(callback).toHaveBeenCalledWith("ko");
  expect(warn).toHaveBeenCalledWith("Invalid uiLocaleChanged payload ignored");
});

it("registers exactly one main handler for every invoke contract", async () => {
  const [{ registerIpc }, { ActiveJobStore }, { InpaintingRevisionStore }] =
    await Promise.all([
      import("../src/main/ipc/registerIpc"),
      import("../src/main/jobs/activeJob"),
      import("../src/main/inpainting/inpaintingRevisionStore"),
    ]);
  const context = createIpcContext(
    new ActiveJobStore(),
    new InpaintingRevisionStore(),
  );

  registerIpc(context);

  const registeredChannels = [...electronBoundary.handlers.keys()].sort();
  const expectedChannels = Object.values(ipcInvokeContracts)
    .map((contract) => contract.channel)
    .sort();
  expect(registeredChannels).toEqual(expectedChannels);
  expect(electronBoundary.handle).toHaveBeenCalledTimes(
    expectedChannels.length,
  );
});

it("routes a full block-library update through the registered handler", async () => {
  const [
    { registerBlockLibraryIpc },
    { ActiveJobStore },
    { InpaintingRevisionStore },
  ] = await Promise.all([
    import("../src/main/ipc/blockLibraryIpc"),
    import("../src/main/jobs/activeJob"),
    import("../src/main/inpainting/inpaintingRevisionStore"),
  ]);
  const context = createIpcContext(
    new ActiveJobStore(),
    new InpaintingRevisionStore(),
  );
  context.appPaths = {
    ...context.appPaths,
    dataRoot: `C:\\test\\missing-block-library-${Date.now()}`,
  };
  context.isErrorReportSender = (webContentsId) => webContentsId === 23;
  registerBlockLibraryIpc(context);
  const handler = electronBoundary.handlers.get(
    ipcInvokeContracts.updateBlockLibraryEntry.channel,
  );
  if (!handler) throw new Error("Block library update handler is missing.");

  await expect(
    handler(
      {
        sender: { id: 23 },
      } as IpcMainInvokeEvent,
      {
        id: "missing-entry",
        name: "수정",
        block: {
          sourceText: "原文",
          translatedText: "번역",
          sourceDirection: "horizontal",
          renderDirection: "horizontal",
          fontSizePx: 48,
          lineHeight: 1.2,
          textAlign: "center",
          textColor: "#111111",
          backgroundColor: "#ffffff",
          opacity: 0.7,
          size: { w: 100, h: 100 },
        },
      },
    ),
  ).rejects.toThrow("블록 라이브러리 항목을 찾을 수 없습니다");
});

it("opens only allowlisted Vertex setup pages", async () => {
  const { registerExternalLinksIpc } =
    await import("../src/main/ipc/externalLinksIpc");
  const rendererUrl = "http://127.0.0.1:5173/";
  const context = {
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: { getURL: () => rendererUrl, id: 23 },
    }),
  } as IpcContext;
  registerExternalLinksIpc(context);
  const contract = ipcInvokeContracts.openVertexSetupPage;
  const handler = electronBoundary.handlers.get(contract.channel);
  if (!handler) {
    throw new Error("Vertex setup page handler was not registered.");
  }
  const event = {
    sender: { id: 23 },
    senderFrame: { url: rendererUrl },
  } as IpcMainInvokeEvent;
  const pages = [
    ["project-create", "https://console.cloud.google.com/projectcreate"],
    [
      "vertex-ai-api",
      "https://console.cloud.google.com/marketplace/product/google/aiplatform.googleapis.com",
    ],
    [
      "service-accounts",
      "https://console.cloud.google.com/iam-admin/serviceaccounts",
    ],
  ] as const;

  for (const [page, url] of pages) {
    await expect(handler(event, page)).resolves.toEqual({
      opened: true,
      url,
    });
    expect(shell.openExternal).toHaveBeenLastCalledWith(url);
  }

  await expect(handler(event, "https://attacker.example")).rejects.toThrow();
  expect(shell.openExternal).toHaveBeenCalledTimes(pages.length);
});

it("validates main handler arguments and results at the registered boundary", async () => {
  const { trustedHandleContract } = await import("../src/main/ipc/trustedIpc");
  const contract = defineIpcContract<[string], unknown>({
    apiKey: "openChapter",
    channel: "test:contract-boundary",
    args: z.tuple([z.string().min(1)]),
    result: z.object({ accepted: z.boolean() }).strict(),
  });
  let nextResult: unknown = { accepted: true };
  const listener = vi.fn(
    (_event: IpcMainInvokeEvent, _value: string) => nextResult,
  );
  const rendererUrl = "http://127.0.0.1:5173/";
  trustedHandleContract(
    {
      getMainWindow: () => ({
        isDestroyed: () => false,
        webContents: { getURL: () => rendererUrl, id: 17 },
      }),
    },
    contract,
    listener,
    {
      isAllowedNavigation: (targetUrl, allowedUrl) => targetUrl === allowedUrl,
      translate: (key) => key,
    },
  );
  const handler = electronBoundary.handlers.get(contract.channel);
  if (!handler) {
    throw new Error("Contract handler was not registered.");
  }
  const event = {
    sender: { id: 17 },
    senderFrame: { url: rendererUrl },
  } as IpcMainInvokeEvent;

  await expect(handler(event, "")).rejects.toThrow();
  expect(listener).not.toHaveBeenCalled();
  await expect(handler(event, "valid")).resolves.toEqual({ accepted: true });
  expect(listener).toHaveBeenCalledWith(event, "valid");
  nextResult = { accepted: true, unexpected: true };
  await expect(handler(event, "invalid-result")).rejects.toThrow();
});

const pendingInvoker: ContractInvoker = () =>
  new Promise<never>(() => undefined);

function createEventBoundary(): {
  listeners: Map<string, (event: unknown, payload: unknown) => void>;
  on: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  port: IpcEventPort;
} {
  const listeners = new Map<
    string,
    (event: unknown, payload: unknown) => void
  >();
  const on = vi.fn(
    (channel: string, listener: (event: unknown, payload: unknown) => void) => {
      listeners.set(channel, listener);
    },
  );
  const removeListener = vi.fn(
    (channel: string, listener: (event: unknown, payload: unknown) => void) => {
      if (listeners.get(channel) === listener) {
        listeners.delete(channel);
      }
    },
  );
  return {
    listeners,
    on,
    removeListener,
    port: { on, removeListener },
  };
}

function createIpcContext(
  jobs: IpcContext["jobs"],
  inpaintingRevisionStore: IpcContext["inpaintingRevisionStore"],
): IpcContext {
  return {
    appPaths: createAppPaths(),
    jobs,
    operations: new AppOperationRegistry(new AppActivityGate()),
    getMainWindow: () => null,
    panelWindows: {
      close: () => false,
      closeAll: () => undefined,
      getLastState: () => null,
      getOpenPanelIds: () => [],
      isPanelSender: () => false,
      open: () => true,
      publishState: () => undefined,
    },
    loadSimplePageRuntime: () => {
      throw new Error("Runtime loading is not used during IPC registration.");
    },
    decodeImage: async () => null,
    inpaintingRevisionStore,
  };
}

function createAppPaths(): AppPaths {
  return {
    isPackaged: false,
    repoRoot: "C:\\test",
    executableDir: "C:\\test",
    resourcesDir: "C:\\test\\resources",
    dataRoot: "C:\\test\\data",
    settingsPath: "C:\\test\\data\\settings.json",
    libraryDir: "C:\\test\\data\\library",
    fontsDir: "C:\\test\\data\\fonts",
    logsDir: "C:\\test\\data\\logs",
    logFile: "C:\\test\\data\\logs\\app.log",
    runtimeDir: "C:\\test\\runtime",
    toolsDir: "C:\\test\\tools",
    ocrRuntimeDir: "C:\\test\\ocr",
    llamaRuntimeDir: "C:\\test\\llama",
    llamaServerPath: "C:\\test\\llama\\server.exe",
  };
}
