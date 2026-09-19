import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { McpOperationService } from "../src/main/application/mcpOperationService";
import { McpSoundEffectPrepareSchema } from "../src/shared/mcpSoundEffects";

it("restores sound-effect receipts without a usable plan, payload images or implicit execution", async () => {
  let snapshot: unknown = null;
  const persistence = {
    load: async () => snapshot,
    save: async (value: unknown) => {
      snapshot = structuredClone(value);
    },
  };
  const service = new McpOperationService(() => {}, Date.now, persistence);
  const input = McpSoundEffectPrepareSchema.parse({
    chapterId: "chapter",
    pageId: "page",
    revision: "page-v1:0000000000000000",
    reviewRevision: "page-v1:0000000000000000",
    contextRevision: "0".repeat(16),
    requestId: randomUUID(),
    reason: "Pure journal fixture",
    command: {
      kind: "text",
      edits: [{ blockId: "sound", translatedText: "BANG" }],
    },
  });
  const execute = vi.fn(async () => ({
    kind: "sound-effect-plan",
    pagesChanged: 0,
    status: "prepared",
    performed: ["sound_effect_preparation"],
    soundEffectPlan: {
      batchId: randomUUID(),
      expiresAt: Date.now() + 60000,
      generationCalls: 0,
      failedItems: 0,
    },
  }));
  const receipt = await service.start({
    owner: "owner",
    kind: "soundEffectPrepare",
    requestId: input.requestId,
    parameters: input,
    assertAuthorized: () => {},
    execute,
  });
  await vi.waitFor(() =>
    expect(service.status(receipt.jobId, "owner").status).toBe("completed"),
  );
  expect(
    service.status(receipt.jobId, "owner").result?.soundEffectPlan,
  ).toBeDefined();
  await service.close();
  const restored = new McpOperationService(() => {}, Date.now, persistence);
  try {
    await restored.ready();
    const result = restored.status(receipt.jobId, "owner");
    expect(result.result?.proposalExpired).toBe(true);
    expect(result.result).not.toHaveProperty("soundEffectPlan");
    expect(result.target).toEqual(input);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /dataUrl|data:image|imagePath/,
    );
    expect(() => restored.status(receipt.jobId, "other")).toThrow("connection");
  } finally {
    await restored.close();
  }
});
it("requires a new explicit sound-effect request rather than generic retry after failure", async () => {
  const service = new McpOperationService(() => {});
  try {
    const requestId = randomUUID();
    const parameters = McpSoundEffectPrepareSchema.parse({
      chapterId: "chapter",
      pageId: "page",
      revision: "page-v1:0000000000000000",
      reviewRevision: "page-v1:0000000000000000",
      contextRevision: "0".repeat(16),
      requestId,
      reason: "Pure journal fixture",
      command: {
        kind: "text",
        edits: [{ blockId: "sound", translatedText: "BANG" }],
      },
    });
    const receipt = await service.start({
      owner: "owner",
      kind: "soundEffectPrepare",
      requestId,
      parameters,
      assertAuthorized: () => {},
      execute: async () => {
        throw new Error("deliberate provider failure");
      },
    });
    await vi.waitFor(() =>
      expect(service.status(receipt.jobId, "owner").status).toBe("failed"),
    );
    expect(() =>
      service.retryTarget(receipt.jobId, "owner", parameters.revision),
    ).toThrow("new explicit request");
  } finally {
    await service.close();
  }
});
