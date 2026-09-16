import { expect, it, vi } from "vitest";
import { eraseMcpPage } from "../src/main/mcp/mcpErasureAdapter";
import {
  assertModelCleanupComplete,
  releaseModelResource,
} from "../src/main/runtimeSupport/modelCleanupBarrier";
import { createPageRevision } from "../src/shared/pageRevision";
import {
  createInpaintingRuntimeHarness,
  makeChapter,
  makeContext,
  makePage,
  createDeferred,
} from "./inpaintingSelectionJobFixtures";
vi.mock("electron", () => ({ app: { isPackaged: false }, nativeImage: {} }));

function setup() {
  const page = makePage("page", "page.png");
  const chapter = makeChapter("chapter", "work", [page]);
  const harness = createInpaintingRuntimeHarness(
    new Map([[chapter.id, chapter]]),
  );
  const app = makeContext(vi.fn());
  const off = app.jobs.pageHandoffs.subscribe(() => {
    for (const handoff of app.jobs.pageHandoffs.activities)
      if (handoff.phase === "finishing-edits" && handoff.requestId)
        app.jobs.pageHandoffs.respond({ requestId: handoff.requestId });
  });
  const abort = new AbortController();
  const operation = {
    id: "receipt",
    signal: abort.signal,
    assertAuthorized: () => abort.signal.throwIfAborted(),
    progress: vi.fn(),
  };
  const editing = {
    assertWritable: async () => {},
    assertClean: vi.fn(async () => {}),
    notifySaved: vi.fn(),
  };
  const target = {
    chapterId: chapter.id,
    pageId: page.id,
    revision: createPageRevision(page),
    requestId: "request",
  };
  const run = () =>
    eraseMcpPage(app, editing, target, operation, harness.runtime);
  return {
    app,
    chapter,
    page,
    harness,
    abort,
    operation,
    editing,
    target,
    run,
    off,
  };
}

it("reports a committed page separately from failed model release and blocks later models", async () => {
  const f = setup();
  const resource = {};
  const original = f.harness.runtime.acquireEngine;
  f.harness.runtime.acquireEngine = async (options) => {
    const lease = await original(options);
    return {
      ...lease,
      release: async () => {
        await lease.release();
        await releaseModelResource(resource, async () => {
          throw new Error("process still alive");
        });
      },
    };
  };
  try {
    const result = await f.run();
    expect(result).toMatchObject({
      status: "partial",
      cleanupFailed: true,
      pagesChanged: 1,
    });
    expect(result.revision).not.toBe(f.target.revision);
    expect(f.operation.progress).toHaveBeenCalledWith({
      phase: "releasing_model",
    });
    expect(f.editing.notifySaved).toHaveBeenCalledWith("chapter", "page");
    expect(() =>
      f.app.jobs.gate.assertAvailable([
        { kind: "model-runtime", scope: "*", access: "write" },
      ]),
    ).toThrow();
    expect(() =>
      f.app.jobs.gate.assertAvailable([
        { kind: "page-content", scope: "chapter/other", access: "write" },
      ]),
    ).not.toThrow();
    expect(f.app.jobs.all).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("process still alive");
  } finally {
    f.off();
    await releaseModelResource(resource, async () => {});
  }
});

it("does not falsely claim a page was saved when preparation and cleanup both fail", async () => {
  const f = setup();
  const resource = {};
  f.harness.runtime.acquireEngine = async () => {
    await releaseModelResource(resource, async () => {
      throw new Error("partly loaded model");
    });
    throw new Error("unreachable");
  };
  try {
    await expect(f.run()).rejects.toMatchObject({ code: "editor_busy" });
    expect(f.harness.runtime.savePages).not.toHaveBeenCalled();
    expect(f.editing.notifySaved).not.toHaveBeenCalled();
    expect(() => assertModelCleanupComplete()).toThrow();
  } finally {
    f.off();
    await releaseModelResource(resource, async () => {});
  }
});

it("cancels its own native job even when an unrelated lightweight job is the legacy current job", async () => {
  const f = setup();
  f.app.jobs.start({
    id: "unrelated-edit",
    kind: "mcp-edit",
    resources: [],
    abortController: new AbortController(),
  });
  const entered = createDeferred<void>();
  f.harness.inpaintPatternPage.mockImplementationOnce(
    async (_page, options) => {
      entered.resolve();
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      );
      options?.signal?.throwIfAborted();
      throw new Error("unexpected continuation");
    },
  );
  const pending = f.run();
  try {
    await entered.promise;
    expect(f.app.jobs.current?.id).toBe("unrelated-edit");
    f.abort.abort();
    await expect(pending).resolves.toMatchObject({ status: "cancelled" });
    expect(
      f.app.jobs.get("unrelated-edit")?.abortController.signal.aborted,
    ).toBe(false);
    expect(f.harness.releaseEngine).toHaveBeenCalledOnce();
  } finally {
    f.off();
    f.app.jobs.clearIfCurrent("unrelated-edit");
  }
});

it("checks authority again after slow settings resolution without starting a native job", async () => {
  const f = setup();
  const original = f.harness.runtime.getSettings;
  f.harness.runtime.getSettings = async (paths) => {
    const settings = await original(paths);
    f.abort.abort();
    return settings;
  };
  try {
    await expect(f.run()).rejects.toThrow();
    expect(f.harness.acquireEngine).not.toHaveBeenCalled();
    expect(f.app.jobs.all).toEqual([]);
  } finally {
    f.off();
  }
});
