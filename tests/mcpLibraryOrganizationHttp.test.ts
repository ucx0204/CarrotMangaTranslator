import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { pageOrganizationFixture } from "./mcpLibraryPageOrder.fixture";
import { createMcpTestGrant } from "./mcpOAuthGrant.fixture";

it.each(["rename-chapter", "reorder-pages"])(
  "exposes read-only %s review but requires approved edit/process authority for publication and isolates retained owners",
  async (kind) => {
    const f = await pageOrganizationFixture();
    if (kind === "reorder-pages") await f.writeMemory();
    const { McpOAuthProvider } =
      await import("../src/main/mcp/mcpOAuthProvider");
    const { McpOAuthSession } = await import("../src/main/mcp/mcpOAuthSession");
    const { McpOAuthHttp } = await import("../src/main/mcp/mcpOAuthHttp");
    const { McpPairingBroker } =
      await import("../src/main/mcp/mcpPairingBroker");
    const { startMcpHttpServer } =
      await import("../src/main/mcp/mcpHttpServer");
    const origin = "https://organization.fixture.test",
      secret = "s".repeat(43);
    const provider = new McpOAuthProvider(origin, secret, Date.now, {
      allowEdits: true,
      allowProcessing: true,
    });
    const grant = createMcpTestGrant(origin, secret);
    const full = grant(provider, "carrot.read carrot.edit carrot.process");
    const read = grant(provider, "carrot.read");
    const other = grant(provider, "carrot.read carrot.edit carrot.process");
    const server = await startMcpHttpServer({
      config: { port: 0, token: "t".repeat(43), publicOrigin: origin },
      tools: f.organization().tools,
      enforceScopes: true,
      reportError: (error) => f.errors.push(error),
      oauthHttp: new McpOAuthHttp(origin, secret, {
        session: new McpOAuthSession(provider, { save: async () => {} }),
        pairing: new McpPairingBroker(provider, secret),
      }),
    });
    const call = async (name: string, args: object, token = full) =>
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
    try {
      const intent =
        kind === "reorder-pages"
          ? f.intent
          : {
              kind: "rename-chapter",
              workId: "work",
              chapterId: "chapter",
              title: "HTTP 이름",
            };
      const before = await f.library.openChapter(intent.chapterId);
      const review = await call(
        "carrot_preview_library_change",
        { intent },
        read,
      );
      expect(review.result.isError).toBe(false);
      const input = {
        intent,
        snapshot: review.result.structuredContent.snapshot,
        planFingerprint: review.result.structuredContent.planFingerprint,
        requestId: randomUUID(),
      };
      expect(
        (await call("carrot_apply_library_change", input, read)).error.message,
      ).toBe("Unknown tool");
      expect(
        (
          await call("carrot_apply_library_change", {
            ...input,
            path: "C:/private",
          })
        ).error.code,
      ).toBe(-32602);
      const saved = await call("carrot_apply_library_change", input);
      expect(saved.result.isError).toBe(false);
      expect(saved.result.structuredContent.status).toBe("saved");
      const id = saved.result.structuredContent.id;
      expect(
        (await call("carrot_get_library_change", { id }, other)).result.isError,
      ).toBe(true);
      expect(
        (await call("carrot_list_library_changes", {}, other)).result
          .structuredContent.total,
      ).toBe(0);
      const current = await call("carrot_get_library_change", { id });
      expect(current.result.structuredContent.canUndo).toBe(true);
      expect(JSON.stringify(current)).not.toMatch(
        /imagePath|sourceText|selectionSha256|dataUrl/,
      );
      expect(
        (
          await call("carrot_undo_library_change", {
            id,
            snapshot: current.result.structuredContent.snapshot,
            requestId: randomUUID(),
          })
        ).result.isError,
      ).toBe(false);
      expect(await f.library.openChapter(intent.chapterId)).toEqual(before);
      if (kind === "reorder-pages")
        expect(await f.readMemory()).toEqual(f.memory);
      const owner = provider.connectionIdFor(`Bearer ${full}`);
      if (!owner) throw new Error("Missing fixture grant owner");
      provider.revokeConnection(owner);
      expect(
        (await call("carrot_get_library_change", { id })).error,
      ).toBeDefined();
    } finally {
      await server.close();
      await f.close();
    }
  },
);
