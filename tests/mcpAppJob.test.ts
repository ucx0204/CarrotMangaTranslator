import { describe, expect, it, vi } from "vitest";
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
