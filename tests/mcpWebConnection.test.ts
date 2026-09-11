import assert from "node:assert/strict";
import { it } from "vitest";
import { startMcpHttpServer } from "../src/main/mcp/mcpHttpServer";
import { createMcpToolSet } from "../src/main/mcp/mcpToolSet";

const { runMcpWebProbe } = require("../scripts/mcp-web-probe.cjs") as {
  runMcpWebProbe: (
    endpoint: string,
    password: string,
    expectedOrigin?: string,
  ) => Promise<void>;
};
const { findQuickTunnelOrigin, startQuickTunnel } =
  require("../scripts/mcp-quick-tunnel.cjs") as {
    findQuickTunnelOrigin: (text: string) => string | null;
    startQuickTunnel: (port: number, binary?: string) => Promise<unknown>;
  };

it("extracts only a complete Quick Tunnel HTTPS origin from bounded log text", () => {
  assert.equal(
    findQuickTunnelOrigin("| https://gentle-carrot-test.trycloudflare.com |"),
    "https://gentle-carrot-test.trycloudflare.com",
  );
  for (const text of [
    "http://carrot.trycloudflare.com",
    "https://carrot.trycloudflare.com.evil.example",
    "https://carrot.example",
    "https://carrot.trycloudflare.com?secret=x",
  ])
    assert.equal(findQuickTunnelOrigin(text), null);
});

it("rejects invalid tunnel ports before starting a process", async () => {
  for (const port of [0, -1, 65536, 1.5])
    await assert.rejects(startQuickTunnel(port));
});

it("runs the real web diagnostic through consent, rotation, reads and revocation", async () => {
  const errors: unknown[] = [];
  const issuer = "https://carrot-web-test.example";
  const password = "p".repeat(43);
  const server = await startMcpHttpServer({
    config: {
      port: 0,
      token: "t".repeat(43),
      publicOrigin: issuer,
      oauthPassword: password,
    },
    tools: createMcpToolSet(
      {
        listLibrary: async () => ({ workOrder: [], works: [] }),
        openChapter: async () => {
          throw new Error("No chapter requested");
        },
      },
      undefined,
      true,
    ),
    reportError: (error) => errors.push(error),
  });
  try {
    await runMcpWebProbe(server.url, password, issuer);
    assert.deepEqual(errors, []);
    await assert.rejects(runMcpWebProbe(server.url, "wrong", issuer));
    assert.deepEqual(errors, []);
  } finally {
    await server.close();
  }
});
