import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { soundEffectToolsFixture } from "./mcpSoundEffectTools.fixture";
import { vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createMcpTestGrant } from "./mcpOAuthGrant.fixture";

it("serves versioned sound-effect metadata to read-only OAuth and rejects malformed or unregistered mutations", async () => {
  const f = await soundEffectToolsFixture();
  let closeServer: (() => Promise<void>) | undefined;
  try {
    const { McpOAuthProvider } =
      await import("../src/main/mcp/mcpOAuthProvider");
    const { McpOAuthSession } = await import("../src/main/mcp/mcpOAuthSession");
    const { McpOAuthHttp } = await import("../src/main/mcp/mcpOAuthHttp");
    const { McpPairingBroker } =
      await import("../src/main/mcp/mcpPairingBroker");
    const { startMcpHttpServer } =
      await import("../src/main/mcp/mcpHttpServer");
    const origin = "https://sound-effect.test",
      secret = "s".repeat(43);
    const provider = new McpOAuthProvider(origin, secret, Date.now, {
      allowEdits: true,
      allowProcessing: true,
      allowImages: true,
    });
    const token = createMcpTestGrant(origin, secret)(provider, "carrot.read");
    const session = new McpOAuthSession(provider, { save: async () => {} });
    const errors: unknown[] = [];
    const server = await startMcpHttpServer({
      config: { port: 0, token: "t".repeat(43), publicOrigin: origin },
      tools: f.soundSession.tools,
      enforceScopes: true,
      oauthHttp: new McpOAuthHttp(origin, secret, {
        session,
        pairing: new McpPairingBroker(provider, secret),
      }),
      reportError: (error) => errors.push(error),
    });
    closeServer = () => server.close();
    const original = await readFile(f.chapterPath);
    expect(original.length).toBeGreaterThan(0);
    const call = async (name: string, args: object, credential = token) =>
      (
        await fetch(server.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${credential}`,
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
    const result = await call("carrot_get_sound_effects", {
      chapterId: "chapter",
      pageId: "page",
    });
    expect(result.result.isError).toBe(false);
    expect(result.result.structuredContent).toMatchObject({
      total: 2,
      generation: { runtimeChecked: false },
    });
    expect(result.result.content).toHaveLength(1);
    expect(JSON.parse(result.result.content[0].text)).toEqual(
      result.result.structuredContent,
    );
    expect(JSON.stringify(result)).not.toContain(f.env.root);
    expect(JSON.stringify(result)).not.toMatch(/dataUrl|imagePath|base64/);
    const bad = await call("carrot_get_sound_effects", {
      chapterId: "chapter",
      pageId: "page",
      path: "C:/private.png",
    });
    expect(bad.error.code).toBe(-32602);
    const mutation = await call("carrot_apply_sound_effect_batch", {});
    expect(mutation.error.message).toBe("Unknown tool");
    const editor = createMcpTestGrant(origin, secret)(
      provider,
      "carrot.read carrot.edit carrot.process",
    );
    expect(
      (await call("carrot_generate_sound_effects", {}, editor)).error.message,
    ).toBe("Unknown tool");
    expect(
      (await call("carrot_get_sound_effect_image", {}, editor)).error.message,
    ).toBe("Unknown tool");
    const page = (await f.snapshot()).pages[0];
    const input = await f.input({
      kind: "text",
      edits: [{ blockId: page.blocks[0].id, translatedText: "SCOPED SFX" }],
    });
    const job = await call("carrot_prepare_sound_effect_batch", input, editor);
    expect(job.result.isError).toBe(false);
    const jobId = job.result.structuredContent.jobId;
    const owner = f.operations.list("unused", 0, 1);
    expect(owner.total).toBe(0);
    let planId = "";
    await vi.waitFor(async () => {
      const duplicate = await call(
        "carrot_prepare_sound_effect_batch",
        input,
        editor,
      );
      expect(duplicate.result.structuredContent.jobId).toBe(jobId);
      if (duplicate.result.structuredContent.status === "running")
        throw new Error("Waiting for sound-effect plan");
      planId =
        duplicate.result.structuredContent.result.soundEffectPlan.batchId;
    });
    const applied = await call(
      "carrot_apply_sound_effect_batch",
      { batchId: planId, requestId: randomUUID() },
      editor,
    );
    expect(applied.result.isError).toBe(false);
    await vi.waitFor(async () => {
      const state = await call(
        "carrot_get_sound_effect_batch",
        { batchId: planId },
        editor,
      );
      expect(state.result.structuredContent.status).toBe("completed");
    });
    expect((await f.snapshot()).pages[0].blocks[0].translatedText).toBe(
      "SCOPED SFX",
    );
    await call(
      "carrot_undo_sound_effect_batch",
      { batchId: planId, requestId: randomUUID() },
      editor,
    );
    await vi.waitFor(async () => {
      const state = await call(
        "carrot_get_sound_effect_batch",
        { batchId: planId },
        editor,
      );
      expect(state.result.structuredContent.status).toBe("completed");
    });
    expect((await f.snapshot()).pages[0].blocks).toEqual(page.blocks);

    expect(f.startClient).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  } finally {
    await closeServer?.();
    await f.close();
  }
});
