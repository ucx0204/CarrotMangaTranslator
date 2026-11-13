import { expect, it, vi } from "vitest";
import { typographyAnalysisAppFixture } from "./mcpTypographyAnalysisApp.fixture";
import { mcpTestEncryption } from "./mcpEncryption.fixture";
import { jobRecord } from "./mcpJobStoreV2.fixture";

it("shares one lazy durable history across chat loopback and the external endpoint tools", async () => {
  const f = await typographyAnalysisAppFixture();
  const { McpSecureStore } = await import("../src/main/mcp/mcpSecureStore");
  const { McpLocalHost } = await import("../src/main/mcp/mcpLocalHost");
  const { startMcpHttpServer } = await import("../src/main/mcp/mcpHttpServer");
  const store = new McpSecureStore(f.env.root, mcpTestEncryption());
  const record = jobRecord();
  const journal = store.jobPersistence();
  await journal.open();
  await journal.save(record, null);
  const create = vi.spyOn(store, "jobPersistence");
  const errors = vi.fn();
  const host = new McpLocalHost(
    store,
    {
      processing: () => f.app,
      requestProbe: () => {},
      isBusy: () => false,
      notifySaved: () => {},
    },
    errors,
  );
  let external: Awaited<ReturnType<typeof startMcpHttpServer>> | undefined;
  try {
    const [chat, shared] = await Promise.all([
      host.connect(record.owner, async () => {}),
      host.ready(),
    ]);
    const token = "x".repeat(43);
    external = await startMcpHttpServer({
      config: { port: 0, token },
      tools: shared.tools,
      reportError: errors,
      enforceScopes: true,
      authorization: {
        scopeFor: (header) =>
          header === `Bearer ${token}` ? "carrot.read" : undefined,
        principalFor: (header) =>
          header === `Bearer ${token}` ? record.owner : undefined,
        scopeForPrincipal: (owner) =>
          owner === record.owner ? "carrot.read" : undefined,
      },
    });
    const call = async (url: string, secret: string) => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "carrot_get_job",
            arguments: { jobId: record.id },
          },
        }),
      });
      expect(response.status).toBe(200);
      return (await response.json()).result.structuredContent;
    };
    const [local, remote] = await Promise.all([
      call(chat.url, chat.token),
      call(external.url, token),
    ]);
    expect(local).toMatchObject({
      jobId: record.id,
      status: "completed",
      persistence: "durable",
    });
    expect(remote).toEqual(local);
    expect(create).toHaveBeenCalledOnce();
    expect(errors).not.toHaveBeenCalled();
    chat.close();
  } finally {
    await external?.close();
    await host.dispose();
    await f.close();
  }
});
