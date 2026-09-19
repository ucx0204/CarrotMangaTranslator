import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { soundEffectFixture } from "./mcpSoundEffect.fixture";
import { createMcpTestGrant } from "./mcpOAuthGrant.fixture";

it("serves versioned sound-effect metadata to read-only OAuth and rejects malformed or unregistered mutations", async () => {
  const f = await soundEffectFixture();
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
    const provider = new McpOAuthProvider(origin, secret);
    const token = createMcpTestGrant(origin, secret)(provider, "carrot.read");
    const session = new McpOAuthSession(provider, { save: async () => {} });
    const errors: unknown[] = [];
    const server = await startMcpHttpServer({
      config: { port: 0, token: "t".repeat(43), publicOrigin: origin },
      tools: [f.reader],
      enforceScopes: true,
      oauthHttp: new McpOAuthHttp(origin, secret, {
        session,
        pairing: new McpPairingBroker(provider, secret),
      }),
      reportError: (error) => errors.push(error),
    });
    closeServer = () => server.close();
    const original = await readFile(f.chapterPath);
    const call = async (name: string, args: object) =>
      (
        await fetch(server.url, {
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
    expect(await readFile(f.chapterPath)).toEqual(original);
    expect(f.startClient).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  } finally {
    await closeServer?.();
    await f.close();
  }
});
