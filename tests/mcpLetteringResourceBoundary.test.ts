import { expect, it, vi } from "vitest";
import {
  McpLetteringResourceService,
  type McpSavedLetteringResource,
} from "../src/main/application/mcpLetteringResourceService";
import { ConditionalBatchSchemeDraftV2Schema } from "../src/shared/conditionalBatchRules";
import { letteringResourcesFixture } from "./mcpLetteringResources.fixture";
import { clipboardBlock } from "./fixtures/blockClipboard";

function ruleRecord(): McpSavedLetteringResource {
  return {
    id: "rule",
    name: "Owned rule",
    groupIds: [],
    format: null,
    advanced: {},
    dependencies: [],
    unsupportedReasons: [],
    schemes: [
      ConditionalBatchSchemeDraftV2Schema.parse({
        name: "Owned rule",
        match: { mode: "allBlocks" },
        actions: [
          {
            id: "italic",
            enabled: true,
            type: "setFields",
            changes: [{ field: "italic", operation: "set", value: true }],
          },
        ],
      }),
    ],
  };
}
it("keeps authorization live across storage awaits and propagates exact storage failures", async () => {
  const failure = new Error("storage unavailable");
  let revoked = false;
  const read = vi.fn(async () => {
    revoked = true;
    return [ruleRecord()];
  });
  const service = new McpLetteringResourceService(read);
  const guard = () => {
    if (revoked) throw new Error("revoked");
  };
  await expect(service.list({ resourceKind: "rule" }, guard)).rejects.toThrow(
    "revoked",
  );
  read.mockRejectedValueOnce(failure);
  await expect(service.list({ resourceKind: "rule" }, () => {})).rejects.toBe(
    failure,
  );
  read.mockResolvedValueOnce([ruleRecord(), ruleRecord()]);
  await expect(
    service.list({ resourceKind: "rule" }, () => {}),
  ).rejects.toMatchObject({ code: "invalid_edit" });
});

it("rejects group selection for rules and bounds oversized definitions without returning their payload", async () => {
  const record = ruleRecord();
  const service = new McpLetteringResourceService(async () => [record]);
  const guard = () => {};
  const item = (await service.list({ resourceKind: "rule" }, guard))
    .resources[0];
  await expect(
    service.resolve(
      {
        kind: "resource",
        resourceKind: "rule",
        id: item.id,
        snapshot: item.snapshot,
        groupIds: ["color"],
      },
      guard,
    ),
  ).rejects.toMatchObject({ code: "invalid_edit" });
  // The external read port may carry a future native definition larger than this transport.
  record.schemes[0].description = "x".repeat(100001);
  const large = (await service.list({ resourceKind: "rule" }, guard))
    .resources[0];
  expect(large.supported).toBe(false);
  expect(large.unsupportedReasons).toContain("rule_exceeds_remote_limit");
  const result = await service.get(
    { resourceKind: "rule", id: large.id, snapshot: large.snapshot },
    guard,
  );
  expect(result.steps[0].schemeJson).toBeNull();
  await expect(
    service.resolve(
      {
        kind: "resource",
        resourceKind: "rule",
        id: large.id,
        snapshot: large.snapshot,
      },
      guard,
    ),
  ).rejects.toMatchObject({ code: "invalid_edit" });
});

it("marks generated artwork templates unsupported without exposing embedded pixels or text", async () => {
  const f = await letteringResourcesFixture();
  try {
    const entry = await f.addBlockStyle(clipboardBlock());
    const reference = await f.reference("block-style", entry.id);
    const { kind: _kind, ...get } = reference;
    const detail = await f.resources.get(get, () => {});
    expect(detail.supported).toBe(false);
    expect(detail.unsupportedReasons).toEqual(["generated_lettering_template"]);
    expect(detail.formatJson).toBeNull();
    expect(detail.advanced).toEqual({});
    expect(JSON.stringify(detail)).not.toMatch(
      /data:image|PRIVATE_TEMPLATE|maskStrokes|occlusionPolygons/,
    );
    await expect(
      f.resources.resolve(reference, () => {}),
    ).rejects.toMatchObject({ code: "invalid_edit" });
    expect(f.runPage).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("retains only resource queries when editing and processing are disabled", async () => {
  const f = await letteringResourcesFixture();
  const { createMcpLetteringSession } =
    await import("../src/main/mcp/mcpLetteringSession");
  const session = createMcpLetteringSession(
    f.app,
    f.operations,
    { assertWritable: async () => {}, notifySaved: () => {} },
    false,
    f.runtime,
  );
  try {
    expect(session.tools.map((tool) => tool.name)).toEqual([
      "carrot_list_lettering_resources",
      "carrot_get_lettering_resource",
    ]);
    expect(
      session.tools.every(
        (tool) =>
          tool.readOnly &&
          !tool.destructive &&
          tool.requiredScopes?.join() === "carrot.read",
      ),
    ).toBe(true);
    await session.tools[0].invoke({ resourceKind: "preset" }, f.auth());
    expect(f.runtime.create).not.toHaveBeenCalled();
    expect(f.notifySaved).not.toHaveBeenCalled();
  } finally {
    await session.close();
    await f.close();
  }
});
