import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { McpOAuthProvider } from "../src/main/mcp/mcpOAuthProvider";
import { oauthDigest } from "../src/main/mcp/mcpOAuthPolicy";
import { createPageRevision } from "../src/shared/pageRevision";
import { recoveryLibrary } from "./mcpErasureRecovery.fixture";

const origin = "https://block-ocr.test.ts.net";
const secret = "s".repeat(43);
function grant(provider: McpOAuthProvider, scope: string) {
  const redirect_uri = "https://chatgpt.com/connector/oauth/block-ocr-test";
  const client = provider.register({
    redirect_uris: [redirect_uri],
    token_endpoint_auth_method: "none",
  });
  const pending = provider.begin({
    client_id: client.client_id,
    response_type: "code",
    redirect_uri,
    resource: `${origin}/mcp`,
    scope,
    state: "fixture",
    code_challenge: oauthDigest(secret),
    code_challenge_method: "S256",
  });
  const response = new URL(
    provider.approve(
      {
        transaction: pending.transaction,
        decision: "approve",
        pairing_secret: secret,
      },
      pending.cookie,
    ),
  );
  return provider.token({
    grant_type: "authorization_code",
    client_id: client.client_id,
    redirect_uri,
    resource: `${origin}/mcp`,
    code: response.searchParams.get("code"),
    code_verifier: secret,
  }).access_token;
}

async function fixture() {
  const f = await recoveryLibrary();
  const { McpBlockOcrService } =
    await import("../src/main/application/mcpBlockOcrService");
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
  const { runMcpAppJob } = await import("../src/main/mcp/mcpAppJob");
  const { ActiveJobStore } = await import("../src/main/jobs/activeJob");
  const { getAppPaths } = await import("../src/main/appPaths");
  const { McpBlockOcrTargetSchema } = await import("../src/shared/mcpBlockOcr");
  const { McpOAuthProvider } = await import("../src/main/mcp/mcpOAuthProvider");
  const { McpOAuthSession } = await import("../src/main/mcp/mcpOAuthSession");
  const { McpOAuthHttp } = await import("../src/main/mcp/mcpOAuthHttp");
  const { McpPairingBroker } = await import("../src/main/mcp/mcpPairingBroker");
  const { startMcpHttpServer } = await import("../src/main/mcp/mcpHttpServer");
  const jobs = new ActiveJobStore({ info: vi.fn(), error: vi.fn() });
  const stop = jobs.pageHandoffs.subscribe(() => {
    for (const item of jobs.pageHandoffs.activities)
      if (item.phase === "finishing-edits" && item.requestId)
        jobs.pageHandoffs.respond({ requestId: item.requestId });
  });
  const app = {
    jobs,
    appPaths: getAppPaths(),
    getMainWindow: () => null,
    decodeImage: async () => null,
  };
  const evidence = {
    engine: "hayai",
    sourceLanguage: "ja",
    sourceCropSha256: "a".repeat(64),
    recognizedText: "再読した原文 🥕",
    regions: [
      {
        sequence: 0,
        sourceText: "再読した原文 🥕",
        sourceRect: { x: 10, y: 20, w: 90, h: 120 },
        sourceDirection: "vertical" as const,
        textRole: "ordinary" as const,
      },
    ],
  };
  const recognize = vi.fn<
    ConstructorParameters<typeof McpBlockOcrService>[0]["recognize"]
  >(async () => structuredClone(evidence));
  const observer = new McpBlockOcrService({
    openChapter: f.library.openChapter,
    recognize,
  });
  let journal: unknown = null;
  const persistence = {
    load: async () => structuredClone(journal),
    save: async (value: unknown) => {
      journal = structuredClone(value);
    },
  };
  const operations = new McpOperationService(() => {}, Date.now, persistence);
  const tools = createMcpOperationTools(operations, {
    blockOcr: (target, context) =>
      runMcpAppJob(
        app,
        context,
        "gemma-analysis",
        (job) => observer.run(McpBlockOcrTargetSchema.parse(target), job),
        {
          resources: [{ kind: "model-runtime", scope: "*", access: "write" }],
          page: { ...target, readChapter: f.library.openChapter },
        },
      ),
  });
  const editor = new McpPageEditService({
    openChapter: f.library.openChapter,
    savePageBlocks: f.library.savePageBlocks,
    assertWritable: async () => {},
    notifySaved: () => {},
    withPageEdit: createMcpPageEditScope(app, f.library.openChapter),
  });
  const provider = new McpOAuthProvider(origin, secret, Date.now, {
    allowProcessing: true,
    allowEdits: true,
  });
  const session = new McpOAuthSession(provider, { save: async () => {} });
  const full = grant(provider, "carrot.read carrot.edit carrot.process");
  const read = grant(provider, "carrot.read");
  const other = grant(provider, "carrot.read carrot.process");
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
  const rpc = async (
    method: string,
    params = {},
    token = full,
    signal?: AbortSignal,
  ) => {
    const response = await fetch(server.url, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return response.json();
  };
  const call = (
    name: string,
    args: unknown,
    token = full,
    signal?: AbortSignal,
  ) => rpc("tools/call", { name, arguments: args }, token, signal);
  return {
    ...f,
    evidence,
    recognize,
    operations,
    jobs,
    call,
    rpc,
    read,
    other,
    provider,
    full,
    target: {
      ...f.target,
      revision: createPageRevision(f.after),
      requestId: randomUUID(),
    },
    stored: () => journal,
    restart: async () => {
      const restored = new McpOperationService(() => {}, Date.now, persistence);
      await restored.ready();
      return restored;
    },
    close: async () => {
      await operations.close();
      await server.close();
      stop();
      await f.close();
    },
  };
}
async function settled(f: Awaited<ReturnType<typeof fixture>>, jobId: string) {
  for (let i = 0; i < 100; i++) {
    const reply = await f.call("carrot_get_job", { jobId });
    expect(reply.result.isError).toBe(false);
    if (reply.result.structuredContent.status !== "running")
      return reply.result.structuredContent;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Block OCR fixture did not settle.");
}

it("observes without saving, applies only the chosen source text, and expires text evidence after restart", async () => {
  const f = await fixture();
  try {
    const before = await f.snapshot();
    const started = await f.call("carrot_run_block_ocr", f.target);
    expect(started.result.isError).toBe(false);
    const { jobId } = started.result.structuredContent;
    const job = await settled(f, jobId);
    expect(job).toMatchObject({
      kind: "blockOcr",
      status: "completed",
      result: {
        pagesChanged: 0,
        blockOcr: {
          recognizedText: f.evidence.recognizedText,
          previousSourceText: "source",
        },
      },
    });
    expect(await f.snapshot()).toEqual(before);
    for (const name of ["carrot_get_job", "carrot_list_jobs"]) {
      const result = await f.call(
        name,
        name === "carrot_list_jobs" ? {} : { jobId },
      );
      expect(result.result.content).toHaveLength(1);
      expect(JSON.stringify(result)).not.toMatch(
        /resource_link|dataUrl|mcp-artifacts|image\/png/,
      );
      expect(JSON.stringify(result)).not.toContain(f.environment.root);
    }
    expect(
      (await f.call("carrot_run_block_ocr", f.target)).result.structuredContent
        .jobId,
    ).toBe(jobId);
    expect(f.recognize).toHaveBeenCalledOnce();
    const payload = job.result.blockOcr;
    const applied = await f.call("carrot_update_page_blocks", {
      chapterId: f.target.chapterId,
      pageId: f.target.pageId,
      revision: job.result.revision,
      edits: [
        {
          blockId: f.target.blockId,
          fields: { sourceText: payload.recognizedText },
        },
      ],
    });
    expect(applied.result.isError).toBe(false);
    const page = (await f.library.openChapter("chapter")).pages[0];
    expect(page.blocks).toEqual([
      { ...f.after.blocks[0], sourceText: payload.recognizedText },
      f.after.blocks[1],
    ]);
    expect(page.inpaintedImagePath).toBe(f.after.inpaintedImagePath);
    const restoredText = await f.call("carrot_update_page_blocks", {
      chapterId: f.target.chapterId,
      pageId: f.target.pageId,
      revision: applied.result.structuredContent.revision,
      edits: [
        {
          blockId: f.target.blockId,
          fields: { sourceText: payload.previousSourceText },
        },
      ],
    });
    expect(restoredText.result.isError).toBe(false);
    expect((await f.library.openChapter("chapter")).pages[0].blocks).toEqual(
      f.after.blocks,
    );
    expect(JSON.stringify(f.stored())).not.toContain(f.evidence.recognizedText);
    expect(JSON.stringify(f.stored())).not.toContain("previousSourceText");
    const restored = await f.restart();
    const owner = f.provider.connectionIdFor(`Bearer ${f.full}`);
    if (!owner) throw new Error("Expected owner");
    expect(restored.status(jobId, owner).result).toMatchObject({
      observationExpired: true,
    });
    expect(restored.status(jobId, owner).result?.blockOcr).toBeUndefined();
    await restored.close();
    expect(f.jobs.gate.activities).toEqual([]);
  } finally {
    await f.close();
  }
});

it("enforces processing approval, exact target inputs and job ownership", async () => {
  const f = await fixture();
  try {
    const before = await f.snapshot();
    const listed = await f.rpc("tools/list", {}, f.read);
    expect(
      listed.result.tools.some(
        (tool: { name: string }) => tool.name === "carrot_run_block_ocr",
      ),
    ).toBe(false);
    expect(
      (await f.call("carrot_run_block_ocr", f.target, f.read)).error.code,
    ).toBe(-32602);
    const { blockId: _block, ...missingBlock } = f.target;
    for (const args of [
      missingBlock,
      { ...f.target, path: "C:/private" },
      { ...f.target, blockId: "../escape" },
    ])
      expect((await f.call("carrot_run_block_ocr", args)).error.code).toBe(
        -32602,
      );
    expect(f.recognize).not.toHaveBeenCalled();
    const started = await f.call("carrot_run_block_ocr", f.target);
    const jobId = started.result.structuredContent.jobId;
    await settled(f, jobId);
    expect(
      (await f.call("carrot_get_job", { jobId }, f.other)).result
        .structuredContent.error,
    ).toBe("not_found");
    expect(
      (await f.call("carrot_cancel_job", { jobId }, f.other)).result
        .structuredContent.error,
    ).toBe("not_found");
    expect((await f.call("carrot_get_job_file", { jobId })).error.code).toBe(
      -32602,
    );
    expect(
      (await f.call("carrot_run_block_ocr", { ...f.target, blockId: "b" }))
        .result.structuredContent.error,
    ).toBe("invalid_edit");
    expect(await f.snapshot()).toEqual(before);
  } finally {
    await f.close();
  }
});

it("retains the selected block on explicit failure retry and never reruns a completed request", async () => {
  const f = await fixture();
  try {
    f.recognize.mockRejectedValueOnce(new Error("OCR process failed"));
    const failed = await f.call("carrot_run_block_ocr", f.target);
    const first = failed.result.structuredContent.jobId;
    expect((await settled(f, first)).status).toBe("failed");
    const retried = await f.call("carrot_retry_job", {
      jobId: first,
      revision: f.target.revision,
      requestId: randomUUID(),
    });
    expect(retried.result.isError).toBe(false);
    const next = retried.result.structuredContent.jobId;
    expect((await settled(f, next)).target.blockId).toBe(f.target.blockId);
    expect(f.recognize).toHaveBeenCalledTimes(2);
    const forbidden = await f.call("carrot_retry_job", {
      jobId: next,
      revision: f.target.revision,
      requestId: randomUUID(),
    });
    expect(forbidden.result.structuredContent.error).toBe("invalid_edit");
    expect(f.recognize).toHaveBeenCalledTimes(2);
  } finally {
    await f.close();
  }
});

it("holds page ownership through cancellation until recognition cleanup has actually returned", async () => {
  const f = await fixture();
  const editController = new AbortController();
  let editOutcome: Promise<unknown> | undefined;
  let finish!: () => void;
  let enter!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  f.recognize.mockImplementation(async (_page, _rect, context) => {
    enter();
    await pending;
    context.assertAuthorized();
    return f.evidence;
  });
  try {
    const before = await f.snapshot();
    const started = await f.call("carrot_run_block_ocr", f.target);
    const jobId = started.result.structuredContent.jobId;
    await entered;
    const repeat = await f.call("carrot_run_block_ocr", f.target);
    expect(repeat.result.structuredContent.jobId).toBe(jobId);
    editOutcome = f
      .call(
        "carrot_update_page_blocks",
        {
          chapterId: f.target.chapterId,
          pageId: f.target.pageId,
          revision: f.target.revision,
          edits: [
            {
              blockId: f.target.blockId,
              fields: { sourceText: "must not save" },
            },
          ],
        },
        f.full,
        editController.signal,
      )
      .then(
        (reply) => ({ reply }),
        (error: unknown) => ({ error }),
      );
    await vi.waitFor(() => expect(f.jobs.gate.activities).toHaveLength(2));
    expect(await f.snapshot()).toEqual(before);
    editController.abort();
    expect(await editOutcome).toMatchObject({ error: expect.any(Error) });
    await vi.waitFor(() => expect(f.jobs.gate.activities).toHaveLength(1));
    const cancelled = await f.call("carrot_cancel_job", { jobId });
    expect(cancelled.result.structuredContent).toMatchObject({
      status: "running",
      cancellationRequested: true,
    });
    expect(f.jobs.gate.activities.length).toBeGreaterThan(0);
    expect(f.recognize).toHaveBeenCalledOnce();
    finish();
    const done = await settled(f, jobId);
    expect(done.status).toBe("cancelled");
    expect(done.result?.blockOcr).toBeUndefined();
    expect(await f.snapshot()).toEqual(before);
    expect(f.jobs.gate.activities).toEqual([]);
  } finally {
    finish();
    editController.abort();
    await editOutcome;
    await f.close();
  }
});
