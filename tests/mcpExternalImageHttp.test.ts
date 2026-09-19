import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PNG } from "pngjs";
import { expect, it } from "vitest";
import { externalImageFixture, externalPng } from "./mcpExternalImage.fixture";
import { createMcpTestGrant } from "./mcpOAuthGrant.fixture";

async function httpFixture() {
  const f = await externalImageFixture();
  const { McpOAuthProvider } = await import("../src/main/mcp/mcpOAuthProvider");
  const { McpOAuthSession } = await import("../src/main/mcp/mcpOAuthSession");
  const { McpOAuthHttp } = await import("../src/main/mcp/mcpOAuthHttp");
  const { McpPairingBroker } = await import("../src/main/mcp/mcpPairingBroker");
  const { startMcpHttpServer } = await import("../src/main/mcp/mcpHttpServer");
  const origin = "https://external-image.test", secret = "s".repeat(43);
  const provider = new McpOAuthProvider(origin, secret, Date.now, { allowEdits: true, allowProcessing: true, allowImages: true });
  const auth = new McpOAuthSession(provider, { save: async () => {} });
  const grant = createMcpTestGrant(origin, secret);
  const full = grant(provider, "carrot.read carrot.edit carrot.process carrot.images");
  const read = grant(provider, "carrot.read");
  const other = grant(provider, "carrot.read carrot.edit carrot.process carrot.images");
  const server = await startMcpHttpServer({
    config: { port: 0, token: "t".repeat(43), publicOrigin: origin },
    tools: f.external.tools, enforceScopes: true,
    oauthHttp: new McpOAuthHttp(origin, secret, { session: auth, pairing: new McpPairingBroker(provider, secret) }),
    reportError: (error) => f.errors.push(error),
  });
  const request = async (name: string, args: object, token = full) => fetch(server.url, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const call = async (name: string, args: object, token = full) => (await request(name, args, token)).json();
  return { ...f, call, request, full, read, other, close: async () => { await server.close(); await f.close(); } };
}
it("accepts actual bytes over scoped HTTP while preserving the existing 64 KiB body limit", async () => {
  const f = await httpFixture();
  try {
    const original = await readFile(f.chapterPath), png = externalPng(), bytes = PNG.sync.write(png);
    const input = { ...await f.binding(), requestId: randomUUID(), purpose: "image", mimeType: "image/png",
      bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), width: png.width, height: png.height };
    expect((await f.call("carrot_begin_image_upload", input, f.read)).error.message).toBe("Unknown tool");
    const begin = await f.call("carrot_begin_image_upload", input);
    expect(begin.result.isError).toBe(false);
    const uploadId = begin.result.structuredContent.uploadId;
    expect((await f.call("carrot_get_image_upload", { uploadId }, f.other)).result.structuredContent.error).toBe("not_found");
    const oversized = await f.request("carrot_write_image_upload", { uploadId, offset: 0, data: "A".repeat(70_000) });
    expect(oversized.status).toBe(413);
    expect((await f.call("carrot_write_image_upload", { uploadId, offset: 0, data: bytes.toString("base64") })).result.isError).toBe(false);
    const complete = await f.call("carrot_finish_image_upload", { uploadId });
    expect(complete.result.structuredContent).toMatchObject({ status: "ready", sha256: input.sha256, receivedBytes: bytes.length });
    expect(complete.result.content).toHaveLength(1);
    expect(JSON.parse(complete.result.content[0].text)).toEqual(complete.result.structuredContent);
    expect(JSON.stringify(complete)).not.toContain(f.env.root);
    expect(await readFile(f.chapterPath)).toEqual(original);
  } finally { await f.close(); }
});
it("denies unexpected path/URL fields and unapproved image transfer without saving", async () => {
  const f = await httpFixture();
  try {
    const original = await readFile(f.chapterPath);
    const bad = await f.call("carrot_get_image_upload", { uploadId: randomUUID(), url: "http://localhost/private", path: "C:/private.png" });
    expect(bad.error.code).toBe(-32602);
    const masked = await f.call("carrot_get_external_image_preview", { batchId: randomUUID() }, f.read);
    expect(masked.error.message).toBe("Unknown tool");
    expect(await readFile(f.chapterPath)).toEqual(original);
    expect(f.acquireEngine).not.toHaveBeenCalled();
  } finally { await f.close(); }
});
