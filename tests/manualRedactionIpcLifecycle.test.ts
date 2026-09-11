import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { expect, it, vi } from "vitest";
import { registerImageRedactionWorkspaceIpc } from "../src/main/ipc/imageRedactionWorkspaceIpc";
import { releaseRedactionWorkspaceOwner } from "../src/main/ipc/redactionWorkspaceOwners";
import {
  closeRedactionWorkspace,
  openRedactionWorkspaceSession,
} from "../src/main/imageRedactionWorkspaceSessions";
import { withImageRedactionReview } from "../src/main/jobs/imageRedactionReview";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import {
  readImageRedactionState,
  saveImageRedactionPages,
  setImageRedactionEnabled,
} from "../src/main/imageRedactionStore";
import { imageRedactionIpcContracts } from "../src/shared/ipcImageRedactionContracts";
import { redactionWorkspaceSchema } from "../src/shared/imageRedactionWorkspace";
import type { JobEvent } from "../src/shared/jobTypes";
import type { MangaPage } from "../src/shared/libraryTypes";

type Handler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => Promise<unknown>;
const boundary = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }));
// Only Electron transport/image boundaries are replaced. Contracts, ownership,
// pending jobs, source hashes and both real temporary-file stores remain intact.
vi.mock("electron", () => ({
  app: { getLocale: () => "ko", isPackaged: false },
  ipcMain: {
    handle: (channel: string, handler: Handler) =>
      boundary.handlers.set(channel, handler),
  },
  nativeImage: {
    createFromBuffer: () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 20, height: 20 }),
      toDataURL: () => "data:image/png;base64,cHJldmlldw==",
    }),
  },
}));

it("opens, previews, saves and closes the owning draft through trusted validated IPC", async () => {
  boundary.handlers.clear();
  const root = await mkdtemp(join(tmpdir(), "redaction-ipc-"));
  const imagePath = join(root, "page.png");
  await writeFile(imagePath, "immutable source");
  await setImageRedactionEnabled(true, root);
  const jobId = randomUUID();
  const controller = new AbortController();
  const events: JobEvent[] = [];
  const run = vi.fn(async () => "sent");
  const page: MangaPage = {
    id: "page",
    name: "page.png",
    imagePath,
    width: 20,
    height: 20,
    blocks: [],
    dataUrl: "",
    analysisStatus: "idle",
    createdAt: "",
    updatedAt: "",
  };
  const done = withImageRedactionReview(
    {
      jobId,
      kind: "gemma-analysis",
      pages: [page],
      signal: controller.signal,
      emit: (event) => events.push(event),
    },
    run,
    {
      read: () => readImageRedactionState(root),
      save: (pages) => saveImageRedactionPages(pages, root),
      settings: async () => ({
        ...resolveDefaultAppSettings({}),
        modelProvider: "openai-api" as const,
      }),
    },
  ).catch((error: unknown) => error);
  const sender = Object.assign(new EventEmitter(), {
    id: 42,
    isDestroyed: () => false,
    getURL: () => "file:///fixture/index.html",
  });
  const event = {
    sender,
    senderFrame: { url: sender.getURL() },
  } as IpcMainInvokeEvent;
  registerImageRedactionWorkspaceIpc({
    getMainWindow: () => ({ isDestroyed: () => false, webContents: sender }),
    appPaths: { dataRoot: root },
    decodeImage: async () => null,
  });
  const invoke = (
    name: keyof typeof imageRedactionIpcContracts,
    request: unknown,
    from = event,
  ) => {
    const handler = boundary.handlers.get(
      imageRedactionIpcContracts[name].channel,
    );
    if (!handler) throw new Error("Missing registered workspace handler");
    return handler(from, request);
  };
  let sessionId: string | undefined;
  try {
    await vi.waitFor(() =>
      expect(events[0]?.imageRedactionReview).toBeTruthy(),
    );
    sessionId = events[0].imageRedactionReview?.sessionId;
    if (!sessionId) throw new Error("Expected pending review session");
    const workspace = redactionWorkspaceSchema.parse(
      await invoke("openRedactionWorkspace", { kind: "job", jobId, sessionId }),
    );
    expect(sender.listenerCount("destroyed")).toBe(1);
    expect(
      await invoke("getRedactionWorkspacePreview", {
        sessionId,
        pageId: page.id,
        maxEdge: 2048,
      }),
    ).toMatch(/^data:image/);
    const save = {
      sessionId,
      expectedRevision: workspace.revision,
      changes: workspace.pages.map(({ id, fingerprint, strokes }) => ({
        id,
        fingerprint,
        strokes,
        decision: "reviewed",
      })),
      view: workspace.view,
      preferences: workspace.preferences,
      presets: [],
    };
    await expect(
      invoke("saveRedactionWorkspace", save, {
        ...event,
        sender: { id: 43 },
      } as IpcMainInvokeEvent),
    ).rejects.toThrow();
    await expect(
      invoke("saveRedactionWorkspace", {
        ...save,
        changes: [{ ...save.changes[0], id: "foreign" }],
      }),
    ).rejects.toThrow();
    await expect(invoke("saveRedactionWorkspace", save)).resolves.toBe(1);
    controller.abort(new Error("user cancelled"));
    expect(await done).toBeInstanceOf(Error);
    await expect(invoke("closeRedactionWorkspace", sessionId)).resolves.toBe(
      true,
    );
    expect(sender.listenerCount("destroyed")).toBe(0);
    await expect(
      invoke("saveRedactionWorkspace", { ...save, expectedRevision: 1 }),
    ).rejects.toThrow("만료");
    expect(await readFile(imagePath, "utf8")).toBe("immutable source");
    expect(run).not.toHaveBeenCalled();
  } finally {
    controller.abort();
    await done;
    if (sessionId) {
      await closeRedactionWorkspace(sessionId);
      releaseRedactionWorkspaceOwner(sessionId);
    }
    await rm(root, { recursive: true, force: true });
    boundary.handlers.clear();
  }
});

it("reports an initialization failure during immediate close through the production adapter", async () => {
  const sessionId = randomUUID();
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const opening = openRedactionWorkspaceSession([], sessionId, "unused-root");
    const closing = closeRedactionWorkspace(sessionId);
    await expect(opening).rejects.toThrow("페이지 목록");
    await expect(closing).resolves.toBe(false);
    expect(report).toHaveBeenCalledWith(
      "Manual redaction session initialization failed during cleanup",
      expect.any(Error),
    );
  } finally {
    report.mockRestore();
  }
});
