import { expect, it, vi } from "vitest";
import { McpTypographyReadService } from "../src/main/application/mcpTypographyReadService";
import { createMcpTypographyReadTools } from "../src/main/mcp/mcpTypographyReadTools";
import { startMcpHttpServer } from "../src/main/mcp/mcpHttpServer";
import { McpOAuthProvider } from "../src/main/mcp/mcpOAuthProvider";
import { McpOAuthSession } from "../src/main/mcp/mcpOAuthSession";
import { McpOAuthHttp } from "../src/main/mcp/mcpOAuthHttp";
import { McpPairingBroker } from "../src/main/mcp/mcpPairingBroker";
import { createMcpTestGrant } from "./mcpOAuthGrant.fixture";
import { editingChapter } from "./mcpEditing.fixture";

async function fixture() {
  const chapter = editingChapter();
  const openChapter = vi.fn(async () => structuredClone(chapter));
  const readCatalog = vi.fn(async () => ({
    snapshot: "a".repeat(16),
    fonts: [],
  }));
  const service = new McpTypographyReadService({ openChapter, readCatalog });
  const origin = "https://typography.tail-test.ts.net",
    secret = "p".repeat(43);
  const provider = new McpOAuthProvider(origin, secret, Date.now, {
    persistent: true,
  });
  const session = new McpOAuthSession(provider, { save: async () => {} });
  const pairing = new McpPairingBroker(provider, secret);
  const token = createMcpTestGrant(origin, secret)(provider, "carrot.read");
  const reportError = vi.fn();
  const server = await startMcpHttpServer({
    config: { port: 0, token: "t".repeat(43), publicOrigin: origin },
    tools: createMcpTypographyReadTools(service),
    reportError,
    enforceScopes: true,
    oauthHttp: new McpOAuthHttp(origin, secret, { session, pairing }),
  });
  const rpc = (method: string, params = {}, bearer = token) =>
    fetch(server.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  return {
    chapter,
    openChapter,
    readCatalog,
    provider,
    session,
    server,
    rpc,
    reportError,
  };
}

it("exposes structured font/preflight output over real HTTP with read scope only", async () => {
  const f = await fixture();
  const before = structuredClone(f.chapter);
  try {
    const listing = await (await f.rpc("tools/list")).json();
    expect(
      listing.result.tools.map((tool: { name: string }) => tool.name),
    ).toEqual(["carrot_list_fonts", "carrot_preflight_typography"]);
    expect(
      listing.result.tools.every(
        (tool: { outputSchema?: unknown }) => tool.outputSchema,
      ),
    ).toBe(true);
    for (const name of ["carrot_list_fonts", "carrot_preflight_typography"]) {
      const args =
        name === "carrot_list_fonts"
          ? {}
          : {
              chapterId: "chapter",
              mode: "size",
              sourceLanguage: "ja",
              targetLanguage: "ko",
            };
      const response = await f.rpc("tools/call", { name, arguments: args });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.result.isError).toBe(false);
      expect(body.result.content).toHaveLength(1);
      expect(body.result.content[0].type).toBe("text");
      expect(JSON.parse(body.result.content[0].text)).toEqual(
        body.result.structuredContent,
      );
      expect(JSON.stringify(body)).not.toMatch(
        /PRIVATE|private|sourceText|imagePath|dataUrl/,
      );
    }
    expect(f.chapter).toEqual(before);
    expect(f.reportError).not.toHaveBeenCalled();
    expect((await f.rpc("tools/list", {}, "wrong-token")).status).toBe(401);
  } finally {
    await f.server.close();
  }
});

it("rejects unknown fields and sanitizes font-storage failures", async () => {
  const f = await fixture();
  try {
    const invalid = await (
      await f.rpc("tools/call", {
        name: "carrot_list_fonts",
        arguments: { path: "private" },
      })
    ).json();
    expect(invalid.error.code).toBe(-32602);
    expect(f.readCatalog).not.toHaveBeenCalled();
    f.readCatalog.mockRejectedValueOnce(
      new Error("C:/private/font-credentials"),
    );
    const failure = await (
      await f.rpc("tools/call", { name: "carrot_list_fonts", arguments: {} })
    ).json();
    expect(failure.result.isError).toBe(true);
    expect(failure.result.structuredContent.error).toBe("operation_failed");
    expect(JSON.stringify(failure)).not.toMatch(/private|credentials/);
    expect(f.openChapter).not.toHaveBeenCalled();
  } finally {
    await f.server.close();
  }
});

it("withholds pending font metadata after authorization revocation", async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.readCatalog.mockImplementationOnce(async () => {
    entered();
    await waiting;
    return { snapshot: "a".repeat(16), fonts: [] };
  });
  try {
    const response = f.rpc("tools/call", {
      name: "carrot_list_fonts",
      arguments: {},
    });
    await started;
    await f.session.run(() =>
      f.provider.revokeConnection(f.provider.connections()[0].id),
    );
    release();
    const body = await (await response).json();
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.error).toBe("access_denied");
    expect(body.result.structuredContent.fonts).toBeUndefined();
  } finally {
    release();
    await f.server.close();
  }
});
