import { describe, expect, it, vi } from "vitest";
import { eraseMcpPage } from "../src/main/mcp/mcpErasureAdapter";
import { createPageRevision } from "../src/shared/pageRevision";
import {
  createInpaintingRuntimeHarness,
  makeChapter,
  makeContext,
  makePage,
  createDeferred,
} from "./inpaintingSelectionJobFixtures";

vi.mock("electron", () => ({ app: { isPackaged: false }, nativeImage: {} }));

function fixture() {
  const page = makePage("page", "page.png");
  const chapters = new Map([
    ["chapter", makeChapter("chapter", "work", [page])],
  ]);
  const harness = createInpaintingRuntimeHarness(chapters);
  const save = harness.runtime.savePages;
  harness.runtime.savePages = vi.fn(async (id, pages, options, guard) => {
    guard?.();
    return save(id, pages, options);
  });
  const editing = {
    assertWritable: vi.fn(async () => {}),
    assertClean: vi.fn(async () => {}),
    notifySaved: vi.fn(),
  };
  const controller = new AbortController();
  const operation = {
    id: "receipt",
    signal: controller.signal,
    assertAuthorized: vi.fn(() => controller.signal.throwIfAborted()),
    progress: vi.fn(),
  };
  const app = makeContext(vi.fn());
  const target = {
    chapterId: "chapter",
    pageId: "page",
    revision: createPageRevision(page),
    requestId: "request",
  };
  return {
    page,
    chapters,
    harness,
    editing,
    controller,
    operation,
    app,
    target,
  };
}
describe("MCP uses the existing app erasure job", () => {
  it("runs local page-pattern removal and preserves text and history with no Codex or layout", async () => {
    const f = fixture();
    const codex = vi.fn();
    const layout = vi.fn();
    f.harness.runtime.acquireCodexEngine = codex;
    f.harness.runtime.createBubbleLayoutRunner = layout;
    const before = structuredClone(f.page.blocks);
    const result = await eraseMcpPage(
      f.app,
      f.editing,
      f.target,
      f.operation,
      f.harness.runtime,
    );
    expect(result).toMatchObject({
      status: "completed",
      pagesChanged: 1,
      performed: ["erase-original"],
    });
    expect(f.harness.acquireEngine).toHaveBeenCalledTimes(1);
    expect(f.harness.inpaintPatternPage).toHaveBeenCalledTimes(1);
    expect(f.harness.releaseEngine).toHaveBeenCalledTimes(1);
    expect(codex).not.toHaveBeenCalled();
    expect(layout).not.toHaveBeenCalled();
    expect(f.chapters.get("chapter")?.pages[0].blocks).toEqual(before);
    expect(f.editing.assertClean).toHaveBeenCalled();
    expect(f.app.jobs.current).toBeNull();
    expect(JSON.stringify(result)).not.toContain("C:");
  });
  it("rejects stale revisions before acquiring an engine", async () => {
    const f = fixture();
    f.page.blocks[0].translatedText = "new manual text";
    await expect(
      eraseMcpPage(f.app, f.editing, f.target, f.operation, f.harness.runtime),
    ).rejects.toThrow();
    expect(f.harness.acquireEngine).not.toHaveBeenCalled();
    expect(f.harness.runtime.savePages).not.toHaveBeenCalled();
  });
  it("rechecks authorization after processing and leaves saved data untouched", async () => {
    const f = fixture();
    f.harness.inpaintPatternPage.mockImplementationOnce(async (page) => {
      f.operation.assertAuthorized.mockImplementation(() => {
        throw new Error("revoked");
      });
      return {
        page: { ...page, inpaintedImagePath: "not-saved.png" },
        blocksErased: 1,
      };
    });
    await expect(
      eraseMcpPage(f.app, f.editing, f.target, f.operation, f.harness.runtime),
    ).rejects.toThrow();
    expect(
      f.chapters.get("chapter")?.pages[0].inpaintedImagePath,
    ).toBeUndefined();
    expect(f.app.jobs.current).toBeNull();
  });
  it("cancels only the native job acquired by this request", async () => {
    const f = fixture();
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
        throw new Error("expected cancellation");
      },
    );
    const pending = eraseMcpPage(
      f.app,
      f.editing,
      f.target,
      f.operation,
      f.harness.runtime,
    );
    await entered.promise;
    f.controller.abort();
    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(f.harness.releaseEngine).toHaveBeenCalledTimes(1);
    expect(f.app.jobs.current).toBeNull();
  });
});
