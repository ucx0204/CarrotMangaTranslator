import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  McpOutputDeliveryService,
  type McpOutputDeliveryPorts,
} from "../src/main/application/mcpOutputDeliveryPolicy";
import { McpEditError } from "../src/main/application/mcpEditPolicy";
import { createMcpOutputDeliveryTools } from "../src/main/mcp/mcpOutputDeliveryTools";
import { McpOutputDeliveryReportSchema } from "../src/shared/mcpOutputDelivery";

const metadata = () => ({
  generation: { status: "completed" },
  retention: {
    state: "retained",
    content: "verified",
    source: "current",
    access: "allowed",
    checkedAt: 1000,
  },
});
const input = () => ({ target: { kind: "job" as const, jobId: randomUUID() } });
const observation = () => ({
  state: "not_observed",
  checkedAt: 1000,
  historyComplete: false,
});

it("resolves ownership and payload policy before consulting private observations", async () => {
  const events: string[] = [];
  const target = input();
  const service = new McpOutputDeliveryService({
    resolve: async (owner, actual) => {
      events.push("resolve");
      expect(owner).toBe("owner");
      expect(actual).toEqual(target.target);
      return {
        metadata: metadata(),
        observation: { artifactKey: "private-key" },
      };
    },
    observe: (reference) => {
      events.push("observe");
      expect(reference).toEqual({ artifactKey: "private-key" });
      return observation();
    },
    now: () => 1000,
  });
  const result = await service.inspect("owner", target, () =>
    events.push("guard"),
  );
  expect(events).toEqual(["guard", "resolve", "guard", "observe", "guard"]);
  expect(McpOutputDeliveryReportSchema.parse(result).clientReceipt).toBe(
    "unconfirmed",
  );
  expect(JSON.stringify(result)).not.toContain("private-key");
});

it("never observes denied ownership or a permission loss during native metadata inspection", async () => {
  const observe = vi.fn(observation);
  const denied = new McpEditError("not_found", "Owned output unavailable");
  const deniedService = new McpOutputDeliveryService({
    resolve: async () => {
      throw denied;
    },
    observe,
  });
  await expect(deniedService.inspect("owner", input(), () => {})).rejects.toBe(
    denied,
  );
  let permitted = true;
  const service = new McpOutputDeliveryService({
    resolve: async () => {
      permitted = false;
      return {
        metadata: metadata(),
        observation: { artifactKey: "private-key" },
      };
    },
    observe,
  });
  await expect(
    service.inspect("owner", input(), () => {
      if (!permitted) throw new McpEditError("access_denied", "Revoked");
    }),
  ).rejects.toMatchObject({ code: "access_denied" });
  expect(observe).not.toHaveBeenCalled();
});

it.each(["url", "rootPath", "text", "error"])(
  "rejects a native %s field before observation or public projection",
  async (field) => {
    const observe = vi.fn(observation);
    const service = new McpOutputDeliveryService({
      resolve: async () => ({
        metadata: { ...metadata(), [field]: "private-value" },
        observation: { artifactKey: "a" },
      }),
      observe,
    });
    await expect(
      service.inspect("owner", input(), () => {}),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(observe).not.toHaveBeenCalled();
  },
);

it("keeps unknown session history distinct and preserves partial native publication without inferring success", async () => {
  const receiptId = randomUUID();
  const observe = vi.fn(observation);
  const service = new McpOutputDeliveryService({
    resolve: async () => ({
      metadata: {
        ...metadata(),
        destinationPublication: {
          receiptId,
          status: "partial",
          publishedBytes: 4,
          metadata: "partial",
          mirror: "publication_unconfirmed",
          files: [
            {
              fileId: "mirror:publish",
              role: "mirror",
              pageId: null,
              action: "publish",
              state: "publication_unconfirmed",
              bytes: null,
              sha256: null,
              completedAt: null,
              currentState: "matches_planned",
            },
          ],
        },
      },
    }),
    observe,
    now: () => 1000,
  });
  const result = await service.inspect(
    "owner",
    { target: { kind: "output-sync", receiptId } },
    () => {},
  );
  expect(result).toMatchObject({
    clientReceipt: "unconfirmed",
    observation: { state: "not_observed" },
    destinationPublication: {
      metadata: "partial",
      mirror: "publication_unconfirmed",
    },
  });
  expect(observe).not.toHaveBeenCalled();
});

it("enforces read scope and strict target schemas through the actual tool wrapper", async () => {
  const resolve = vi.fn<McpOutputDeliveryPorts["resolve"]>(async () => ({
    metadata: metadata(),
  }));
  const service = new McpOutputDeliveryService({
    resolve,
    observe: observation,
    now: () => 1000,
  });
  const [tool] = createMcpOutputDeliveryTools(service);
  const checkedScopes: string[][] = [];
  const context = {
    principalId: "owner",
    assertAuthorized: () => {},
    assertScopes: (value: readonly string[]) => checkedScopes.push([...value]),
  };
  for (const target of [
    { kind: "job", jobId: randomUUID(), url: "https://private.invalid" },
    { kind: "retained-output", outputId: randomUUID(), artifactKey: "private" },
    { kind: "output-sync", receiptId: randomUUID(), path: "C:\\private" },
  ])
    await expect(tool.invoke({ target }, context)).rejects.toThrow();
  expect(resolve).not.toHaveBeenCalled();
  const result = await tool.invoke(input(), context);
  expect(result).toHaveLength(1);
  expect(result[0].type).toBe("text");
  expect(
    checkedScopes.every(
      (value) => value.length === 1 && value[0] === "carrot.read",
    ),
  ).toBe(true);
  expect(tool).toMatchObject({
    readOnly: true,
    destructive: false,
    idempotent: true,
  });
});

it("forwards actual payload scopes and fails closed when no additional-scope checker is supplied", async () => {
  const observe = vi.fn(observation);
  const service = new McpOutputDeliveryService({
    resolve: async (_owner, _target, guard, assertAdditionalScopes) => {
      guard();
      assertAdditionalScopes(["carrot.images"]);
      return { metadata: metadata(), observation: { artifactKey: "image" } };
    },
    observe,
    now: () => 1000,
  });
  await expect(
    service.inspect("owner", input(), () => {}),
  ).rejects.toMatchObject({ code: "access_denied" });
  expect(observe).not.toHaveBeenCalled();
  const [tool] = createMcpOutputDeliveryTools(service);
  const scopes: string[][] = [];
  await tool.invoke(input(), {
    principalId: "owner",
    assertAuthorized: () => {},
    assertScopes: (required: readonly string[]) => {
      scopes.push([...required]);
    },
  });
  expect(scopes).toContainEqual(["carrot.images"]);
  expect(observe).toHaveBeenCalledOnce();
});
