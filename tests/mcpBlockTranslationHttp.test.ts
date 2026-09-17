import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createMcpTestGrant } from "./mcpOAuthGrant.fixture";
import { translationFixture } from "./mcpBlockTranslation.fixture";

async function fixture() {
  const f = await translationFixture();
  const { createPageRevision } = await import("../src/shared/pageRevision");
  const { McpOperationService } =
    await import("../src/main/application/mcpOperationService");
  const { McpPageEditService } =
    await import("../src/main/application/mcpPageEditService");
  const { createMcpPageEditScope } =
    await import("../src/main/mcp/mcpPageEditScope");
  const { createMcpPageEditTools } =
    await import("../src/main/mcp/mcpPageEditTools");
  const { createMcpOperationTools } =
    await import("../src/main/mcp/mcpOperationTools");
  const { createMcpBlockTranslationExecutor } =
    await import("../src/main/mcp/mcpBlockTranslationSession");
  const { ActiveJobStore } = await import("../src/main/jobs/activeJob");
  const { getAppPaths } = await import("../src/main/appPaths");
  const { McpOAuthProvider } = await import("../src/main/mcp/mcpOAuthProvider");
  const { McpOAuthSession } = await import("../src/main/mcp/mcpOAuthSession");
  const { McpOAuthHttp } = await import("../src/main/mcp/mcpOAuthHttp");
  const { McpPairingBroker } = await import("../src/main/mcp/mcpPairingBroker");
  const { startMcpHttpServer } = await import("../src/main/mcp/mcpHttpServer");
  const jobs = new ActiveJobStore({ info: vi.fn(), error: vi.fn() });
  const stop = jobs.pageHandoffs.subscribe(() => {
    for (const page of jobs.pageHandoffs.activities)
      if (page.phase === "finishing-edits" && page.requestId)
        jobs.pageHandoffs.respond({ requestId: page.requestId });
  });
  const app = {
    jobs,
    appPaths: getAppPaths(),
    getMainWindow: () => null,
    decodeImage: async () => null,
  };
  let journal: unknown = null;
  const persistence = {
    load: async () => structuredClone(journal),
    save: async (value: unknown) => {
      journal = structuredClone(value);
    },
  };
  const operations = new McpOperationService(() => {}, Date.now, persistence);
  const tools = createMcpOperationTools(operations, {
    blockTranslation: createMcpBlockTranslationExecutor(app, f.runtime),
  });
  const editor = new McpPageEditService({
    openChapter: f.library.openChapter,
    savePageBlocks: f.library.savePageBlocks,
    assertWritable: async () => {},
    notifySaved: () => {},
    withPageEdit: createMcpPageEditScope(app, f.library.openChapter),
  });
  const origin = "https://block-translation.test.ts.net",
    secret = "s".repeat(43);
  const provider = new McpOAuthProvider(origin, secret, Date.now, {
    allowProcessing: true,
    allowEdits: true,
  });
  const session = new McpOAuthSession(provider, { save: async () => {} });
  const grant = createMcpTestGrant(origin, secret);
  const full = grant(provider, "carrot.read carrot.edit carrot.process"),
    read = grant(provider, "carrot.read"),
    other = grant(provider, "carrot.read carrot.process");
  const server = await startMcpHttpServer({
    config: { port: 0, token: "t".repeat(43), publicOrigin: origin },
    tools: [...tools, ...createMcpPageEditTools(editor, true, true)],
    enforceScopes: true,
    oauthHttp: new McpOAuthHttp(origin, secret, {
      session,
      pairing: new McpPairingBroker(provider, secret),
    }),
    reportError: () => {},
  });
  const rpc = async (method: string, params: unknown = {}, token = full) => {
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return response.json();
  };
  const call = (name: string, args: unknown, token = full) =>
    rpc("tools/call", { name, arguments: args }, token);
  const settle = async (jobId: string) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const response = await call("carrot_get_job", { jobId });
      expect(response.result.isError).toBe(false);
      const job = response.result.structuredContent;
      if (job.status !== "running") return job;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Translation fixture did not settle");
  };
  return {
    ...f,
    jobs,
    operations,
    call,
    rpc,
    settle,
    read,
    other,
    full,
    provider,
    target: {
      ...f.target,
      revision: createPageRevision(f.after),
      requestId: randomUUID(),
      contextMode: "none" as const,
    },
    stored: () => journal,
    restart: async () => {
      const next = new McpOperationService(() => {}, Date.now, persistence);
      await next.ready();
      return next;
    },
    close: async () => {
      await operations.close();
      await server.close();
      stop();
      await f.close();
    },
  };
}

it("composes the real executor, polls metadata, applies only translated text, and expires private proposals on restart", async () => {
  const f = await fixture();
  try {
    const before = await f.snapshot();
    const started = await f.call("carrot_run_block_translation", f.target);
    expect(started.result.isError).toBe(false);
    const jobId = started.result.structuredContent.jobId;
    const job = await f.settle(jobId);
    expect(job).toMatchObject({
      kind: "blockTranslation",
      status: "completed",
      target: { blockId: "a", contextMode: "none" },
      result: { pagesChanged: 0, status: "proposed", proposalExpired: false },
    });
    expect(await f.snapshot()).toEqual(before);
    for (const name of ["carrot_get_job", "carrot_list_jobs"]) {
      const reply = await f.call(
        name,
        name === "carrot_get_job" ? { jobId } : {},
      );
      expect(reply.result.content).toHaveLength(1);
      expect(JSON.stringify(reply)).not.toMatch(
        /resource_link|image\/png|apiKey|imagePath|first-key/,
      );
    }
    expect(
      (await f.call("carrot_run_block_translation", f.target)).result
        .structuredContent.jobId,
    ).toBe(jobId);
    expect(f.runtime.request).toHaveBeenCalledOnce();
    const proposal = job.result.blockTranslation;
    const applied = await f.call("carrot_update_translations", {
      chapterId: "chapter",
      pageId: "page",
      revision: job.result.revision,
      edits: [{ blockId: "a", translatedText: proposal.translatedText }],
    });
    expect(applied.result.isError).toBe(false);
    expect((await f.library.openChapter("chapter")).pages[0].blocks).toEqual([
      { ...f.after.blocks[0], translatedText: proposal.translatedText },
      f.after.blocks[1],
    ]);
    const restored = await f.call("carrot_update_translations", {
      chapterId: "chapter",
      pageId: "page",
      revision: applied.result.structuredContent.revision,
      edits: [
        { blockId: "a", translatedText: proposal.previousTranslatedText },
      ],
    });
    expect(restored.result.isError).toBe(false);
    expect((await f.library.openChapter("chapter")).pages[0].blocks).toEqual(
      f.after.blocks,
    );
    expect(JSON.stringify(f.stored())).not.toMatch(
      /previousTranslatedText|translatedText|sourceText|blockTranslation":\{/,
    );
    const next = await f.restart();
    const owner = f.provider.connectionIdFor(`Bearer ${f.full}`);
    if (!owner) throw new Error("Expected owner");
    expect(next.status(jobId, owner).result).toMatchObject({
      proposalExpired: true,
    });
    expect(next.status(jobId, owner).result?.blockTranslation).toBeUndefined();
    await next.close();
    expect(f.jobs.gate.activities).toEqual([]);
  } finally {
    await f.close();
  }
});

it("enforces processing scope, exact inputs, owner isolation and explicit retry preserving context mode", async () => {
  const f = await fixture();
  try {
    const before = await f.snapshot();
    const listed = await f.rpc("tools/list", {}, f.read);
    expect(
      listed.result.tools.some(
        (tool: { name: string }) =>
          tool.name === "carrot_run_block_translation",
      ),
    ).toBe(false);
    expect(
      (await f.call("carrot_run_block_translation", f.target, f.read)).error
        .code,
    ).toBe(-32602);
    const { blockId: _block, ...missing } = f.target;
    for (const args of [
      missing,
      { ...f.target, contextMode: "all" },
      { ...f.target, path: "C:/private" },
      { ...f.target, apiKey: "injected" },
    ])
      expect(
        (await f.call("carrot_run_block_translation", args)).error.code,
      ).toBe(-32602);
    expect(f.runtime.request).not.toHaveBeenCalled();
    vi.mocked(f.runtime.request).mockRejectedValueOnce(
      new Error("upstream uncertain"),
    );
    const failed = await f.call("carrot_run_block_translation", f.target);
    const first = failed.result.structuredContent.jobId;
    expect((await f.settle(first)).status).toBe("failed");
    expect(f.runtime.request).toHaveBeenCalledOnce();
    const retried = await f.call("carrot_retry_job", {
      jobId: first,
      revision: f.target.revision,
      requestId: randomUUID(),
    });
    expect(retried.result.isError).toBe(false);
    const jobId = retried.result.structuredContent.jobId;
    expect((await f.settle(jobId)).target.contextMode).toBe("none");
    expect(f.runtime.request).toHaveBeenCalledTimes(2);
    expect(
      (await f.call("carrot_get_job", { jobId }, f.other)).result
        .structuredContent.error,
    ).toBe("not_found");
    expect(
      (await f.call("carrot_cancel_job", { jobId }, f.other)).result
        .structuredContent.error,
    ).toBe("not_found");
    expect(
      (
        await f.call("carrot_run_block_translation", {
          ...f.target,
          blockId: "b",
        })
      ).result.structuredContent.error,
    ).toBe("invalid_edit");
    expect(
      (
        await f.call("carrot_retry_job", {
          jobId,
          revision: f.target.revision,
          requestId: randomUUID(),
        })
      ).result.structuredContent.error,
    ).toBe("invalid_edit");
    expect(await f.snapshot()).toEqual(before);
  } finally {
    await f.close();
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("holds the page/model until cancellation cleanup actually returns", async () => {
  const f = await fixture();
  const entered = deferred(),
    releaseRequest = deferred(),
    cleaning = deferred(),
    releaseCleanup = deferred();
  vi.mocked(f.runtime.request).mockImplementationOnce(async () => {
    entered.resolve();
    await releaseRequest.promise;
    return '{"blockId":"a","translatedText":"text"}';
  });
  f.session.dispose.mockImplementationOnce(async () => {
    cleaning.resolve();
    await releaseCleanup.promise;
  });
  try {
    const before = await f.snapshot();
    const started = await f.call("carrot_run_block_translation", f.target);
    const jobId = started.result.structuredContent.jobId;
    await entered.promise;
    expect(f.jobs.pageHandoffs.activities).toContainEqual(
      expect.objectContaining({ pageId: "page", phase: "processing" }),
    );
    expect(
      (await f.call("carrot_cancel_job", { jobId })).result.structuredContent,
    ).toMatchObject({ status: "running", cancellationRequested: true });
    releaseRequest.resolve();
    await cleaning.promise;
    expect(f.jobs.gate.activities.length).toBeGreaterThan(0);
    expect(
      (
        await f.call("carrot_run_block_translation", {
          ...f.target,
          requestId: randomUUID(),
        })
      ).result.structuredContent.error,
    ).toBe("editor_busy");
    releaseCleanup.resolve();
    const done = await f.settle(jobId);
    expect(done.status).toBe("cancelled");
    expect(done.result?.blockTranslation).toBeUndefined();
    expect(f.jobs.gate.activities).toEqual([]);
    expect(await f.snapshot()).toEqual(before);
  } finally {
    releaseRequest.resolve();
    releaseCleanup.resolve();
    await f.close();
  }
});
