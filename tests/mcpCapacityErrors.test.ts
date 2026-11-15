import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { McpPageBatchService } from "../src/main/application/mcpPageBatchService";
import { McpPageBatchPreparation } from "../src/main/application/mcpPageBatchPreparation";
import { McpEditError } from "../src/main/application/mcpEditPolicy";
import { translationBatchPolicy } from "../src/main/application/mcpTranslationBatchPolicy";
import { mcpToolError } from "../src/main/mcp/mcpToolResult";
import { translationBatchFixture } from "./mcpTranslationBatch.fixture";

it("requires splitting an oversized plan even after waiting, without saving", async () => {
  const f = translationBatchFixture();
  const page = f.chapter.pages[0];
  const original = page.blocks[0];
  page.blocks = Array.from({ length: 80 }, (_, index) => ({
    ...structuredClone(original),
    id: `block-${index}`,
    sourceText: "가".repeat(20_000),
  }));
  page.blockOrder = page.blocks.map((block) => block.id);
  const input = f.request();
  input.pages[0].edits = page.blocks.map((block) => ({
    ...input.pages[0].edits[0],
    blockId: block.id,
  }));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await f.service
        .preview(f.owner, input, f.guard)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(McpEditError);
      const result = mcpToolError(error);
      expect(result.structuredContent).toMatchObject({
        error: "request_too_large",
        retryable: false,
        nextAction: expect.stringContaining("Split"),
      });
      expect(JSON.parse(result.content[0].text)).toEqual(
        result.structuredContent,
      );
      f.advance(31 * 60_000);
    }
    const smaller = {
      ...input,
      requestId: randomUUID(),
      pages: input.pages.slice(1),
    };
    await expect(
      f.service.preview(f.owner, smaller, f.guard),
    ).resolves.toHaveProperty("batchId");
    expect(f.save).not.toHaveBeenCalled();
  } finally {
    await f.service.close();
  }
});

it("classifies a single oversized image snapshot as permanent even with little metadata", async () => {
  const f = translationBatchFixture();
  const service = new McpPageBatchService(f.ports, {
    ...translationBatchPolicy,
    plan: async (...args: Parameters<typeof translationBatchPolicy.plan>) => {
      const plan = await translationBatchPolicy.plan(...args);
      return Object.assign(plan, {
        assets: Array.from({ length: 6 }, () => ({
          generatedLettering: {
            dataUrl: "data:image/png;base64," + "A".repeat(6_000_000),
          },
        })),
      });
    },
  });
  try {
    await expect(
      service.preview(f.owner, f.request(), f.guard),
    ).rejects.toMatchObject({ code: "request_too_large" });
    expect(f.save).not.toHaveBeenCalled();
  } finally {
    await service.close();
    await f.service.close();
  }
});

it("requires retained plan expiry rather than active-job completion and then admits the same request", async () => {
  const f = translationBatchFixture();
  try {
    for (let i = 0; i < 32; i++)
      await f.service.preview(f.owner, f.request(), f.guard);
    const input = f.request();
    const error = await f.service
      .preview(f.owner, input, f.guard)
      .catch((e: unknown) => e);
    expect(mcpToolError(error).structuredContent).toMatchObject({
      error: "plan_capacity_full",
      retryable: true,
      nextAction: expect.stringContaining("expire or be released"),
    });
    f.advance(29 * 60_000);
    await expect(
      f.service.preview(f.owner, input, f.guard),
    ).rejects.toMatchObject({ code: "plan_capacity_full" });
    f.advance(2 * 60_000);
    await expect(
      f.service.preview(f.owner, input, f.guard),
    ).resolves.toHaveProperty("batchId");
    expect(f.save).not.toHaveBeenCalled();
  } finally {
    await f.service.close();
  }
});

it("distinguishes cumulative snapshot capacity from a request that fits alone", async () => {
  const f = translationBatchFixture();
  let now = 1000;
  const service = new McpPageBatchService(
    f.ports,
    {
      ...translationBatchPolicy,
      plan: async (...args: Parameters<typeof translationBatchPolicy.plan>) => {
        const plan = await translationBatchPolicy.plan(...args);
        plan.pages[0].changes[0].sourceText = "x".repeat(3_900_000);
        return plan;
      },
    },
    () => now,
  );
  try {
    for (let i = 0; i < 8; i++)
      await service.preview(f.owner, f.request(), f.guard);
    const input = f.request();
    const error = await service
      .preview(f.owner, input, f.guard)
      .catch((e: unknown) => e);
    expect(mcpToolError(error).structuredContent).toMatchObject({
      error: "plan_capacity_full",
      retryable: true,
    });
    now += 31 * 60_000;
    await expect(
      service.preview(f.owner, input, f.guard),
    ).resolves.toHaveProperty("batchId");
    expect(f.save).not.toHaveBeenCalled();
  } finally {
    await service.close();
    await f.service.close();
  }
});

it("reserves editor_busy for pending preparation and frees that slot after settlement", async () => {
  const preparation = new McpPageBatchPreparation();
  let finish!: (id: string) => void;
  const first = preparation.run(
    "first",
    "first",
    31,
    0,
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  await Promise.resolve();
  try {
    expect(() =>
      preparation.run("second", "second", 31, 0, async () => "id"),
    ).toThrow(expect.objectContaining({ code: "editor_busy" }));
  } finally {
    finish("id");
    await first;
  }
  await expect(
    preparation.run("second", "second", 31, 0, async () => "id"),
  ).resolves.toBe("id");
  expect(() =>
    preparation.run("third", "third", 0, 32 * 1024 * 1024, async () => "id"),
  ).toThrow(expect.objectContaining({ code: "plan_capacity_full" }));
});

it("does not retry an exhausted action history and still replays an existing receipt without another save", async () => {
  const f = translationBatchFixture();
  try {
    const plan = await f.service.preview(f.owner, f.request(), f.guard);
    const firstId = randomUUID();
    for (let i = 0; i < 32; i++) {
      f.start(
        plan.batchId,
        i === 0 ? "apply" : i % 2 ? "undo" : "redo",
        i === 0 ? firstId : randomUUID(),
      );
      expect((await f.done(plan.batchId)).status).toBe("completed");
    }
    const savedCount = f.save.mock.calls.length;
    let error: unknown;
    try {
      f.start(plan.batchId, "redo");
    } catch (failure) {
      error = failure;
    }
    expect(mcpToolError(error).structuredContent).toMatchObject({
      error: "action_history_full",
      retryable: false,
      nextAction: expect.stringContaining("remaining changes"),
    });
    expect(f.start(plan.batchId, "apply", firstId).status).toBe(
      "already_started",
    );
    expect(f.save).toHaveBeenCalledTimes(savedCount);
  } finally {
    await f.service.close();
  }
});

it("keeps image recovery exhaustion distinct from transient resource conflicts", () => {
  expect(
    mcpToolError(
      new McpEditError("image_recovery_limit", "Session references are full."),
    ).structuredContent,
  ).toMatchObject({
    error: "image_recovery_limit",
    retryable: false,
    nextAction: expect.stringContaining("Waiting alone will not release"),
  });
  expect(
    mcpToolError({ code: "APP_ACTIVITY_BUSY" }).structuredContent,
  ).toMatchObject({ error: "editor_busy", retryable: true });
});
