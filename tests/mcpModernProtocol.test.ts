import { afterEach, expect, it, vi } from "vitest";
import {
  startMcpHttpServer,
  type McpHttpServer,
} from "../src/main/mcp/mcpHttpServer";
import {
  MCP_MODERN_VERSION,
  validateMcpEnvelope,
} from "../src/main/mcp/mcpProtocolEnvelope";
import { textContent } from "../src/main/mcp/mcpReadTools";

const servers: McpHttpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
const version = MCP_MODERN_VERSION;
const meta = {
  "io.modelcontextprotocol/protocolVersion": version,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
};
const payload = { total: 0, offset: 0, limit: 20, nextOffset: null, works: [] };
async function fixture() {
  const invoke = vi.fn(async () => textContent(payload));
  const server = await startMcpHttpServer({
    config: { port: 0, token: "t".repeat(43) },
    tools: [
      {
        name: "carrot_list_works",
        description: "test",
        inputSchema: {},
        invoke,
      },
    ],
    reportError: () => {},
  });
  servers.push(server);
  const call = async (
    method = "server/discover",
    params: Record<string, unknown> = {},
    headers: Record<string, string | null | undefined> = {},
  ) => {
    const h: Record<string, string> = {
      Authorization: `Bearer ${"t".repeat(43)}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": version,
      "Mcp-Method": method,
      ...(params.name ? { "Mcp-Name": String(params.name) } : {}),
    };
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined) continue;
      if (value === null) delete h[key];
      else h[key] = value;
    }
    const response = await fetch(server.url, {
      method: "POST",
      headers: h,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 12,
        method,
        params: { _meta: meta, ...params },
      }),
    });
    return {
      status: response.status,
      body: await response.json(),
      headers: response.headers,
    };
  };
  return { call, invoke, server };
}
it("discovers and calls directly on separate requests without initialize or session IDs", async () => {
  const f = await fixture();
  const discovered = await f.call();
  expect(discovered.body.result).toMatchObject({
    resultType: "complete",
    supportedVersions: expect.arrayContaining([version]),
    capabilities: { tools: {} },
    _meta: {
      "io.modelcontextprotocol/serverInfo": { name: "carrot-manga-translator" },
    },
  });
  expect(discovered.headers.has("mcp-session-id")).toBe(false);
  const done = await f.call("tools/call", {
    name: "carrot_list_works",
    arguments: {},
  });
  expect(done.body.result).toMatchObject({
    resultType: "complete",
    structuredContent: payload,
    isError: false,
  });
  expect(f.invoke).toHaveBeenCalledOnce();
  const fresh = await fixture();
  expect((await fresh.call("tools/list")).body.result.resultType).toBe(
    "complete",
  );
});
it.each([
  { "MCP-Protocol-Version": null },
  { "Mcp-Method": null },
  { "Mcp-Method": "tools/list" },
  { "MCP-Protocol-Version": "2025-11-25" },
  { "Mcp-Name": "carrot_delete_everything" },
  { "Mcp-Name": null },
  { "Mcp-Name": "=?base64?%%%?=" },
])(
  "rejects missing or mismatched mirrored headers before invoking a tool: %j",
  async (headers) => {
    const f = await fixture();
    const result = await f.call(
      "tools/call",
      { name: "carrot_list_works", arguments: {} },
      headers,
    );
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe(-32020);
    expect(f.invoke).not.toHaveBeenCalled();
  },
);
it("decodes canonical UTF-8 base64 name headers and rejects invalid UTF-8", async () => {
  const f = await fixture();
  const name = `=?base64?${Buffer.from("carrot_list_works").toString("base64")}?=`;
  expect(
    (
      await f.call(
        "tools/call",
        { name: "carrot_list_works" },
        { "Mcp-Name": name },
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await f.call(
        "tools/call",
        { name: "carrot_list_works" },
        { "Mcp-Name": "=?base64?/w==?=" },
      )
    ).body.error.code,
  ).toBe(-32020);
});
it("reports requested and supported versions without a misleading handshake result", async () => {
  const f = await fixture();
  const result = await f.call(
    "tools/list",
    {
      _meta: {
        ...meta,
        "io.modelcontextprotocol/protocolVersion": "2099-01-01",
      },
    },
    { "MCP-Protocol-Version": "2099-01-01" },
  );
  expect(result.status).toBe(400);
  expect(result.body.error).toMatchObject({
    code: -32022,
    data: {
      requested: "2099-01-01",
      supported: expect.arrayContaining([version]),
    },
  });
  expect((await f.call("initialize")).status).toBe(404);
  expect((await f.call("subscriptions/listen")).body.error.code).toBe(-32601);
});
it("requires capabilities per request, not from a previous call, and retains authorization", async () => {
  const f = await fixture();
  await f.call();
  const invalid = await f.call("tools/list", {
    _meta: { "io.modelcontextprotocol/protocolVersion": version },
  });
  expect(invalid.status).toBe(400);
  expect(
    (await f.call("server/discover", {}, { Authorization: null })).status,
  ).toBe(401);
  expect((await f.call("tools/list")).status).toBe(200);
});
it("rejects duplicate headers and invalid client identity at the transport-independent boundary", () => {
  const request = { id: 1, method: "tools/list", params: { _meta: meta } };
  expect(() =>
    validateMcpEnvelope(
      request,
      { "mcp-protocol-version": [version, version] },
      [version],
    ),
  ).toThrow();
  expect(() =>
    validateMcpEnvelope(
      {
        ...request,
        params: {
          _meta: { ...meta, "io.modelcontextprotocol/clientInfo": {} },
        },
      },
      undefined,
      [version],
    ),
  ).toThrow(/identity/);
  expect(validateMcpEnvelope(request, undefined, [version])).toBe(true);
});
