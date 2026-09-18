import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { imageEditingFixture, brushCommand } from "./mcpImageEditing.fixture";
import { createMcpTestGrant } from "./mcpOAuthGrant.fixture";

async function fixture() {
  const f = await imageEditingFixture();
  const { McpOAuthProvider } = await import("../src/main/mcp/mcpOAuthProvider");
  const { McpOAuthSession } = await import("../src/main/mcp/mcpOAuthSession");
  const { McpOAuthHttp } = await import("../src/main/mcp/mcpOAuthHttp");
  const { McpPairingBroker } = await import("../src/main/mcp/mcpPairingBroker");
  const { startMcpHttpServer } = await import("../src/main/mcp/mcpHttpServer");
  const origin = "https://image-edit.test",
    secret = "s".repeat(43);
  const provider = new McpOAuthProvider(origin, secret, Date.now, {
    allowEdits: true,
    allowProcessing: true,
    allowImages: true,
  });
  const oauth = new McpOAuthSession(provider, { save: async () => {} });
  const grant = createMcpTestGrant(origin, secret),
    scope = "carrot.read carrot.edit carrot.process carrot.images";
  const full = grant(provider, scope),
    read = grant(provider, "carrot.read"),
    other = grant(provider, scope);
  const noImages = grant(provider, "carrot.read carrot.edit carrot.process");
  const principal = provider.connectionIdFor(`Bearer ${full}`);
  if (!principal) throw new Error("Missing synthetic principal");
  const server = await startMcpHttpServer({
    config: { port: 0, token: "t".repeat(43), publicOrigin: origin },
    enforceScopes: true,
    tools: f.session.tools,
    oauthHttp: new McpOAuthHttp(origin, secret, {
      session: oauth,
      pairing: new McpPairingBroker(provider, secret),
    }),
    reportError: vi.fn(),
  });
  const call = async (name: string, args: unknown, token = full) => {
    const response = await fetch(server.url, {
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
    });
    return { status: response.status, body: await response.json() };
  };
  const done = async (batchId: string) => {
    await vi.waitFor(
      async () => {
        const response = await call("carrot_get_image_edit", { batchId });
        expect(response.body.result.isError).toBe(false);
        expect(response.body.result.structuredContent.status).not.toBe(
          "running",
        );
      },
      { timeout: 10000 },
    );
    return (await call("carrot_get_image_edit", { batchId })).body.result
      .structuredContent;
  };
  return {
    ...f,
    provider,
    principal,
    call,
    done,
    read,
    other,
    noImages,
    close: async () => {
      f.session.stop();
      await server.close();
      await f.close();
    },
  };
}

it("completes reviewed mask apply undo redo over OAuth HTTP with matching structured results and no repeated inference", async () => {
  const f = await fixture();
  try {
    const request = await f.input(brushCommand());
    const reply = (await f.call("carrot_preview_image_edit", request)).body
      .result;
    expect(reply.isError).toBe(false);
    expect(JSON.parse(reply.content[0].text)).toEqual(reply.structuredContent);
    const batchId = reply.structuredContent.batchId;
    const mask = (await f.call("carrot_get_image_edit_mask", { batchId })).body
      .result;
    expect(mask.isError).toBe(false);
    expect(mask.content[1].type).toBe("image");
    expect(JSON.parse(mask.content[0].text)).toEqual(mask.structuredContent);
    expect(JSON.stringify(mask.structuredContent)).not.toMatch(
      /imagePath|sourceHash|dataUrl/,
    );
    for (const direction of ["apply", "undo", "redo", "undo"]) {
      const accepted = (
        await f.call(`carrot_${direction}_image_edit`, {
          batchId,
          requestId: randomUUID(),
        })
      ).body.result;
      expect(accepted.isError).toBe(false);
      expect(accepted.structuredContent.status).toBe("accepted");
      expect((await f.done(batchId)).status).toBe("completed");
    }
    expect(f.inpaint).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    expect((await f.snapshot()).pages[0].inpaintedImagePath).toBeUndefined();
  } finally {
    await f.close();
  }
});

it("separates edit and image scopes, rejects extra fields, and hides foreign plans", async () => {
  const f = await fixture();
  try {
    const request = await f.input(brushCommand()),
      before = await readFile(f.chapterPath);
    expect(
      (await f.call("carrot_preview_image_edit", request, f.read)).body.error
        .code,
    ).toBe(-32602);
    expect(
      (
        await f.call("carrot_preview_image_edit", {
          ...request,
          path: "private",
        })
      ).body.error.code,
    ).toBe(-32602);
    const batchId = (await f.call("carrot_preview_image_edit", request)).body
      .result.structuredContent.batchId;
    expect(
      (await f.call("carrot_get_image_edit_mask", { batchId }, f.noImages)).body
        .error.code,
    ).toBe(-32602);
    expect(
      (await f.call("carrot_get_image_edit", { batchId }, f.other)).body.result
        .structuredContent.error,
    ).toBe("not_found");
    for (const name of ["apply", "undo", "redo", "cancel"])
      expect(
        (
          await f.call(
            `carrot_${name}_image_edit`,
            { batchId, requestId: randomUUID() },
            f.read,
          )
        ).body.error.code,
      ).toBe(-32602);
    expect(
      (
        await f.call(
          "carrot_sample_page_color",
          {
            chapterId: "chapter",
            pageId: "page",
            revision: request.revision,
            image: "original",
            x: 15,
            y: 25,
          },
          f.noImages,
        )
      ).body.error.code,
    ).toBe(-32602);
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.acquireEngine).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("observes real OAuth revocation during cleanup and withholds the generated image save", async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.chapterPath),
      request = await f.input(brushCommand());
    const batchId = (await f.call("carrot_preview_image_edit", request)).body
      .result.structuredContent.batchId;
    f.release.mockImplementationOnce(async () => {
      f.provider.revokeConnection(f.principal);
    });
    expect(
      (
        await f.call("carrot_apply_image_edit", {
          batchId,
          requestId: randomUUID(),
        })
      ).body.result.isError,
    ).toBe(false);
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(f.app.jobs.all).toEqual([]));
    expect((await f.call("carrot_get_image_edit", { batchId })).status).toBe(
      401,
    );
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.inpaint).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});
