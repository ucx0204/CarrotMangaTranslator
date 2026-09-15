import { handleMcpMessage } from "../src/main/mcp/mcpProtocol";
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

it("returns precise request errors for malformed stateless envelopes and requests", async () => {
  const f = await fixture();
  expect(
    (await f.call("tools/list", { cursor: "unsupported" })).body.error.code,
  ).toBe(-32602);
  expect(
    (await f.call("tools/call", { name: "unknown" })).body.error.code,
  ).toBe(-32602);
  expect(
    (await f.call("tools/call", { name: "carrot_list_works", arguments: null }))
      .body.error.code,
  ).toBe(-32602);
  expect((await f.call("tools/list", { _meta: {} })).body.error.code).toBe(
    -32020,
  );
  expect(() =>
    validateMcpEnvelope({ method: "server/discover" }, undefined, [version]),
  ).toThrow(/metadata/);
  expect(() =>
    validateMcpEnvelope(
      { method: "tools/list" },
      { "mcp-protocol-version": ["2099-01-01"] },
      [version],
    ),
  ).toThrow(/Unsupported/);
  expect(() =>
    validateMcpEnvelope(
      { method: "tools/call", params: { _meta: meta, name: "x" } },
      {
        "mcp-protocol-version": [version],
        "mcp-method": ["tools/call"],
        "mcp-name": ["=?base64?YR==?="],
      },
      [version],
    ),
  ).toThrow();
  expect(() =>
    validateMcpEnvelope(
      { method: "tools/call", params: { _meta: meta, name: "x" } },
      {
        "mcp-protocol-version": [version],
        "mcp-method": ["tools/call"],
        "mcp-name": [" x"],
      },
      [version],
    ),
  ).toThrow();
  expect(f.invoke).not.toHaveBeenCalled();
  const silent = () => {};
  const notification = {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: { _meta: meta },
  };
  expect((await handleMcpMessage(notification, [], silent)).status).toBe(202);
  const noId = await handleMcpMessage(
    { ...notification, method: "server/discover", params: {} },
    [],
    silent,
  );
  expect(noId.body).toMatchObject({ error: { code: -32602 } });
  expect(noId.body).not.toHaveProperty("id");
  expect(
    (
      await handleMcpMessage(
        { jsonrpc: "2.0", id: {}, method: "tools/list" },
        [],
        silent,
      )
    ).status,
  ).toBe(400);
  const noRequestId = await handleMcpMessage(
    { jsonrpc: "2.0", method: "tools/list" },
    [],
    silent,
  );
  expect(noRequestId.body).toMatchObject({ error: { code: -32600 } });
});

it("enforces bounded HTTP concurrency and reports retry guidance without running excess tools", async () => {
  let finish!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let entered = 0;
  const server = await startMcpHttpServer({
    config: { port: 0, token: "t".repeat(43) },
    reportError: () => {},
    tools: [
      {
        name: "blocked",
        description: "fixture",
        inputSchema: {},
        invoke: async () => {
          entered++;
          await blocked;
          return textContent({ ok: true });
        },
      },
    ],
  });
  servers.push(server);
  const call = () =>
    fetch(server.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${"t".repeat(43)}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "blocked" },
      }),
    });
  const pending = Array.from({ length: 8 }, call);
  try {
    for (let i = 0; i < 100 && entered < 8; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(entered).toBe(8);
    const excess = await call();
    expect(excess.status).toBe(429);
    expect(excess.headers.get("retry-after")).toBe("1");
    expect(entered).toBe(8);
  } finally {
    finish();
    await Promise.all(pending);
  }
});
it("rejects incomplete OAuth server configuration before binding a listener", async () => {
  await expect(
    startMcpHttpServer({
      config: { port: 0, token: "t".repeat(43), oauthPassword: "p".repeat(43) },
      tools: [],
      reportError: () => {},
    }),
  ).rejects.toThrow(/HTTPS public origin/);
});
it("validates request shape and existing handshake inputs without claiming unsupported capabilities", async () => {
  const run = (value: unknown) => handleMcpMessage(value, [], () => {});
  const request = { jsonrpc: "2.0", id: 1, method: "initialize" };
  for (const params of [
    { protocolVersion: "2025-11-25", clientInfo: {} },
    {
      protocolVersion: "2025-11-25",
      clientInfo: { name: "client", version: "1" },
    },
  ]) {
    expect((await run({ ...request, params })).body).toMatchObject({
      error: { code: -32602 },
    });
  }
  expect((await run({ ...request, method: "ping" })).body).toMatchObject({
    result: {},
  });
  expect((await run({ ...request, method: "tools/call" })).body).toMatchObject({
    error: { code: -32602 },
  });
  expect((await run({ ...request, result: {} })).status).toBe(400);
});
