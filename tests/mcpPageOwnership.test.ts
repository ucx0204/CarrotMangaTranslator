import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpPageEditScope } from "../src/main/mcp/mcpPageEditScope";
import { runMcpAppJob } from "../src/main/mcp/mcpAppJob";
import { McpReadingService } from "../src/main/application/mcpReadingService";
import type { SavePageBlocksRequest } from "../src/shared/shareTypes";
import { McpPageEditService } from "../src/main/application/mcpPageEditService";
import { createPageRevision } from "../src/shared/pageRevision";
import {
  pageContentResource,
  libraryStructureResource,
} from "../src/shared/appActivityTypes";
import {
  assertLibraryActivityAccess,
  withLibraryContentEdit,
  withLibraryMutation,
} from "../src/main/library/lock";
import { libraryMutationCoordinator } from "../src/main/libraryStore/libraryMutationCoordinator";
import {
  makeChapter,
  makeContext,
  makePage,
  createDeferred,
} from "./inpaintingSelectionJobFixtures";

vi.mock("electron", () => ({ app: { isPackaged: false }, nativeImage: {} }));
beforeEach(() =>
  vi.stubEnv("MANGA_TRANSLATOR_LOG_PATH", ".tmp/mcp-page-ownership-test.log"),
);
afterEach(() => {
  libraryMutationCoordinator.configureActivityGate(null);
  vi.unstubAllEnvs();
});
const model = { kind: "model-runtime", scope: "*", access: "write" } as const;
function fixture() {
  const app = makeContext(vi.fn());
  const chapter = makeChapter("chapter", "work", [
    makePage("a", "a.png"),
    makePage("b", "b.png"),
  ]);
  const read = vi.fn(async () => structuredClone(chapter));
  libraryMutationCoordinator.configureActivityGate(app.jobs.gate);
  const controller = new AbortController();
  const context = {
    id: "mcp",
    signal: controller.signal,
    assertAuthorized: vi.fn(),
    progress: vi.fn(),
  };
  const scope = {
    resources: [model],
    page: { chapterId: "chapter", pageId: "a", readChapter: read },
  };
  return { app, chapter, read, controller, context, scope };
}
async function acknowledge(f: ReturnType<typeof fixture>, error?: string) {
  await vi.waitFor(() =>
    expect(
      f.app.jobs.pageHandoffs.activities.some(
        (p) => p.phase === "finishing-edits",
      ),
    ).toBe(true),
  );
  const requestId = f.app.jobs.pageHandoffs.activities.find(
    (p) => p.phase === "finishing-edits",
  )?.requestId;
  if (!requestId) throw new Error("Expected real handoff request");
  f.app.jobs.pageHandoffs.respond({ requestId, error });
}

describe("MCP page ownership through the native activity gate", () => {
  it("waits for UI acknowledgement, reloads after edits, blocks page A writes but not page B", async () => {
    const f = fixture();
    const entered = createDeferred<void>();
    const finish = createDeferred<void>();
    const body = vi.fn(async () => {
      assertLibraryActivityAccess([pageContentResource("chapter", "a")]);
      expect((await f.read()).pages[0].blocks[0].translatedText).toBe(
        "last UI edit",
      );
      entered.resolve();
      await finish.promise;
      return "saved";
    });
    const task = runMcpAppJob(
      f.app,
      f.context,
      "gemma-analysis",
      body,
      f.scope,
    );
    await vi.waitFor(() =>
      expect(f.app.jobs.pageHandoffs.activities).toHaveLength(1),
    );
    expect(body).not.toHaveBeenCalled();
    f.chapter.pages[0].blocks[0].translatedText = "last UI edit";
    await acknowledge(f);
    await entered.promise;
    await expect(
      withLibraryMutation(async () =>
        assertLibraryActivityAccess([pageContentResource("chapter", "a")]),
      ),
    ).rejects.toThrow();
    await expect(
      withLibraryContentEdit(
        [pageContentResource("chapter", "b")],
        async () => {
          assertLibraryActivityAccess([pageContentResource("chapter", "b")]);
          return "other page saved";
        },
      ),
    ).resolves.toBe("other page saved");
    expect(() =>
      f.app.jobs.gate.assertAvailable([
        libraryStructureResource("chapter", "chapter"),
      ]),
    ).toThrow();
    expect(() => f.app.jobs.gate.assertAvailable([model])).toThrow();
    finish.resolve();
    await expect(task).resolves.toBe("saved");
    expect(f.app.jobs.gate.activities).toEqual([]);
    expect(f.app.jobs.pageHandoffs.activities).toEqual([]);
  });

  it("keeps ownership while cancellation cleanup is still in flight", async () => {
    const f = fixture();
    const entered = createDeferred<void>();
    const cleaning = createDeferred<void>();
    const finish = createDeferred<void>();
    const task = runMcpAppJob(
      f.app,
      f.context,
      "gemma-analysis",
      async (context) => {
        entered.resolve();
        try {
          await new Promise<void>((resolve) =>
            context.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
          context.assertAuthorized();
        } finally {
          cleaning.resolve();
          await finish.promise;
        }
      },
      f.scope,
    );
    const rejected = expect(task).rejects.toThrow();
    await acknowledge(f);
    await entered.promise;
    f.controller.abort(new Error("cancel"));
    await cleaning.promise;
    expect(() =>
      f.app.jobs.gate.assertAvailable([pageContentResource("chapter", "a")]),
    ).toThrow();
    expect(() => f.app.jobs.gate.assertAvailable([model])).toThrow();
    finish.resolve();
    await rejected;
    expect(f.app.jobs.all).toEqual([]);
    expect(() => f.app.jobs.gate.assertAvailable([model])).not.toThrow();
  });

  it("does not start work when UI saving fails and cancels the waiting handoff", async () => {
    const f = fixture();
    const execute = vi.fn(async () => "unexpected");
    const task = runMcpAppJob(
      f.app,
      f.context,
      "gemma-analysis",
      execute,
      f.scope,
    );
    const rejected = expect(task).rejects.toThrow();
    await acknowledge(f, "disk full");
    await vi.waitFor(() =>
      expect(f.app.jobs.pageHandoffs.activities[0].phase).toBe("waiting"),
    );
    expect(execute).not.toHaveBeenCalled();
    f.controller.abort();
    await rejected;
    expect(f.app.jobs.gate.activities).toEqual([]);
    expect(f.app.jobs.pageHandoffs.activities).toEqual([]);
  });

  it("rejects a missing page before asking the renderer or invoking the model", async () => {
    const f = fixture();
    const execute = vi.fn(async () => {});
    f.scope.page.pageId = "absent";
    await expect(
      runMcpAppJob(f.app, f.context, "gemma-analysis", execute, f.scope),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(execute).not.toHaveBeenCalled();
    expect(f.app.jobs.all).toEqual([]);
  });

  it("blocks a second model acquisition but leaves the first owner intact", async () => {
    const f = fixture();
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    const first = runMcpAppJob(
      f.app,
      f.context,
      "gemma-analysis",
      async () => {
        started.resolve();
        await finish.promise;
      },
      { resources: [model] },
    );
    await started.promise;
    await expect(
      runMcpAppJob(
        f.app,
        { ...f.context, id: "second" },
        "gemma-analysis",
        async () => {},
        { resources: [model] },
      ),
    ).rejects.toThrow();
    expect(f.app.jobs.all.map((job) => job.id)).toEqual(["mcp"]);
    finish.resolve();
    await first;
  });

  it("does not acquire a model lease for a lightweight edit and rechecks authorization while waiting", async () => {
    const f = fixture();
    let allowed = true;
    const execute = vi.fn(async () => {});
    const edit = createMcpPageEditScope(f.app, f.read);
    const task = edit(
      { chapterId: "chapter", pageId: "a" },
      () => {
        if (!allowed) throw new Error("request closed");
      },
      execute,
    );
    const rejected = expect(task).rejects.toThrow("request closed");
    await vi.waitFor(() =>
      expect(f.app.jobs.pageHandoffs.activities).toHaveLength(1),
    );
    expect(() => f.app.jobs.gate.assertAvailable([model])).not.toThrow();
    allowed = false;
    await rejected;
    expect(execute).not.toHaveBeenCalled();
    expect(f.app.jobs.all).toEqual([]);
  });

  it("rejects an old revision after real page handoff without overwriting the saved UI edit", async () => {
    const f = fixture();
    const scope = createMcpPageEditScope(f.app, f.read);
    const save = vi.fn(async () => structuredClone(f.chapter));
    const service = new McpPageEditService({
      openChapter: f.read,
      savePageBlocks: save,
      assertWritable: async () => {},
      notifySaved: () => {},
      withPageEdit: scope,
    });
    const page = f.chapter.pages[0];
    const task = service.update({
      chapterId: "chapter",
      pageId: "a",
      revision: createPageRevision(page),
      edits: [{ blockId: page.blocks[0].id, translatedText: "remote" }],
    });
    const rejected = expect(task).rejects.toMatchObject({
      code: "revision_conflict",
    });
    await vi.waitFor(() =>
      expect(f.app.jobs.pageHandoffs.activities).toHaveLength(1),
    );
    page.blocks[0].translatedText = "UI saved";
    await acknowledge(f);
    await rejected;
    expect(save).not.toHaveBeenCalled();
    expect(page.blocks[0].translatedText).toBe("UI saved");
    expect(f.app.jobs.all).toEqual([]);
  });
});

it("allows two different-page lightweight scopes while another page owns local inference", async () => {
  const f = fixture();
  f.app.jobs.start({
    id: "local-model",
    kind: "gemma-analysis",
    resources: [model, pageContentResource("chapter", "c")],
    abortController: new AbortController(),
  });
  const stop = f.app.jobs.pageHandoffs.subscribe(() => {
    for (const handoff of f.app.jobs.pageHandoffs.activities)
      if (handoff.phase === "finishing-edits" && handoff.requestId)
        f.app.jobs.pageHandoffs.respond({ requestId: handoff.requestId });
  });
  const finish = createDeferred<void>();
  let entered = 0;
  const scope = createMcpPageEditScope(f.app, f.read);
  const run = (pageId: string) =>
    scope(
      { chapterId: "chapter", pageId },
      () => {},
      async (guard) => {
        guard();
        assertLibraryActivityAccess([pageContentResource("chapter", pageId)]);
        entered++;
        await finish.promise;
        return pageId;
      },
    );
  const tasks = Promise.all([run("a"), run("b")]);
  try {
    await vi.waitFor(() => expect(entered).toBe(2));
    expect(f.app.jobs.all).toHaveLength(3);
    finish.resolve();
    await expect(tasks).resolves.toEqual(["a", "b"]);
    expect(f.app.jobs.all.map((job) => job.id)).toEqual(["local-model"]);
  } finally {
    finish.resolve();
    stop();
    f.app.jobs.clearIfCurrent("local-model");
  }
});

it("stops a synchronous page handoff with its MCP session without revoking unrelated jobs", async () => {
  const f = fixture();
  const lifetime = new AbortController();
  const scope = createMcpPageEditScope(f.app, f.read, lifetime.signal);
  const execute = vi.fn(async () => "unexpected");
  const task = scope({ chapterId: "chapter", pageId: "a" }, () => {}, execute);
  const rejected = expect(task).rejects.toThrow("MCP stopped");
  await vi.waitFor(() =>
    expect(f.app.jobs.pageHandoffs.activities).toHaveLength(1),
  );
  lifetime.abort(new Error("MCP stopped"));
  await rejected;
  expect(execute).not.toHaveBeenCalled();
  expect(f.app.jobs.all).toEqual([]);
  await expect(
    scope({ chapterId: "chapter", pageId: "a" }, () => {}, execute),
  ).rejects.toThrow("MCP stopped");
  expect(f.app.jobs.all).toEqual([]);
});

it("saves new external readings through the same scoped page lease", async () => {
  const f = fixture();
  const scope = createMcpPageEditScope(f.app, f.read);
  const save = vi.fn(
    async (request: SavePageBlocksRequest, guard?: () => void) =>
      withLibraryMutation(async () => {
        guard?.();
        assertLibraryActivityAccess([
          pageContentResource(request.chapterId, request.pageId),
        ]);
        f.chapter.pages[0].blocks = request.blocks;
        f.chapter.pages[0].blockOrder = request.blockOrder;
        return structuredClone(f.chapter);
      }),
  );
  const reader = new McpReadingService({
    openChapter: f.read,
    savePageBlocks: save,
    defaults: async () => undefined,
    assertWritable: async () => {},
    notifySaved: () => {},
    withPageEdit: scope,
  });
  const task = reader.create({
    chapterId: "chapter",
    pageId: "a",
    revision: createPageRevision(f.chapter.pages[0]),
    requestId: "new-reading",
    blocks: [
      {
        key: "second",
        sourceText: "source",
        translatedText: "translated",
        sourceRect: { x: 10, y: 10, w: 20, h: 20 },
      },
    ],
  });
  await acknowledge(f);
  await expect(task).resolves.toMatchObject({ status: "saved" });
  expect(save).toHaveBeenCalledOnce();
  expect(f.chapter.pages[0].blocks).toHaveLength(2);
  expect(f.app.jobs.all).toEqual([]);
});
