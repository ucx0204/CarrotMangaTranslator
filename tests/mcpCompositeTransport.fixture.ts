import { createHash, randomUUID } from "node:crypto";
import { vi } from "vitest";
import { createMcpCompositeTools } from "../src/main/mcp/mcpCompositeTools";
import { mcpToolResult } from "../src/main/mcp/mcpToolResult";
import { McpEditError } from "../src/main/application/mcpEditPolicy";
import {
  compositeFixture,
  compositePlan,
  guard,
  mutation,
  owner,
} from "./mcpCompositeWorkflow.fixture";
import type { McpCompositeToolPort } from "../src/main/mcp/mcpCompositeToolPorts";

/** Controller, schemas and projections are real; native render/import inspection ports are deterministic boundaries. */
export function compositeTransportFixture() {
  const f = compositeFixture();
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLagAAAAASUVORK5CYII=",
    "base64",
  );
  const render = f.native.renderEvidence;
  f.native.renderEvidence = async (...args) =>
    (await render(...args)).map((item) => ({
      ...item,
      width: 1,
      height: 1,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      pixelMapping: { originX: 0, originY: 0, scaleX: 100, scaleY: 200 },
    }));
  const grants = new Set([
    "carrot.read",
    "carrot.images",
    "carrot.edit",
    "carrot.process",
  ]);
  let revoked = false;
  const assertAuthorized = vi.fn(() => {
    if (revoked) throw new McpEditError("access_denied", "Approval revoked");
  });
  const assertScopes = vi.fn((scopes: readonly string[]) => {
    if (scopes.some((scope) => !grants.has(scope)))
      throw new McpEditError("access_denied", "Missing scope");
  });
  const auth = {
    principalId: owner,
    assertAuthorized,
    assertScopes,
    assertJobAuthorized: (scopes: readonly string[] = []) => {
      assertAuthorized();
      assertScopes(scopes);
    },
  };
  const readEvidence = vi.fn<McpCompositeToolPort["readEvidence"]>(
    async (record, evidenceId, check) => {
      check(["carrot.read", "carrot.images"]);
      const evidence = record.phases
        .flatMap((phase) => phase.evidence ?? [])
        .find((item) => item.id === evidenceId);
      if (!evidence) throw new McpEditError("not_found", "No issued image");
      return { evidence, bytes: Buffer.from(bytes) };
    },
  );
  const preflight = vi.fn<McpCompositeToolPort["importPreflight"]>(
    async (_owner, input, check) => {
      check();
      return {
        kind: "reviewed-import",
        phaseId: input.phaseId,
        selectionFingerprint: "a".repeat(64),
        itemKeys: ["b".repeat(64)],
        maxChapters: 1,
        maxPages: 1,
      };
    },
  );
  const tools = createMcpCompositeTools({
    service: f.service,
    list: async (principal, check) => {
      check();
      return [...f.records.values()]
        .filter((record) => record.owner === principal)
        .map((record) => f.service.observe(record));
    },
    discard: async (principal, id, check) => {
      check();
      await f.service.get(principal, id, check);
      f.records.delete(id);
      return { id, status: "discarded", pageChanges: 0 };
    },
    importPreflight: preflight,
    readEvidence,
    inspectMetadata: async () => {
      throw new Error("Unexpected native metadata inspection");
    },
  });
  const invoke = async (name: string, input: object = {}, context = auth) => {
    const tool = tools.find((item) => item.name === name);
    if (!tool) throw new Error("Missing composite tool");
    return mcpToolResult(
      tool,
      await tool.invoke(input as Record<string, unknown>, context),
    );
  };
  const review = async () => {
    const plan = compositePlan(true);
    plan.phases = [{ kind: "review", id: "review-one" }];
    const prepared = await f.service.prepare(owner, plan, guard);
    await f.service.run(owner, mutation(prepared), guard);
    return f.service.waitForCompletion(owner, prepared.id, guard);
  };
  return {
    ...f,
    bytes,
    auth,
    grants,
    assertScopes,
    tools,
    invoke,
    review,
    readEvidence,
    preflight,
    revoke: () => {
      revoked = true;
    },
    requestId: randomUUID,
  };
}
