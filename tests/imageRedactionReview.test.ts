import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  withImageRedactionReview,
  confirmImageRedaction,
} from "../src/main/jobs/imageRedactionReview";
import {
  readImageRedactionState,
  saveImageRedactionPages,
  setImageRedactionEnabled,
} from "../src/main/imageRedactionStore";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { JobEvent } from "../src/shared/jobTypes";
import type { ImageRedactionPage } from "../src/shared/imageRedaction";

import { saveReviewedRequest } from "./helpers/redactionReviewApproval";

// Tests use actual draft/approval storage; no native image decoding is requested.
vi.mock("electron", () => ({ nativeImage: {} }));
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function reviewFixture() {
  const root = await mkdtemp(join(tmpdir(), "manga-review-test-"));
  roots.push(root);
  const path = join(root, "original.png");
  await writeFile(path, "original bytes");
  await setImageRedactionEnabled(true, root);
  const page: MangaPage = {
    id: "page",
    name: "original.png",
    imagePath: path,
    width: 10,
    height: 10,
    blocks: [],
    dataUrl: "",
    analysisStatus: "idle",
    createdAt: "",
    updatedAt: "",
  };
  const settings = resolveDefaultAppSettings({});
  settings.modelProvider = "openai-api";
  const save = vi.fn(async (pages: readonly ImageRedactionPage[]) =>
    saveImageRedactionPages(pages, root),
  );
  const store = {
    read: () => readImageRedactionState(root),
    save,
    settings: async () => settings,
  };
  const controller = new AbortController();
  const events: JobEvent[] = [];
  const run = vi.fn(async () => "sent");
  const jobId = randomUUID();
  const start = () =>
    withImageRedactionReview(
      {
        jobId,
        kind: "gemma-analysis",
        pages: [page],
        signal: controller.signal,
        emit: (event) => events.push(event),
      },
      run,
      store,
    );
  const request = () => {
    const review = events.at(-1)?.imageRedactionReview;
    if (!review) throw new Error("missing review");
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
  return { root, page, store, save, controller, events, run, start, request };
}
it("waits for every page, preserves failed-save input, and allows a single explicit confirmation retry", async () => {
  const f = await reviewFixture();
  const pending = f.start();
  await vi.waitFor(() => expect(f.events).toHaveLength(1));
  expect(f.run).not.toHaveBeenCalled();
  const request = f.request();
  request.pages[0].strokes = [
    {
      shape: "rectangle",
      size: 4,
      points: [
        { x: 1, y: 1 },
        { x: 5, y: 5 },
      ],
    },
  ];
  await expect(
    confirmImageRedaction({ ...request, pages: [] }),
  ).rejects.toThrow();
  Object.assign(request, await saveReviewedRequest(f.root, request));
  f.save.mockRejectedValueOnce(new Error("disk unavailable"));
  await expect(confirmImageRedaction(request)).rejects.toThrow(
    "disk unavailable",
  );
  expect(f.run).not.toHaveBeenCalled();
  await expect(confirmImageRedaction(request)).resolves.toBe(true);
  await expect(pending).resolves.toBe("sent");
  expect(f.run).toHaveBeenCalledOnce();
  expect(
    (await readImageRedactionState(f.root)).pages[f.page.imagePath].strokes,
  ).toEqual(request.pages[0].strokes);
  await expect(confirmImageRedaction(request)).rejects.toThrow();
});
it("rejects duplicate confirmation and cancellation before any external work", async () => {
  const f = await reviewFixture();
  const pending = f.start().catch((error) => error);
  await vi.waitFor(() => expect(f.events).toHaveLength(1));
  const request = await saveReviewedRequest(f.root, f.request());
  let release = () => {};
  f.save.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const confirming = confirmImageRedaction(request).catch((error) => error);
  await vi.waitFor(() => expect(f.save).toHaveBeenCalledOnce());
  await expect(confirmImageRedaction(request)).rejects.toThrow();
  f.controller.abort(new Error("cancelled"));
  release();
  expect(await confirming).toBeInstanceOf(Error);
  expect(await pending).toBeInstanceOf(Error);
  expect(f.run).not.toHaveBeenCalled();
});
it("rejects a changed source and lets local-only translation run without a review", async () => {
  const f = await reviewFixture();
  const pending = f.start().catch((error) => error);
  await vi.waitFor(() => expect(f.events).toHaveLength(1));
  const request = await saveReviewedRequest(f.root, f.request());
  await writeFile(f.page.imagePath, "changed");
  await expect(confirmImageRedaction(request)).rejects.toThrow();
  f.controller.abort();
  await pending;
  const local = await reviewFixture();
  (await local.store.settings()).modelProvider = "gemma";
  await expect(local.start()).resolves.toBe("sent");
  expect(local.events).toHaveLength(0);
});
