import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerPageImageExportIpc,
  type PageImageExportService,
} from "../src/main/ipc/pageImageExportIpc";
import type { IpcContext } from "../src/main/ipc/context";

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
  dialog: { showOpenDialog: electronBoundary.showOpenDialog },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => {
      electronBoundary.handlers.set(channel, handler);
    },
  },
  nativeImage: {},
  shell: { openPath: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
  electronBoundary.handlers.clear();
});

describe("page image export IPC contracts", () => {
  it("validates and delegates export preflight", async () => {
    const service = makeService();
    service.preflight.mockResolvedValue({
      workTitle: "Work",
      chapterCount: 1,
      pageCount: 1,
      sampleRelativePath: "Chapter 1\\001.png",
      outputPolicy: "new-timestamped-folder",
      issues: [],
      targets: [],
    });
    registerPageImageExportIpc(makeContext(), service);

    await expect(
      electronBoundary.handlers
        .get("page-images:preflight")
        ?.call(undefined, trustedEvent(), exportRequest()),
    ).resolves.toMatchObject({ workTitle: "Work", pageCount: 1 });
    expect(service.preflight).toHaveBeenCalledWith({
      ...exportRequest(),
      expectedTargets: undefined,
    });
  });

  it("delegates PSD export through the selected-directory boundary", async () => {
    electronBoundary.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["D:\\exports"],
    });
    const service = makeService();
    service.exportPsd.mockResolvedValue({
      status: "completed",
      outputDir: "D:\\exports\\psd",
      pageCount: 1,
    });
    registerPageImageExportIpc(makeContext(), service);

    await expect(
      electronBoundary.handlers
        .get("page-images:export-psd")
        ?.call(undefined, trustedEvent(), exportRequest()),
    ).resolves.toMatchObject({
      status: "completed",
      outputDir: "D:\\exports\\psd",
    });
    expect(service.exportPsd).toHaveBeenCalledWith(
      exportRequest(),
      "D:\\exports",
    );
  });
});

function makeService() {
  return {
    assertIdle: vi.fn<PageImageExportService["assertIdle"]>(),
    preflight: vi.fn<PageImageExportService["preflight"]>(),
    exportImages: vi.fn<PageImageExportService["exportImages"]>(),
    exportPsd: vi.fn<PageImageExportService["exportPsd"]>(),
  };
}

function makeContext(): IpcContext {
  const mainWindow = {
    isDestroyed: () => false,
    webContents: {
      id: 1,
      getURL: () => "http://127.0.0.1:5173/",
    },
  } as ReturnType<IpcContext["getMainWindow"]>;
  const context: IpcContext = Object.create(null);
  context.appPaths = { dataRoot: "C:\\data" } as IpcContext["appPaths"];
  context.getMainWindow = () => mainWindow;
  return context;
}

function exportRequest() {
  return {
    workId: "11111111-1111-4111-8111-111111111111",
    selections: [
      {
        chapterId: "22222222-2222-4222-8222-222222222222",
        mode: "all" as const,
      },
    ],
  };
}

function trustedEvent(): Parameters<IpcHandler>[0] {
  return {
    sender: { id: 1 },
    senderFrame: { url: "http://127.0.0.1:5173/" },
  };
}
