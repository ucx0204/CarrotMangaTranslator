import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcContext } from "../src/main/ipc/context";

type IpcEvent = {
  sender: { id: number };
  senderFrame?: { url: string };
};
type IpcHandler = (event: IpcEvent, ...args: unknown[]) => Promise<unknown>;

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  return {
    handlers,
    clipboardWriteText: vi.fn((_text: string) => undefined),
    openExternal: vi.fn(async (_url: string) => undefined),
    showItemInFolder: vi.fn(async (_path: string) => undefined),
    relaunch: vi.fn(),
    exit: vi.fn(),
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
  };
});

vi.mock("electron", () => ({
  app: {
    exit: electronMock.exit,
    relaunch: electronMock.relaunch,
  },
  clipboard: {
    writeText: electronMock.clipboardWriteText,
  },
  ipcMain: {
    handle: electronMock.handle,
  },
  shell: {
    openExternal: electronMock.openExternal,
    showItemInFolder: electronMock.showItemInFolder,
  },
}));

vi.mock("../src/main/mainWindow", () => ({
  isAllowedMainWindowNavigation: (senderUrl: string, rendererUrl: string) =>
    new URL(senderUrl).origin === new URL(rendererUrl).origin,
}));

vi.mock("../src/main/errorReport", () => ({
  prepareErrorReportDraft: vi.fn(async () => ({
    defaultTitle: "[Bug] Test",
    errorMarkdown: "error",
    systemMarkdown: "system",
    logsMarkdown: "logs",
    redactionCount: 0,
    truncated: false,
  })),
}));

vi.mock("../src/main/logger", () => ({
  getLogPath: () => "C:\\logs\\app.log",
  writeLog: vi.fn(),
}));

vi.mock("../src/main/ipc/localization", () => ({
  tMain: (key: string) => key,
}));

import {
  buildGitHubIssueUrl,
  openErrorReportIssue,
  registerErrorReportIpc,
} from "../src/main/ipc/errorReportIpc";
import { registerLogsIpc } from "../src/main/ipc/logsIpc";

beforeEach(() => {
  electronMock.handlers.clear();
  vi.clearAllMocks();
});

describe("error report IPC", () => {
  it("prefills a short GitHub issue without touching the clipboard", async () => {
    const result = await openErrorReportIssue({
      title: "[Bug] Renderer failed",
      body: "short diagnostic",
    });
    const openedUrl = String(electronMock.openExternal.mock.calls[0]?.[0]);
    const parsed = new URL(openedUrl);

    expect(result).toEqual({ opened: true, mode: "prefilled" });
    expect(parsed.origin + parsed.pathname).toBe(
      "https://github.com/ucx0204/CarrotMangaTranslator/issues/new",
    );
    expect(parsed.searchParams.get("title")).toBe("[Bug] Renderer failed");
    expect(parsed.searchParams.get("body")).toBe("short diagnostic");
    expect(electronMock.clipboardWriteText).not.toHaveBeenCalled();
  });

  it("copies long reports and opens a short paste instruction", async () => {
    const body = "diagnostic ".repeat(1000);
    expect(buildGitHubIssueUrl("Long report", body).length).toBeGreaterThan(
      7000,
    );

    const result = await openErrorReportIssue({
      title: "Long report",
      body,
    });
    const openedUrl = new URL(
      String(electronMock.openExternal.mock.calls[0]?.[0]),
    );

    expect(result).toEqual({ opened: true, mode: "clipboard" });
    expect(electronMock.clipboardWriteText).toHaveBeenCalledWith(body);
    expect(openedUrl.searchParams.get("body")).toMatch(/clipboard/i);
    expect(openedUrl.toString().length).toBeLessThan(7000);
  });

  it("does not open the browser when clipboard fallback fails", async () => {
    electronMock.clipboardWriteText.mockImplementationOnce(() => {
      throw new Error("clipboard unavailable");
    });

    await expect(
      openErrorReportIssue({
        title: "Long report",
        body: "diagnostic ".repeat(1000),
      }),
    ).rejects.toThrow("clipboard unavailable");
    expect(electronMock.openExternal).not.toHaveBeenCalled();
  });

  it("allows main, panel, and isolated error windows but rejects unknown senders", async () => {
    const context = makeContext();
    registerErrorReportIpc(context);
    registerLogsIpc(context);
    const copy = requiredHandler("error-report:copy");
    const openLogs = requiredHandler("logs:open-folder");

    await expect(
      copy(eventFor(1, "http://127.0.0.1:5173/"), "main report"),
    ).resolves.toEqual({ copied: true });
    await expect(
      copy(eventFor(2, "http://127.0.0.1:5173/panel"), "panel report"),
    ).resolves.toEqual({ copied: true });
    await expect(openLogs(eventFor(3))).resolves.toEqual({
      opened: true,
      logPath: "C:\\logs\\app.log",
    });
    await expect(
      copy(eventFor(4, "http://127.0.0.1:5173/"), "forged report"),
    ).rejects.toThrow("ipc.errors.untrusted");
    await expect(
      copy(eventFor(2, "https://evil.example/"), "forged panel report"),
    ).rejects.toThrow("ipc.errors.untrusted");
  });

  it("rejects oversized bodies and unknown context fields at the contract boundary", async () => {
    const context = makeContext();
    registerErrorReportIpc(context);
    const copy = requiredHandler("error-report:copy");
    const prepare = requiredHandler("error-report:prepare");
    const mainEvent = eventFor(1, "http://127.0.0.1:5173/");

    await expect(copy(mainEvent, "한".repeat(21_000))).rejects.toThrow();
    await expect(
      prepare(mainEvent, { source: "manual", rawSettings: { apiKey: "no" } }),
    ).rejects.toThrow();
    expect(electronMock.clipboardWriteText).not.toHaveBeenCalled();
  });
});

function requiredHandler(channel: string): IpcHandler {
  const handler = electronMock.handlers.get(channel);
  if (!handler) {
    throw new Error(`Missing handler: ${channel}`);
  }
  return handler;
}

function eventFor(id: number, url?: string): IpcEvent {
  return {
    sender: { id },
    ...(url ? { senderFrame: { url } } : {}),
  };
}

function makeContext(): IpcContext {
  return {
    appPaths: {} as IpcContext["appPaths"],
    jobs: {} as IpcContext["jobs"],
    getMainWindow: () =>
      ({
        isDestroyed: () => false,
        webContents: {
          id: 1,
          getURL: () => "http://127.0.0.1:5173/",
        },
      }) as ReturnType<IpcContext["getMainWindow"]>,
    panelWindows: {
      isPanelSender: (id: number) => id === 2,
    } as unknown as IpcContext["panelWindows"],
    errorReportWindows: {
      isTrustedSender: (id: number) => id === 3,
    },
    loadSimplePageRuntime: vi.fn(),
    decodeImage: vi.fn(),
  };
}
