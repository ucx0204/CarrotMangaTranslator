import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { chapterDeletionFixture } from "./mcpChapterDeletion.fixture";
import { createMcpTestGrant } from "./mcpOAuthGrant.fixture";
import { ChapterDeletionRecordSchema } from "../src/main/application/mcpChapterDeletionState";

it("requires separately approved mutation scopes and explicit removal acknowledgement over real HTTP", async () => {
  const f = await openHttp();
  try {
    const reviewed = await f.call(
      "carrot_preview_chapter_deletion",
      f.target,
      f.read,
    );
    expect(reviewed.result.isError).toBe(false);
    const input = {
      ...f.target,
      snapshot: reviewed.result.structuredContent.snapshot,
      requestId: randomUUID(),
      confirm: "delete-chapter-with-seven-day-recovery",
    };
    expect(
      (await f.call("carrot_delete_chapter", input, f.read)).error.message,
    ).toBe("Unknown tool");
    for (const confirm of [true, false, "", "delete"])
      expect(
        (await f.call("carrot_delete_chapter", { ...input, confirm })).error
          .code,
      ).toBe(-32602);
    expect(
      (await f.call("carrot_delete_chapter", { ...input, path: "C:/private" }))
        .error.code,
    ).toBe(-32602);
    await f.assertOriginal();
    const saved = await f.call("carrot_delete_chapter", input);
    expect(saved.result.isError).toBe(false);
    const id = saved.result.structuredContent.id;
    expect(
      (await f.call("carrot_get_chapter_deletion", { id }, f.other)).result
        .isError,
    ).toBe(true);
    expect(
      (await f.call("carrot_list_chapter_deletions", {}, f.other)).result
        .structuredContent.total,
    ).toBe(0);
    const view = await f.call("carrot_get_chapter_deletion", { id });
    expect(view.result.structuredContent.canUndo).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(
      /imagePath|sourceText|note\.txt|Private original|"parts"/,
    );
    const undo = {
      id,
      snapshot: view.result.structuredContent.snapshot,
      requestId: randomUUID(),
      confirm: true,
    };
    expect(
      (await f.call("carrot_undo_chapter_deletion", undo, f.read)).error
        .message,
    ).toBe("Unknown tool");
    expect(
      (await f.call("carrot_undo_chapter_deletion", undo)).result.isError,
    ).toBe(false);
    await f.assertOriginal();
    expect(
      (await f.call("carrot_delete_chapter", input)).result.structuredContent
        .historical,
    ).toBe(true);
    await f.assertOriginal();
    const owner = f.provider.connectionIdFor(`Bearer ${f.full}`);
    if (!owner) throw new Error("Missing fixture grant");
    f.provider.revokeConnection(owner);
    expect(
      (await f.call("carrot_get_chapter_deletion", { id })).error,
    ).toBeDefined();
  } finally {
    await f.close();
  }
});

it("rechecks HTTP grant revocation at publication and preserves all original chapter files", async () => {
  const f = await openHttp();
  try {
    const reviewed = await f.call("carrot_preview_chapter_deletion", f.target);
    const input = {
      ...f.target,
      snapshot: reviewed.result.structuredContent.snapshot,
      requestId: randomUUID(),
      confirm: "delete-chapter-with-seven-day-recovery",
    };
    const owner = f.provider.connectionIdFor(`Bearer ${f.full}`);
    if (!owner) throw new Error("Missing fixture grant");
    const seal = f.codec.seal.bind(f.codec);
    let revoked = false;
    vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
      const bytes = await seal(value);
      if (!revoked && ChapterDeletionRecordSchema.safeParse(value).success) {
        revoked = true;
        f.provider.revokeConnection(owner);
      }
      return bytes;
    });
    const response = await f.call("carrot_delete_chapter", input);
    expect(response.result?.isError || Boolean(response.error)).toBe(true);
    vi.restoreAllMocks();
    expect(revoked).toBe(true);
    await f.assertOriginal();
    expect((await f.storage.index()).entries).toEqual([]);
    expect(f.notify).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

async function openHttp() {
  const f = await chapterDeletionFixture();
  const { McpOAuthProvider } = await import("../src/main/mcp/mcpOAuthProvider");
  const { McpOAuthSession } = await import("../src/main/mcp/mcpOAuthSession");
  const { McpOAuthHttp } = await import("../src/main/mcp/mcpOAuthHttp");
  const { McpPairingBroker } = await import("../src/main/mcp/mcpPairingBroker");
  const { startMcpHttpServer } = await import("../src/main/mcp/mcpHttpServer");
  const origin = "https://chapter-removal.fixture.test",
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
  return {
    ...f,
    full,
    read,
    other,
    provider,
    call,
    close: async () => {
      await server.close();
      await f.close();
    },
  };
}
