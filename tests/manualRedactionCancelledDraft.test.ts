import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import {
  confirmImageRedaction,
  openPendingRedactionWorkspace,
  withImageRedactionReview,
} from "../src/main/jobs/imageRedactionReview";
import {
  closeRedactionWorkspace,
  openRedactionWorkspaceSession,
  saveRedactionWorkspace,
} from "../src/main/imageRedactionWorkspaceSessions";
import { readRedactionWorkspaceStore } from "../src/main/imageRedactionWorkspaceStore";
import {
  ownRedactionWorkspace,
  releaseRedactionWorkspaceOwner,
} from "../src/main/ipc/redactionWorkspaceOwners";
import type { JobEvent } from "../src/shared/jobTypes";
import type { MangaPage } from "../src/shared/libraryTypes";

vi.mock("electron", () => ({ nativeImage: {} }));
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function pageFixture() {
  const root = await mkdtemp(join(tmpdir(), "cancelled-redaction-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const imagePath = join(root, "page.png");
  await writeFile(imagePath, "source");
  const page: MangaPage = {
    id: "a",
    name: "page.png",
    imagePath,
    width: 10,
    height: 10,
    blocks: [],
    dataUrl: "",
    analysisStatus: "idle",
    createdAt: "",
    updatedAt: "",
  };
  return { root, page };
}
it("keeps late draft saves after cancellation but permanently rejects the cancelled job's approval", async () => {
  const { root, page } = await pageFixture();
  const jobId = randomUUID();
  const controller = new AbortController();
  const events: JobEvent[] = [];
  const run = vi.fn(async () => "sent");
  const approved = vi.fn(async () => {});
  const settings = {
    ...resolveDefaultAppSettings({}),
    modelProvider: "openai-api" as const,
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
      read: async () => ({ version: 1, enabled: true, pages: {} }),
      save: approved,
      settings: async () => settings,
    },
  ).then(
    () => null,
    (error: unknown) => error,
  );
  cleanups.push(async () => {
    controller.abort();
    await done;
  });
  await vi.waitFor(() => expect(events[0]?.imageRedactionReview).toBeTruthy());
  const review = events[0]?.imageRedactionReview;
  if (!review) throw new Error("Expected a review event");
  const sessionId = review.sessionId;
  cleanups.push(() => closeRedactionWorkspace(sessionId));
  const workspace = await openPendingRedactionWorkspace(jobId, sessionId, root);
  controller.abort(new Error("external cancellation"));
  expect(await done).toBeInstanceOf(Error);
  const pages = workspace.pages.map(({ id, fingerprint }) => ({
    id,
    fingerprint,
    decision: "reviewed" as const,
    strokes: [
      {
        shape: "rectangle" as const,
        size: 1,
        points: [
          { x: 1, y: 1 },
          { x: 5, y: 5 },
        ],
      },
    ],
  }));
  const revision = await saveRedactionWorkspace({
    sessionId,
    expectedRevision: workspace.revision,
    changes: pages,
    view: workspace.view,
    preferences: workspace.preferences,
    presets: [],
  });
  expect(
    (await readRedactionWorkspaceStore(root)).pages[page.imagePath].strokes,
  ).toEqual(pages[0].strokes);
  await expect(
    confirmImageRedaction({
      jobId,
      sessionId,
      workspaceRevision: revision,
      pages: pages.map(({ id, fingerprint, strokes }) => ({
        id,
        fingerprint,
        strokes,
      })),
    }),
  ).rejects.toThrow("만료");
  expect(run).not.toHaveBeenCalled();
  expect(approved).not.toHaveBeenCalled();
});
it("releases window-owned sessions when the renderer exits and removes unused listeners", async () => {
  const { root, page } = await pageFixture();
  const sender = Object.assign(new EventEmitter(), {
    id: 12,
    isDestroyed: () => false,
  });
  const sessionId = randomUUID();
  const workspace = await openRedactionWorkspaceSession(
    [
      {
        id: page.id,
        name: page.name,
        imagePath: page.imagePath,
        width: page.width,
        height: page.height,
        strokes: [],
        fingerprint: createHash("sha256").update("source").digest("hex"),
      },
    ],
    sessionId,
    root,
  );
  cleanups.push(async () => {
    await closeRedactionWorkspace(sessionId);
    releaseRedactionWorkspaceOwner(sessionId);
  });
  await ownRedactionWorkspace(sender, sessionId);
  expect(sender.listenerCount("destroyed")).toBe(1);
  sender.emit("render-process-gone");
  expect(sender.listenerCount("destroyed")).toBe(0);
  await expect(
    saveRedactionWorkspace({
      sessionId,
      expectedRevision: workspace.revision,
      changes: [],
      view: workspace.view,
      preferences: workspace.preferences,
      presets: [],
    }),
  ).rejects.toThrow("만료");
});
