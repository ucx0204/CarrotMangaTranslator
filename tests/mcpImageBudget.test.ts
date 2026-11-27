import { expect, it, vi } from "vitest";
import type { AppPaths } from "../src/main/appPaths";
import { createMcpImageBudgetTool } from "../src/main/mcp/mcpImageBudgetTool";
import { MCP_TRANSLATION_INSTRUCTIONS } from "../src/shared/mcpTranslationInstructions";
import {
  ImageEditingBudgetSchema,
  imageEditingBudget,
} from "../src/shared/imageEditingBudget";

vi.mock("electron", () => ({ app: { getVersion: () => "test" } }));

it("names the ordinary erasure model and fallback in the instructions shared with chat clients", () => {
  expect(MCP_TRANSLATION_INSTRUCTIONS).toContain(
    "ordinary erasure uses Qwen Image 2.1 with FLUX available as a fallback",
  );
});

it.each([
  ["plus", 10, false, "complex-only", 1],
  ["pro", 10, false, "complex-only", 2],
  ["plus", 65, false, "local-first", 1],
  ["pro", 65, false, "complex-only", 2],
  ["pro", 90, false, "avoid", 0],
  ["plus", null, false, "local-first", 1],
  [null, null, false, "local-first", 1],
  ["pro", 10, true, "avoid", 0],
] as const)(
  "uses %s/%s/%s as budget pressure, not image entitlement",
  (planType, usedPercent, limitReached, generation, attempts) => {
    expect(
      imageEditingBudget({
        planType,
        usedPercent,
        limitReached,
        resetsAt: null,
      }),
    ).toMatchObject({
      generation,
      maxAttemptsPerRegion: attempts,
      imageQuotaRemaining: null,
      simpleBackground: "aot-inpainting",
      ordinaryBackground: "qwen-image-2.1",
    });
  },
);

function fixture(limits: unknown) {
  const controller = new AbortController();
  const client = {
    readAccount: vi.fn(async () => ({
      requiresOpenaiAuth: true,
      account: {
        type: "chatgpt" as const,
        email: "private@example.com",
        planType: "plus",
      },
    })),
    connection: { request: vi.fn(async () => limits) },
    dispose: vi.fn(async () => {}),
  };
  const start = vi.fn(async () => client);
  const tool = createMcpImageBudgetTool(
    {} as AppPaths,
    controller.signal,
    start,
  );
  return { tool, client, start, controller };
}
const future = Math.floor(Date.now() / 1000) + 3600;
it("uses the multi-bucket Codex view and most constrained active window, excluding unrelated quotas and credentials", async () => {
  const f = fixture({
    rateLimits: { primary: { usedPercent: 0, resetsAt: future } },
    rateLimitsByLimitId: {
      codex: {
        primary: { usedPercent: 30, resetsAt: future },
        secondary: { usedPercent: 87, resetsAt: future },
      },
      unrelated: { primary: { usedPercent: 100, resetsAt: future } },
    },
  });
  const result = await f.tool.invoke({});
  const data = ImageEditingBudgetSchema.parse(
    JSON.parse(result[0].type === "text" ? result[0].text : ""),
  );
  expect(data).toMatchObject({
    usedPercent: 87,
    remainingPercent: 13,
    generation: "avoid",
  });
  expect(JSON.stringify(result)).not.toContain("private@example.com");
  expect(f.client.connection.request).toHaveBeenCalledWith(
    "account/rateLimits/read",
    undefined,
    5000,
  );
  expect(f.client.dispose).toHaveBeenCalledOnce();
});
it.each([
  {},
  { rateLimits: { primary: { usedPercent: 35, resetsAt: 1 } } },
  { rateLimits: { primary: { usedPercent: 101, resetsAt: future } } },
  { rateLimits: { primary: { usedPercent: 20, resetsAt: null } } },
])(
  "keeps unavailable, stale or malformed usage unknown: %j",
  async (limits) => {
    const f = fixture(limits);
    expect(JSON.stringify(await f.tool.invoke({}))).toContain(
      '\\"usedPercent\\":null',
    );
  },
);
it("releases the account client on failure and never treats optional quota errors as zero usage", async () => {
  const f = fixture(null);
  f.client.connection.request.mockRejectedValue(new Error("unsupported"));
  expect(JSON.stringify(await f.tool.invoke({}))).toContain(
    '\\"remainingPercent\\":null',
  );
  f.client.readAccount.mockRejectedValue(new Error("signed out"));
  await expect(f.tool.invoke({})).rejects.toThrow("signed out");
  expect(f.client.dispose).toHaveBeenCalledTimes(2);
});
it("rechecks authorization and cancellation after network reads", async () => {
  const f = fixture({});
  const guard = vi
    .fn()
    .mockImplementationOnce(() => {})
    .mockImplementation(() => {
      throw new Error("revoked");
    });
  await expect(f.tool.invoke({}, { assertAuthorized: guard })).rejects.toThrow(
    "revoked",
  );
  expect(f.client.dispose).toHaveBeenCalledOnce();
  f.controller.abort();
  await expect(f.tool.invoke({})).rejects.toThrow();
  expect(f.start).toHaveBeenCalledOnce();
});
it("rejects caller-supplied account/usage claims before opening any client", async () => {
  const f = fixture({});
  await expect(
    f.tool.invoke({ planType: "pro", remainingPercent: 100 }),
  ).rejects.toThrow();
  expect(f.start).not.toHaveBeenCalled();
});
