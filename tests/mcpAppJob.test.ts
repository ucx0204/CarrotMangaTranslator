import { describe, expect, it, vi } from "vitest";
import { assertLibraryActivityAccess } from "../src/main/library/lock";
import { libraryMutationCoordinator } from "../src/main/libraryStore/libraryMutationCoordinator";
import { pageContentResource } from "../src/shared/appActivityTypes";
import { runMcpAppJob } from "../src/main/mcp/mcpAppJob";
import { makeContext, createDeferred } from "./inpaintingSelectionJobFixtures";

vi.mock("electron", () => ({ app: { isPackaged: false }, nativeImage: {} }));

function operation() {
  const controller = new AbortController();
  return {
    controller,
    context: {
      id: "job",
      signal: controller.signal,
      assertAuthorized: vi.fn(),
      progress: vi.fn(),
    },
  };
}
describe("MCP native job ownership", () => {
  it.each(["gemma-analysis", "page-export"] as const)(
    "retains the library activity owner during %s execution",
    async (kind) => {
      const app = makeContext(vi.fn());
      const f = operation();
      libraryMutationCoordinator.configureActivityGate(app.jobs.gate);
      try {
        const result = await runMcpAppJob(app, f.context, kind, async () => {
          await Promise.resolve();
          assertLibraryActivityAccess([pageContentResource("chapter", "page")]);
          return "authorized owner";
        });
        expect(result).toBe("authorized owner");
        expect(app.jobs.current).toBeNull();
      } finally {
        libraryMutationCoordinator.configureActivityGate(null);
      }
    },
  );
  it("uses the existing job store and finishes its quit-cleanup lease", async () => {
    const app = makeContext(vi.fn());
    const f = operation();
    const finish = createDeferred<void>();
    const pending = runMcpAppJob(app, f.context, "page-export", async () => {
      await finish.promise;
      return { saved: false };
    });
    const owned = app.jobs.current;
    if (!owned) throw new Error("Expected owned job");
    expect(owned.id).toBe(f.context.id);
    let cleaned = false;
    const cleanup = app.jobs.runCleanup(owned, "test").then(() => {
      cleaned = true;
    });
    await Promise.resolve();
    expect(cleaned).toBe(false);
    finish.resolve();
    expect(await pending).toEqual({ saved: false });
    await cleanup;
    expect(app.jobs.current).toBeNull();
    expect(cleaned).toBe(true);
  });
  it("observes cancellation from the actual app job center", async () => {
    const app = makeContext(vi.fn());
    const f = operation();
    const entered = createDeferred<void>();
    const pending = runMcpAppJob(
      app,
      f.context,
      "gemma-analysis",
      async (job) => {
        entered.resolve();
        await new Promise<void>((resolve) =>
          job.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        job.assertAuthorized();
      },
    );
    await entered.promise;
    app.jobs.current?.abortController.abort();
    await expect(pending).rejects.toThrow();
    expect(app.jobs.current).toBeNull();
  });
});

it("does not attach abort listeners or release another owner after admission is refused", async () => {
  const app = makeContext(vi.fn());
  app.jobs.start({
    id: "other",
    kind: "mcp-edit",
    resources: [],
    abortController: new AbortController(),
  });
  const f = operation();
  const execute = vi.fn(async () => {});
  await expect(
    runMcpAppJob(app, f.context, "page-export", execute),
  ).rejects.toMatchObject({ code: "editor_busy" });
  expect(execute).not.toHaveBeenCalled();
  expect(app.jobs.all.map((job) => job.id)).toEqual(["other"]);
  app.jobs.clearIfCurrent("other");
});

it("observes cancellation delivered synchronously by the activity observer during admission", async () => {
  const app = makeContext(vi.fn());
  const f = operation();
  const stop = app.jobs.gate.subscribe(() =>
    f.controller.abort(new Error("cancelled at admission")),
  );
  const execute = vi.fn(async () => {});
  try {
    await expect(
      runMcpAppJob(app, f.context, "page-export", execute, { resources: [] }),
    ).rejects.toThrow("cancelled at admission");
    expect(execute).not.toHaveBeenCalled();
    expect(app.jobs.all).toEqual([]);
  } finally {
    stop();
  }
});
