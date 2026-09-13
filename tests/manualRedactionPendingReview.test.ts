import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import {
  withImageRedactionReview,
  openPendingRedactionWorkspace,
  confirmImageRedaction,
} from "../src/main/jobs/imageRedactionReview";
import { saveReviewedRequest } from "./helpers/redactionReviewApproval";
import {
  closeRedactionWorkspace,
  saveRedactionWorkspace,
} from "../src/main/imageRedactionWorkspaceSessions";
import {
  readImageRedactionState,
  saveImageRedactionPages,
  setImageRedactionEnabled,
} from "../src/main/imageRedactionStore";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { JobEvent } from "../src/shared/jobTypes";
import type { ImageRedactionPage } from "../src/shared/imageRedaction";

// Reviewing metadata must not decode or transmit an image. Only the unused
// Electron boundary is substituted; pending jobs and both file stores are real.
vi.mock("electron", () => ({ nativeImage: {} }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(
  options: { enabled?: boolean; local?: boolean; imageEdit?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "pending-redaction-"));
  const imagePath = join(root, "page.png");
  await writeFile(imagePath, "immutable original bytes");
  await setImageRedactionEnabled(options.enabled ?? true, root);
  const page: MangaPage = {
    id: "page",
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
  const settings = resolveDefaultAppSettings({});
  settings.modelProvider = options.local ? "gemma" : "openai-api";
  const save = vi.fn(async (pages: readonly ImageRedactionPage[]) =>
    saveImageRedactionPages(pages, root),
  );
  const controller = new AbortController();
  const events: JobEvent[] = [];
  const jobId = randomUUID();
  const run = vi.fn(async () => "resumed");
  const done = withImageRedactionReview(
    {
      jobId,
      kind: "gemma-analysis",
      pages: [page],
      signal: controller.signal,
      emit: (event) => events.push(event),
      imageEdit: options.imageEdit,
    },
    run,
    {
      read: () => readImageRedactionState(root),
      save,
      settings: async () => settings,
    },
  ).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  cleanups.push(async () => {
    controller.abort(new Error("test cleanup"));
    await done;
    await rm(root, { recursive: true, force: true });
  });
  const request = () => {
    const review = events.at(-1)?.imageRedactionReview;
    if (!review) throw new Error("Expected a pending review");
    return {
      jobId,
      sessionId: review.sessionId,
      pages: review.pages.map(({ id, fingerprint, strokes }) => ({
        id,
        fingerprint,
        strokes,
      })),
    };
  };
  return { root, run, save, done, events, request, controller };
}

it("opens the owning pending workspace, requires a saved review and closes it after explicit resume", async () => {
  const f = await fixture();
  await vi.waitFor(() => expect(f.events).toHaveLength(1));
  const request = f.request();
  await expect(
    openPendingRedactionWorkspace(randomUUID(), request.sessionId, f.root),
  ).rejects.toThrow("만료");
  await expect(
    openPendingRedactionWorkspace(request.jobId, randomUUID(), f.root),
  ).rejects.toThrow("만료");
  const workspace = await openPendingRedactionWorkspace(
    request.jobId,
    request.sessionId,
    f.root,
  );
  expect(workspace.pages[0].decision).toBe("unreviewed");
  expect(f.run).not.toHaveBeenCalled();
  await expect(confirmImageRedaction(request)).rejects.toThrow();
  const revision = await saveRedactionWorkspace({
    sessionId: workspace.sessionId,
    expectedRevision: workspace.revision,
    changes: request.pages.map((page) => ({
      ...page,
      decision: "reviewed" as const,
    })),
    view: workspace.view,
    preferences: workspace.preferences,
    presets: [],
  });
  await expect(
    confirmImageRedaction({ ...request, workspaceRevision: revision }),
  ).resolves.toBe(true);
  await expect(f.done).resolves.toEqual({ value: "resumed" });
  expect(f.run).toHaveBeenCalledOnce();
  await expect(
    openPendingRedactionWorkspace(request.jobId, request.sessionId, f.root),
  ).rejects.toThrow("만료");
});

it("does not reopen a pending job while its confirmation is being saved", async () => {
  const f = await fixture();
  await vi.waitFor(() => expect(f.events).toHaveLength(1));
  const request = await saveReviewedRequest(f.root, f.request());
  let release!: () => void;
  f.save.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const saving = confirmImageRedaction(request);
  await vi.waitFor(() => expect(f.save).toHaveBeenCalledOnce());
  try {
    await expect(
      openPendingRedactionWorkspace(request.jobId, request.sessionId, f.root),
    ).rejects.toThrow("저장");
    expect(f.run).not.toHaveBeenCalled();
  } finally {
    release();
  }
  await expect(saving).resolves.toBe(true);
  await expect(f.done).resolves.toEqual({ value: "resumed" });
});

it("bypasses disabled review but still requires review for local-provider image editing", async () => {
  const disabled = await fixture({ enabled: false });
  await expect(disabled.done).resolves.toEqual({ value: "resumed" });
  expect(disabled.events).toHaveLength(0);
  const imageEdit = await fixture({ local: true, imageEdit: true });
  await vi.waitFor(() => expect(imageEdit.events).toHaveLength(1));
  expect(imageEdit.run).not.toHaveBeenCalled();
  await confirmImageRedaction(
    await saveReviewedRequest(imageEdit.root, imageEdit.request()),
  );
  await expect(imageEdit.done).resolves.toEqual({ value: "resumed" });
});

it("rejects a foreign page without dropping the pending review", async () => {
  const f = await fixture();
  await vi.waitFor(() => expect(f.events).toHaveLength(1));
  const request = await saveReviewedRequest(f.root, f.request());
  await expect(
    confirmImageRedaction({
      ...request,
      pages: [{ ...request.pages[0], id: "foreign" }],
    }),
  ).rejects.toThrow("변경");
  expect(f.run).not.toHaveBeenCalled();
  await confirmImageRedaction(request);
  await expect(f.done).resolves.toEqual({ value: "resumed" });
});

it("cannot downgrade a new or closed review by omitting its workspace revision", async () => {
  const f = await fixture();
  await vi.waitFor(() => expect(f.events).toHaveLength(1));
  const original = f.request();
  await expect(confirmImageRedaction(original)).rejects.toThrow("초안");
  const saved = await saveReviewedRequest(f.root, original);
  await closeRedactionWorkspace(saved.sessionId);
  await expect(confirmImageRedaction(original)).rejects.toThrow("초안");
  await expect(confirmImageRedaction(saved)).rejects.toThrow("만료");
  expect(f.save).not.toHaveBeenCalled();
  expect(f.run).not.toHaveBeenCalled();
});
