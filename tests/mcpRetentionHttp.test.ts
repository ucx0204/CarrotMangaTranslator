import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { retentionFixture } from "./mcpRetention.fixture";
import { createMcpTestGrant } from "./mcpOAuthGrant.fixture";
import { createPageRevision } from "../src/shared/pageRevision";
import { mcpRetentionOutputs } from "../src/shared/mcpRetention";

async function retainedHttpFixture() {
  const f = await retentionFixture();
  const { McpOAuthProvider } = await import("../src/main/mcp/mcpOAuthProvider");
  const { McpOAuthSession } = await import("../src/main/mcp/mcpOAuthSession");
  const { McpOAuthHttp } = await import("../src/main/mcp/mcpOAuthHttp");
  const { McpPairingBroker } = await import("../src/main/mcp/mcpPairingBroker");
  const { startMcpHttpServer } = await import("../src/main/mcp/mcpHttpServer");
  const { McpOperationService } =
    await import("../src/main/application/mcpOperationService");
  const { McpPageExportService } =
    await import("../src/main/application/mcpPageExportService");
  const { createMcpOperationTools } =
    await import("../src/main/mcp/mcpOperationTools");
  const { bindRetainedOutputSource } =
    await import("../src/main/mcp/mcpRetainedOutputs");
  const origin = "https://retained-http.test",
    secret = "s".repeat(43);
  const options = {
    persistent: true,
    allowEdits: true,
    allowProcessing: true,
    allowImages: true,
  };
  let provider = new McpOAuthProvider(origin, secret, Date.now, {
    allowEdits: true,
    allowProcessing: true,
    allowImages: true,
  });
  const grant = createMcpTestGrant(origin, secret);
  const scope = "carrot.read carrot.edit carrot.process carrot.images";
  const full = grant(provider, scope),
    other = grant(provider, scope),
    read = grant(provider, "carrot.read");
  const errors: unknown[] = [];
  const png = await readFile((await f.snapshot()).pages[0].imagePath);
  const render = vi.fn(async () => png);
  const start = async () => {
    const auth = new McpOAuthSession(provider, { save: async () => {} });
    const artifacts = f.operations().artifacts,
      wrap = f.operations().wrapTool;
    if (!wrap) throw new Error("Missing retention wrapper");
    const manager = new McpOperationService((error) => errors.push(error));
    const exporter = new McpPageExportService({
      openChapter: f.library.openChapter,
      render,
      store: artifacts.put.bind(artifacts),
      bindSource: bindRetainedOutputSource,
      assertImageAccess: async () => {},
    });
    const jobs = createMcpOperationTools(manager, {
      exportPng: (input, context) => exporter.export(input, context),
    }).map(wrap);
    const names = new Set(jobs.map((tool) => tool.name));
    const server = await startMcpHttpServer({
      config: { port: 0, token: "t".repeat(43), publicOrigin: origin },
      tools: [...f.tools().filter((tool) => !names.has(tool.name)), ...jobs],
      artifacts,
      enforceScopes: true,
      oauthHttp: new McpOAuthHttp(origin, secret, {
        session: auth,
        pairing: new McpPairingBroker(provider, secret),
      }),
      reportError: (error) => errors.push(error),
    });
    return { server, manager };
  };
  let running = await start();
  const stop = async () => {
    await running.server.close();
    await running.manager.close();
  };
  const call = async (name: string, args: object, token = full) =>
    (
      await fetch(running.server.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      })
    ).json();
  const download = (url: string, method = "GET") =>
    fetch(new URL(new URL(url).pathname, running.server.url), { method });
  return {
    ...f,
    call,
    download,
    read,
    full,
    other,
    render,
    png,
    errors,
    revoke: () => {
      const id = provider.connectionIdFor(`Bearer ${full}`);
      if (!id) throw new Error("Missing test connection");
      provider.revokeConnection(id);
    },
    restart: async () => {
      const authorization = provider.snapshot();
      await stop();
      await f.restart();
      provider = new McpOAuthProvider(origin, secret, Date.now, options);
      provider.restore(authorization);
      running = await start();
    },
    close: async () => {
      await stop();
      await f.close();
    },
  };
}

it("restores an owned page change after a new MCP session and keeps read-only/foreign callers out of mutation", async () => {
  const f = await retainedHttpFixture();
  try {
    const page = (await f.snapshot()).pages[0];
    const saved = await f.call("carrot_update_page_blocks", {
      chapterId: "chapter",
      pageId: page.id,
      revision: createPageRevision(page),
      edits: [
        {
          blockId: page.blocks[0].id,
          fields: { translatedText: "retained HTTP edit" },
        },
      ],
    });
    expect(saved.result.isError).toBe(false);
    const listed = await f.call("carrot_list_changes", {});
    const id = mcpRetentionOutputs.carrot_list_changes.parse(
      listed.result.structuredContent,
    ).items[0].id;
    await f.restart();
    const read = await f.call("carrot_get_change", { id });
    const change = mcpRetentionOutputs.carrot_get_change.parse(
      read.result.structuredContent,
    );
    expect(change.canUndo).toBe(true);
    expect(read.result.content).toHaveLength(1);
    expect(JSON.stringify(read)).not.toMatch(
      /imagePath|dataUrl|inpaintedImagePath|retained HTTP edit/,
    );
    const request = {
      id,
      requestId: randomUUID(),
      pages: change.pages.map(
        ({ chapterId, pageId, revision, reviewRevision }) => ({
          chapterId,
          pageId,
          revision,
          reviewRevision,
        }),
      ),
    };
    expect(
      (await f.call("carrot_undo_change", request, f.read)).error.message,
    ).toBe("Unknown tool");
    expect(
      (await f.call("carrot_get_change", { id }, f.other)).result
        .structuredContent.error,
    ).toBe("not_found");
    expect(
      (await f.call("carrot_get_change", { id, snapshot: {} })).error.code,
    ).toBe(-32602);
    expect(
      (await f.call("carrot_undo_change", request)).result.structuredContent
        .status,
    ).toBe("saved");
    await f.restart();
    expect(
      (await f.call("carrot_undo_change", request)).result.structuredContent
        .historical,
    ).toBe(true);
    expect((await f.snapshot()).pages[0].blocks).toEqual(page.blocks);
    expect(f.render).not.toHaveBeenCalled();
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

it("reissues identical retained bytes over HEAD/GET after restart without granting read-only callers image access", async () => {
  const f = await retainedHttpFixture();
  try {
    const before = await readFile(f.chapterPath);
    const id = await exportOverHttp(f);
    const issued = mcpRetentionOutputs.carrot_get_output_file.parse(
      (await f.call("carrot_get_output_file", { id })).result.structuredContent,
    );
    expect(
      Buffer.from(await (await f.download(issued.url)).arrayBuffer()),
    ).toEqual(f.png);
    await f.restart();
    expect((await f.download(issued.url)).status).toBe(404);
    const denied = (await f.call("carrot_get_output_file", { id }, f.read))
      .result;
    expect(denied).toMatchObject({
      isError: true,
      structuredContent: { error: "not_found", retryable: false },
    });
    expect(JSON.stringify(denied)).not.toMatch(
      /https?:\/\/|data:|resource_link/,
    );
    expect(
      (await f.call("carrot_get_output", { id }, f.other)).result
        .structuredContent.error,
    ).toBe("not_found");
    const next = mcpRetentionOutputs.carrot_get_output_file.parse(
      (await f.call("carrot_get_output_file", { id })).result.structuredContent,
    );
    expect(next.url).not.toBe(issued.url);
    const head = await f.download(next.url, "HEAD");
    expect(head.status).toBe(200);
    expect(Number(head.headers.get("content-length"))).toBe(f.png.length);
    const data = Buffer.from(await (await f.download(next.url)).arrayBuffer());
    expect(createHash("sha256").update(data).digest("hex")).toBe(next.sha256);
    expect(f.render).toHaveBeenCalledTimes(1);
    expect(
      (await f.call("carrot_discard_retained", { id, confirm: false })).error
        .code,
    ).toBe(-32602);
    expect(
      (await f.call("carrot_discard_retained", { id, confirm: true })).result
        .isError,
    ).toBe(false);
    expect((await f.download(next.url)).status).toBe(404);
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

async function exportOverHttp(
  f: Awaited<ReturnType<typeof retainedHttpFixture>>,
) {
  const page = (await f.snapshot()).pages[0];
  const request = {
    chapterId: "chapter",
    pageId: page.id,
    revision: createPageRevision(page),
    requestId: randomUUID(),
  };
  const receipt = await f.call("carrot_export_page_png", request);
  expect(receipt.result.isError).toBe(false);
  const jobId = receipt.result.structuredContent.jobId;
  let id = "";
  await vi.waitFor(async () => {
    const job = await f.call("carrot_get_job", { jobId });
    expect(job.result.structuredContent.status).toBe("completed");
    id = job.result.structuredContent.result.retainedOutputId;
    expect(id).toBeTruthy();
  });
  return id;
}

it("blocks retained bytes after redaction or grant revocation without changing saved artwork", async () => {
  const f = await retainedHttpFixture();
  const { setImageRedactionEnabled } =
    await import("../src/main/imageRedactionStore");
  try {
    const before = await readFile(f.chapterPath);
    const id = await exportOverHttp(f);
    const link = mcpRetentionOutputs.carrot_get_output_file.parse(
      (await f.call("carrot_get_output_file", { id })).result.structuredContent,
    );
    await setImageRedactionEnabled(true, f.env.root);
    expect((await f.download(link.url)).status).toBe(404);
    expect(
      (await f.call("carrot_get_output_file", { id })).result.isError,
    ).toBe(true);
    await setImageRedactionEnabled(false, f.env.root);
    expect((await f.download(link.url)).status).toBe(200);
    f.revoke();
    expect((await f.download(link.url)).status).toBe(404);
    await f.restart();
    const rejected = await f.call("carrot_get_output_file", { id });
    expect(rejected.result).toBeUndefined();
    expect(rejected.error).toBeTruthy();
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.render).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});
