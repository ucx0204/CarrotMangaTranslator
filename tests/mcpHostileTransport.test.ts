import { request } from "node:http";
import { expect, it } from "vitest";
import { startMcpHttpServer } from "../src/main/mcp/mcpHttpServer";

async function fixture() {
  const token = "t".repeat(43);
  const server = await startMcpHttpServer({
    config: { port: 0, token },
    reportError: () => {},
    tools: [
      {
        name: "echo",
        description: "Isolated transport fixture",
        inputSchema: {},
        invoke: async (args) => [{ type: "text", text: JSON.stringify(args) }],
      },
    ],
  });
  const send = (bytes: Buffer, fragment = false, authorized = true) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request(
        server.url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${authorized ? token : "invalid"}`,
            "Content-Type": "application/json; charset=utf-8",
            Accept: "application/json, text/event-stream",
            "Content-Length": bytes.length,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.once("error", reject);
          response.once("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              text: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      req.once("error", reject);
      req.setTimeout(5000, () =>
        req.destroy(new Error("fixture request timeout")),
      );
      if (fragment) for (const byte of bytes) req.write(Buffer.from([byte]));
      else req.write(bytes);
      req.end();
    });
  return { server, send };
}
function body(value: unknown) {
  return Buffer.from(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo", arguments: { value } },
    }),
  );
}
it("preserves Unicode, emoji and apparent markup even across single-byte request chunks", async () => {
  const f = await fixture();
  try {
    for (const value of [
      "ASCII",
      "\uD55C\uAE00 \u65E5\u672C\u8A9E \uD83D\uDE00",
      '<script>not executable</script> & "quotes"',
      "a\u0000b\nline\r\n",
      "\u202Eright-to-left",
      "\u200B",
    ]) {
      const response = await f.send(body(value), true);
      expect(response.status).toBe(200);
      expect(
        JSON.parse(JSON.parse(response.text).result.content[0].text),
      ).toEqual({ value });
    }
  } finally {
    await f.server.close();
  }
});
it("rejects invalid UTF-8, oversized multi-byte inputs and unauthenticated requests, then recovers", async () => {
  const f = await fixture();
  try {
    for (const [bytes, status] of [
      [Buffer.from([0xff, 0xfe]), 400],
      [Buffer.from("{} trailing"), 400],
      [body("\uD55C".repeat(23000)), 413],
    ] as const) {
      expect((await f.send(bytes)).status).toBe(status);
      expect((await f.send(body("healthy"))).status).toBe(200);
    }
    expect((await f.send(body("secret"), false, false)).status).toBe(401);
    expect((await f.send(body("healthy"))).status).toBe(200);
  } finally {
    await f.server.close();
  }
});
