import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { libraryImportFixture } from "./mcpLibraryImport.fixture";
import { createMcpTestGrant } from "./mcpOAuthGrant.fixture";
import { McpImportCreateSchema } from "../src/shared/mcpLibraryImport";

export async function libraryImportHttpFixture(
  native: Parameters<typeof libraryImportFixture>[0] = {},
) {
  const f = await libraryImportFixture(native);
  const { McpOAuthProvider } = await import("../src/main/mcp/mcpOAuthProvider");
  const { McpOAuthSession } = await import("../src/main/mcp/mcpOAuthSession");
  const { McpOAuthHttp } = await import("../src/main/mcp/mcpOAuthHttp");
  const { McpPairingBroker } = await import("../src/main/mcp/mcpPairingBroker");
  const { startMcpHttpServer } = await import("../src/main/mcp/mcpHttpServer");
  const { createMcpOperationTools } =
    await import("../src/main/mcp/mcpOperationTools");
  const origin = "https://import-fixture.test",
    secret = "s".repeat(43);
  const provider = new McpOAuthProvider(origin, secret, Date.now, {
    allowEdits: true,
    allowProcessing: true,
  });
  const grant = createMcpTestGrant(origin, secret);
  const full = grant(provider, "carrot.read carrot.edit carrot.process");
  const read = grant(provider, "carrot.read");
  const other = grant(provider, "carrot.read carrot.edit carrot.process");
  const open = () =>
    startMcpHttpServer({
      config: { port: 0, token: "t".repeat(43), publicOrigin: origin },
      tools: [
        ...f.current().session.tools,
        ...createMcpOperationTools(f.current().operations, {}),
      ],
      enforceScopes: true,
      reportError: (error) => f.errors.push(error),
      oauthHttp: new McpOAuthHttp(origin, secret, {
        session: new McpOAuthSession(provider, { save: async () => {} }),
        pairing: new McpPairingBroker(provider, secret),
      }),
    });
  let server = await open();
  const rpc = async (method: string, params: object, token = full) =>
    (
      await fetch(server.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })
    ).json();
  const call = (name: string, args: object, token = full) =>
    rpc("tools/call", { name, arguments: args }, token);
  const settle = async (value: { jobId: string }) => {
    const owner = provider.connectionIdFor(`Bearer ${full}`);
    if (!owner) throw new Error("Missing fixture owner");
    return f
      .current()
      .operations.waitForCompletion(
        value.jobId,
        owner,
        new AbortController().signal,
      );
  };
  const prepare = async () => {
    const accepted = await call("carrot_choose_import_files", {
      source: "local",
      kind: "images",
      requestId: randomUUID(),
    });
    expect(accepted.result.isError).toBe(false);
    const done = await settle(accepted.result.structuredContent);
    expect(done).toMatchObject({ status: "completed" });
    const ref = done.result?.importPreview;
    if (!ref) throw new Error("Missing preview");
    const inspected = await call("carrot_get_import_preview", {
      previewId: ref.previewId,
      snapshot: ref.snapshot,
    });
    expect(inspected.result.isError).toBe(false);
    const review = inspected.result.structuredContent;
    return McpImportCreateSchema.parse({
      requestId: randomUUID(),
      previewId: ref.previewId,
      snapshot: ref.snapshot,
      allowNativePreparation: true,
      target: { mode: "new", title: "HTTP selected work" },
      chapters: [
        {
          draftId: review.pages[0].draftId,
          title: "HTTP chapter",
          pageIds: [review.pages[1].pageId],
        },
      ],
    });
  };
  return {
    ...f,
    full,
    read,
    other,
    provider,
    rpc,
    call,
    prepare,
    settle,
    restart: async () => {
      const approval = JSON.parse(JSON.stringify(provider.snapshot()));
      await server.close();
      provider.restore(approval);
      await f.restart();
      server = await open();
    },
    close: async () => {
      await server.close();
      await f.close();
    },
  };
}
