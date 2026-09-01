import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveJobStore } from "../src/main/jobs/activeJob";
import type { IpcContext } from "../src/main/ipc/context";
import { registerTranslationJobIpc } from "../src/main/ipc/translationJobIpc";
import { translationJobIpcContracts } from "../src/shared/ipcContracts";

type CapturedHandler = (
  event: unknown,
  ...args: unknown[]
) => Promise<unknown> | unknown;

const ipcMocks = vi.hoisted(() => ({
  handlers: new Map<string, CapturedHandler>(),
  handle: vi.fn((channel: string, handler: CapturedHandler) => {
    ipcMocks.handlers.set(channel, handler);
  }),
}));

vi.mock("electron", () => ({
  app: { isPackaged: false },
  BrowserWindow: class {},
  ipcMain: { handle: ipcMocks.handle },
}));

beforeEach(() => {
  ipcMocks.handlers.clear();
  ipcMocks.handle.mockClear();
});

describe("sound-effect translation IPC", () => {
  it("parses the dedicated request through the real trusted job boundary", async () => {
    const jobs = new ActiveJobStore();
    jobs.start({
      id: "busy-job",
      kind: "gemma-analysis",
      abortController: new AbortController(),
    });
    registerTranslationJobIpc(makeContext(jobs));
    const handler = ipcMocks.handlers.get(
      translationJobIpcContracts.startSoundEffectTranslation.channel,
    );
    if (!handler) throw new Error("Expected sound-effect IPC handler.");
    const request = {
      chapterId: CHAPTER_ID,
      targets: [
        {
          pageId: PAGE_ID,
          pageRevision: "page-v1:0000000000000000",
          regionIds: ["FX001"],
        },
      ],
      inpaintAfterTranslation: false,
      autoFontMatching: true,
    };

    const event = {
      sender: { id: 17 },
      senderFrame: { url: "http://127.0.0.1:5173/" },
    };

    await expect(handler(event, request)).resolves.toMatchObject({
      status: "failed",
      createdBlocksByPage: [],
      translatedRegionCount: 0,
      error: expect.any(String),
    });
    expect(jobs.current?.id).toBe("busy-job");

    await expect(
      handler(event, {
        ...request,
        targets: [request.targets[0], request.targets[0]],
      }),
    ).rejects.toThrow();
    jobs.clearIfCurrent("busy-job");
  });
});

const CHAPTER_ID = "00000000-0000-4000-8000-000000000001";
const PAGE_ID = "00000000-0000-4000-8000-000000000002";

function makeContext(jobs: ActiveJobStore): IpcContext {
  const context: IpcContext = Object.create(null);
  const mainWindow = makeWindow();
  Object.defineProperties(context, {
    decodeImage: { value: vi.fn() },
    getMainWindow: { value: () => mainWindow },
    jobs: { value: jobs },
  });
  return context;
}

function makeWindow(): BrowserWindow {
  const browserWindow: BrowserWindow = Object.create(null);
  Object.defineProperties(browserWindow, {
    isDestroyed: { value: () => false },
    webContents: {
      value: {
        getURL: () => "http://127.0.0.1:5173/",
        id: 17,
        isDestroyed: () => false,
      },
    },
  });
  return browserWindow;
}
