import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { it } from "vitest";
import type { ChapterSnapshot, LibraryIndex, MangaPage } from "../src/shared/libraryTypes";
import { McpLibraryReadService } from "../src/main/application/mcpLibraryReadService";
import { readMcpConfiguration } from "../src/main/mcp/mcpConfiguration";
import { createMcpReadTools } from "../src/main/mcp/mcpReadTools";
import { handleMcpMessage } from "../src/main/mcp/mcpProtocol";
import { startMcpHttpServer, type McpHttpServer } from "../src/main/mcp/mcpHttpServer";

const TOKEN = "a".repeat(43);
const ACCEPT = "application/json, text/event-stream";
const createdAt = "2026-09-11T00:00:00.000Z";
const updatedAt = createdAt;

function page(id: string): MangaPage {
  return {
    id, name: `${id}.png`, width: 1000, height: 1600,
    imagePath: "/private/library/original.png",
    inpaintedImagePath: "/private/library/clean.png",
    inpaintMaskPath: "/private/library/mask.png",
    sourceRelativePath: "private/source.png",
    dataUrl: "data:image/png;base64,PRIVATE",
    blocks: [], analysisStatus: "idle", lastError: "/private/secret",
    createdAt, updatedAt,
  };
}

function chapter(): ChapterSnapshot {
  return {
    id: "chapter-1", workId: "work-1", title: "First chapter",
    sourceKind: "images", status: "idle", pageOrder: ["p1", "p2", "p3"],
    pages: [page("p1"), page("p2"), page("p3")], createdAt, updatedAt,
  };
}

function library(): LibraryIndex {
  return {
    workOrder: ["work-1"],
    works: [{
      id: "work-1", title: "Carrot", chapterOrder: ["chapter-1"],
      createdAt, updatedAt,
      chapters: [{
        id: "chapter-1", workId: "work-1", title: "First chapter",
        status: "idle", pageCount: 3, createdAt, updatedAt,
      }],
    }],
  };
}

function service() {
  return new McpLibraryReadService({
    listLibrary: async () => library(),
    openChapter: async (id) => {
      assert.equal(id, "chapter-1");
      return chapter();
    },
  });
}

function request(method: string, params?: Record<string, unknown>) {
  return params === undefined
    ? { jsonrpc: "2.0", id: 1, method }
    : { jsonrpc: "2.0", id: 1, method, params };
}

async function message(value: unknown) {
  const errors: unknown[] = [];
  const reply = await handleMcpMessage(value, createMcpReadTools(service()), (error) => errors.push(error));
  return { reply, errors, json: JSON.stringify(reply.body) };
}

async function withServer(run: (server: McpHttpServer) => Promise<void>) {
  const server = await startMcpHttpServer({
    config: { port: 0, token: TOKEN },
    tools: createMcpReadTools(service()),
    reportError: (error) => { throw error; },
  });
  try { await run(server); } finally { await server.close(); }
}

function post(url: string, body: unknown = request("ping"), headers: Record<string, string> = {}) {
  return fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: ACCEPT, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

it("is disabled by default, including when only a token is supplied", () => {
  assert.equal(readMcpConfiguration({}), null);
  assert.equal(readMcpConfiguration({ CARROT_MCP_TOKEN: TOKEN }), null);
});

it("validates opt-in configuration without accepting short secrets or paths", () => {
  assert.throws(() => readMcpConfiguration({ CARROT_MCP_ENABLED: "1" }));
  assert.throws(() => readMcpConfiguration({ CARROT_MCP_ENABLED: "1", CARROT_MCP_TOKEN: "weak" }));
  const env = { CARROT_MCP_ENABLED: "1", CARROT_MCP_TOKEN: TOKEN };
  assert.equal(readMcpConfiguration(env)?.port, 38475);
  assert.equal(readMcpConfiguration({ ...env, CARROT_MCP_PUBLIC_ORIGIN: "https://carrot.example/" })?.publicOrigin, "https://carrot.example");
  for (const port of ["0", "-1", "65536", "1.5", "NaN", " 10", ""]) {
    assert.throws(() => readMcpConfiguration({ ...env, CARROT_MCP_PORT: port }));
  }
  for (const origin of ["http://carrot.example", "https://carrot.example/mcp", "https://u:p@carrot.example", "https://carrot.example/?token=a", "https://carrot.example/#x", "https://*.example"]) {
    assert.throws(() => readMcpConfiguration({ ...env, CARROT_MCP_PUBLIC_ORIGIN: origin }));
  }
});

it("pages library results and supports case-insensitive filtering", async () => {
  const reads = service();
  assert.equal((await reads.listWorks({ offset: 0, limit: 1 }, "CAR")).works.length, 1);
  assert.equal((await reads.listWorks({ offset: 0, limit: 1 }, "missing")).total, 0);
  assert.equal((await reads.listWorks({ offset: 1, limit: 1 })).works.length, 0);
  assert.equal((await reads.listChapters("work-1", { offset: 0, limit: 25 })).chapters[0].id, "chapter-1");
  await assert.rejects(reads.listChapters("missing", { offset: 0, limit: 25 }));
});

it("projects page metadata without paths, images, masks, source text or raw errors", async () => {
  const first = await service().getChapter("chapter-1", { offset: 0, limit: 2 });
  assert.equal(first.nextOffset, 2);
  assert.deepEqual(first.pages.map((item) => item.id), ["p1", "p2"]);
  const serialized = JSON.stringify(first);
  for (const secret of ["private", "data:image", "imagePath", "inpaint", "sourceRelativePath", "lastError"]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal((await service().getChapter("chapter-1", { offset: 2, limit: 2 })).nextOffset, null);
});

it("negotiates protocol versions and only advertises implemented capabilities", async () => {
  for (const version of ["2025-03-26", "2025-06-18", "2025-11-25", "2099-01-01"]) {
    const { reply, json } = await message(request("initialize", {
      protocolVersion: version, clientInfo: { name: "test", version: "1" }, capabilities: {},
    }));
    assert.equal(reply.status, 200);
    assert.ok(json.includes(version === "2099-01-01" ? "2025-11-25" : version));
    assert.equal(json.includes('"resources"'), false);
    assert.equal(json.includes('"sampling"'), false);
  }
});

for (const value of [null, [], {}, { jsonrpc: "1.0", method: "ping", id: 1 }, { jsonrpc: "2.0", method: "ping", id: null }, { jsonrpc: "2.0", method: "ping", id: 1.5 }, { jsonrpc: "2.0", method: "ping", id: 1, params: [] }]) {
  it(`rejects invalid envelopes: ${JSON.stringify(value)}`, async () => {
    assert.equal((await message(value)).reply.status, 400);
  });
}

it("accepts notifications without returning a response body or invoking tools", async () => {
  assert.deepEqual((await message({ jsonrpc: "2.0", method: "notifications/initialized" })).reply, { status: 202 });
  assert.equal((await message({ jsonrpc: "2.0", method: "tools/call" })).reply.status, 400);
});

it("returns protocol errors for unknown methods, tools and malformed initialization", async () => {
  assert.ok((await message(request("unknown"))).json.includes("-32601"));
  assert.ok((await message(request("tools/call", { name: "__proto__" }))).json.includes("-32602"));
  assert.ok((await message(request("initialize", {}))).json.includes("-32602"));
  assert.ok((await message(request("tools/list", { cursor: "unexpected" }))).json.includes("-32602"));
});

for (const args of [null, [], { limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 0.5 }, { limit: "25" }, { limit: null }, { offset: null }, { query: 5 }, { query: "a".repeat(201) }, { path: "/private" }]) {
  it(`rejects invalid tool arguments: ${JSON.stringify(args).slice(0, 90)}`, async () => {
    assert.ok((await message(request("tools/call", { name: "carrot_list_works", arguments: args }))).json.includes("-32602"));
  });
}

it("rejects path-like ids before reaching storage", async () => {
  for (const chapterId of ["../secret", "C:\\secret", "", "x/y", "a".repeat(129)]) {
    assert.ok((await message(request("tools/call", { name: "carrot_get_chapter", arguments: { chapterId } }))).json.includes("-32602"));
  }
});

it("separates tool failures from protocol errors without leaking error details", async () => {
  const errors: unknown[] = [];
  const tool = { ...createMcpReadTools(service())[0], invoke: async () => { throw new Error("/private/key=SECRET"); } };
  const reply = await handleMcpMessage(request("tools/call", { name: tool.name }), [tool], (error) => errors.push(error));
  const body = JSON.stringify(reply.body);
  assert.ok(body.includes('"isError":true'));
  assert.equal(body.includes("SECRET"), false);
  assert.equal(body.includes("/private"), false);
  assert.equal(errors.length, 1);
});

it("serves actual Streamable HTTP initialize, tools/list, tools/call and notifications", async () => {
  await withServer(async ({ url }) => {
    const init = await post(url, request("initialize", { protocolVersion: "2025-11-25", clientInfo: { name: "test", version: "1" }, capabilities: {} }));
    assert.equal(init.status, 200);
    assert.equal(init.headers.get("mcp-session-id"), null);
    const initialized = await post(url, { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(initialized.status, 202);
    assert.equal(await initialized.text(), "");
    const listing = await post(url, request("tools/list"));
    const json = await listing.json();
    assert.equal(json.result.tools.length, 4);
    assert.ok(json.result.tools.every((tool: { annotations: { readOnlyHint: boolean } }) => tool.annotations.readOnlyHint));
    const result = await post(url, request("tools/call", { name: "carrot_list_works" }));
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.ok((await result.text()).includes("Carrot"));
  });
});

for (const [name, headers, status] of [
  ["missing token", { Authorization: "" }, 401],
  ["wrong token", { Authorization: "Bearer wrong" }, 401],
  ["untrusted origin", { Origin: "https://evil.example" }, 403],
  ["null origin", { Origin: "null" }, 403],
  ["untrusted host", { Host: "evil.example" }, 403],
  ["unsupported protocol", { "MCP-Protocol-Version": "bad" }, 400],
  ["empty protocol", { "MCP-Protocol-Version": "" }, 400],
  ["wrong content type", { "Content-Type": "text/plain" }, 415],
  ["compressed body", { "Content-Encoding": "gzip" }, 415],
  ["unacceptable response", { Accept: "text/event-stream" }, 406],
  ["disabled JSON", { Accept: "application/json;q=0, text/event-stream" }, 406],
] as const) {
  it(`rejects ${name} over actual HTTP`, async () => {
    await withServer(async ({ url }) => {
      assert.equal((await rawPost(url, headers)).status, status);
    });
  });
}

it("does not trust forwarded host or origin headers", async () => {
  await withServer(async ({ url }) => {
    assert.equal((await rawPost(url, { Host: "evil.example", "X-Forwarded-Host": new URL(url).host })).status, 403);
  });
});

it("rejects malformed, oversized bodies, token URLs and unsupported streaming", async () => {
  await withServer(async ({ url }) => {
    const headers = { Authorization: `Bearer ${TOKEN}`, Accept: ACCEPT, "Content-Type": "application/json" };
    assert.equal((await fetch(url, { method: "POST", headers, body: "{" })).status, 400);
    assert.equal((await fetch(url, { method: "POST", headers, body: "x".repeat(70_000) })).status, 413);
    assert.equal((await post(`${url}?token=${TOKEN}`)).status, 404);
    assert.equal((await fetch(url, { headers })).status, 405);
    assert.equal((await fetch(url, { method: "DELETE", headers })).status, 405);
  });
});

it("stops intake and closes idempotently", async () => {
  await withServer(async (server) => {
    server.stopAccepting();
    assert.equal((await post(server.url)).status, 503);
    const first = server.close();
    assert.equal(first, server.close());
    await first;
  });
});

function rawPost(url: string, headers: Record<string, string>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = httpRequest(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`, Accept: ACCEPT,
        "Content-Type": "application/json", ...headers,
      },
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.once("error", reject);
      incoming.once("end", () => resolve({
        status: incoming.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    outgoing.once("error", reject);
    outgoing.end(JSON.stringify(request("ping")));
  });
}
