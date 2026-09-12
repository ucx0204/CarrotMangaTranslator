import { describe, expect, it } from "vitest";
import { McpArtifactStore } from "../src/main/mcp/mcpArtifactStore";

const token = (url: string) => new URL(url).pathname.split("/")[2];
describe("MCP scoped PNG outputs", () => {
  it("returns exact output bytes and rechecks access on each read", async () => {
    const store = new McpArtifactStore("https://carrot.test.ts.net");
    let allowed = true;
    const bytes = Buffer.from("synthetic-png-bytes");
    const item = await store.put(bytes, async () => {
      if (!allowed) throw new Error("revoked");
    });
    try {
      expect(item.url).toMatch(
        /^https:\/\/carrot.test.ts.net\/mcp-artifacts\/[A-Za-z0-9_-]{43}\/page.png$/,
      );
      expect(item.sha256).toHaveLength(64);
      expect(await store.read(token(item.url))).toEqual(bytes);
      await expect(store.read("wrong-secret")).rejects.toThrow();
      allowed = false;
      await expect(store.read(token(item.url))).rejects.toThrow();
    } finally {
      await store.close();
    }
  });
  it("expires outputs and revokes every link on stop", async () => {
    let now = 0;
    const store = new McpArtifactStore("https://carrot.test.ts.net", () => now);
    const item = await store.put(Buffer.from("x"), async () => {});
    now = item.expiresAt;
    await expect(store.read(token(item.url))).rejects.toThrow(/expired/);
    store.stop();
    await expect(store.put(Buffer.from("y"), async () => {})).rejects.toThrow();
    await store.close();
  });
  it("does not publish results when authorization changes during the write", async () => {
    const store = new McpArtifactStore("https://carrot.test.ts.net");
    let calls = 0;
    await expect(
      store.put(Buffer.from("x"), async () => {
        if (++calls > 1) throw new Error("revision changed");
      }),
    ).rejects.toThrow(/revision changed/);
    await store.close();
  });
  it("rejects empty and over-budget outputs", async () => {
    const store = new McpArtifactStore("https://carrot.test.ts.net");
    await expect(store.put(Buffer.alloc(0), async () => {})).rejects.toThrow(
      /budget/,
    );
    await expect(
      store.put(Buffer.alloc(64 * 1024 * 1024 + 1), async () => {}),
    ).rejects.toThrow(/budget/);
    await store.close();
  });
});
