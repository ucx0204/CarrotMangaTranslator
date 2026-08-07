import { BrowserWindow } from "electron";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppActivityGate } from "../src/main/appActivityGate";
import { AppOperationRegistry } from "../src/main/appOperationRegistry";
import { ActiveJobStore } from "../src/main/jobs/activeJob";
import type { IpcContext } from "../src/main/ipc/context";
import {
  registerFontsIpc,
  type FontRegistrationService,
} from "../src/main/ipc/fontsIpc";
import type {
  CustomFont,
  FontLibrarySnapshot,
} from "../src/shared/libraryTypes";

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
  BrowserWindow: class {
    readonly webContents = {
      id: 1,
      getURL: () => rendererUrl,
    };

    static getAllWindows(): unknown[] {
      return [];
    }

    isDestroyed(): boolean {
      return false;
    }
  },
  dialog: { showOpenDialog: electronBoundary.showOpenDialog },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => {
      electronBoundary.handlers.set(channel, handler);
    },
  },
}));

const rendererUrl = "http://127.0.0.1:5173/";
const registeredFont: CustomFont = {
  id: "font-1",
  label: "Test Font",
  family: "MGTUser-font-1",
  fileName: "font-1.ttf",
};
const fontSnapshot: FontLibrarySnapshot = {
  customFonts: [registeredFont],
  preferences: {
    favoriteIds: [],
    orderedIds: [],
    defaultFontId: "builtin-default",
  },
};
const tempDirectories: string[] = [];

beforeEach(() => {
  electronBoundary.handlers.clear();
  electronBoundary.showOpenDialog.mockReset();
});

afterEach(async () => {
  for (const directory of tempDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("font registration recent directory", () => {
  it("reopens in the source folder after a font is registered successfully", async () => {
    const { dataRoot, fontDirectory, fontPath } =
      await makeFontFixture("fonts-ipc-success-");
    const service = makeFontRegistrationService();
    service.registerCustomFontFromFile.mockReturnValue(registeredFont);
    electronBoundary.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: [fontPath] })
      .mockResolvedValueOnce({ canceled: true, filePaths: [] });
    const handler = registerAndGetFontHandler(dataRoot, service);

    await expect(handler(trustedEvent())).resolves.toEqual(registeredFont);
    await expect(handler(trustedEvent())).resolves.toBeNull();

    expect(service.registerCustomFontFromFile).toHaveBeenCalledExactlyOnceWith(
      fontPath,
    );
    expect(electronBoundary.showOpenDialog.mock.calls[1]?.[1]).toMatchObject({
      defaultPath: fontDirectory,
    });
  });

  it("does not remember the source folder when font registration fails", async () => {
    const { dataRoot, fontPath } = await makeFontFixture("fonts-ipc-failure-");
    const service = makeFontRegistrationService();
    service.registerCustomFontFromFile.mockImplementationOnce(() => {
      throw new Error("invalid font");
    });
    electronBoundary.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: [fontPath] })
      .mockResolvedValueOnce({ canceled: true, filePaths: [] });
    const handler = registerAndGetFontHandler(dataRoot, service);

    await expect(handler(trustedEvent())).rejects.toThrow("invalid font");
    await expect(handler(trustedEvent())).resolves.toBeNull();

    expect(electronBoundary.showOpenDialog.mock.calls[1]?.[1]).toMatchObject({
      defaultPath: undefined,
    });
  });
});

async function makeFontFixture(prefix: string): Promise<{
  dataRoot: string;
  fontDirectory: string;
  fontPath: string;
}> {
  const dataRoot = await mkdtemp(join(tmpdir(), prefix));
  tempDirectories.push(dataRoot);
  const fontDirectory = join(dataRoot, "source-fonts");
  const fontPath = join(fontDirectory, "selected.ttf");
  await mkdir(fontDirectory, { recursive: true });
  await writeFile(fontPath, "font fixture");
  return { dataRoot, fontDirectory, fontPath };
}

function registerAndGetFontHandler(
  dataRoot: string,
  service: FontRegistrationService,
): IpcHandler {
  registerFontsIpc(makeContext(dataRoot), service);
  const handler = electronBoundary.handlers.get("fonts:register");
  if (!handler) {
    throw new Error("fonts:register handler was not registered");
  }
  return handler;
}

function makeFontRegistrationService() {
  return {
    getFontLibrarySnapshot: vi.fn<
      FontRegistrationService["getFontLibrarySnapshot"]
    >(() => fontSnapshot),
    registerCustomFontFromFile:
      vi.fn<FontRegistrationService["registerCustomFontFromFile"]>(),
  };
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
      ocrRuntimeDir: join(dataRoot, "ocr"),
      llamaRuntimeDir: join(dataRoot, "llama"),
      llamaServerPath: join(dataRoot, "llama", "server.exe"),
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
      throw new Error("not used by font IPC");
    },
    decodeImage: async () => null,
  };
}

function trustedEvent(): Parameters<IpcHandler>[0] {
  return {
    sender: { id: 1 },
    senderFrame: { url: rendererUrl },
  };
}
