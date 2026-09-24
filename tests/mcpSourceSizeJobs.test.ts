import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { McpOperationService } from "../src/main/application/mcpOperationService";
import { createMcpOperationTools } from "../src/main/mcp/mcpOperationTools";
import { mcpToolOutputSchema } from "../src/main/mcp/mcpOutputSchemas";
import {
  parseMcpJobJournal,
  publicMcpJobResult,
} from "../src/main/application/mcpJobJournal";
import type { McpSourceSizeObservation } from "../src/shared/mcpSourceSize";

const observation: McpSourceSizeObservation = {
  sourceImageSha256: "b".repeat(64),
  expiresAt: 1801000,
  measuredBlocks: 1,
  items: [
    {
      blockId: "a",
      estimate: { facePx: 20, confidence: 0.65, method: "raster-core-v1" },
      excludedReason: null,
    },
  ],
  notes: ["source_face_pixels_are_not_nominal_font_size"],
};
const target = () => ({
  chapterId: "chapter",
  pageId: "page",
  revision: "page-v1:1111111111111111",
  requestId: randomUUID(),
});
async function settle(service: McpOperationService, id: string) {
  for (let i = 0; i < 200; i++) {
    const job = service.status(id, "owner");
    if (job.status !== "running") return job;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Measurement did not settle");
}

it("registers an explicit process-scoped, non-destructive source-only operation", async () => {
  const service = new McpOperationService(vi.fn(), () => 1000);
  const execute = vi.fn(async () => ({
    pagesChanged: 0,
    sourceSize: observation,
  }));
  const tools = createMcpOperationTools(service, { sourceSize: execute });
  const tool = tools.find(
    (item) => item.name === "carrot_run_page_source_size",
  );
  if (!tool) throw new Error("Source size tool missing");
  const context = {
    principalId: "owner",
    assertAuthorized: vi.fn(),
    assertJobAuthorized: vi.fn(),
  };
  try {
    expect(tool.requiredScopes).toEqual(["carrot.read", "carrot.process"]);
    expect(tool.readOnly).toBe(true);
    expect(tool.destructive).toBe(false);
    expect(tool.openWorld).toBe(false);
    expect(mcpToolOutputSchema(tool.name)).toBeDefined();
    const request = target();
    const response = await tool.invoke(request, context);
    expect(response).toHaveLength(1);
    const first = response[0];
    if (first.type !== "text") throw new Error("Text receipt required");
    const receipt = JSON.parse(first.text);
    const job = await settle(service, receipt.jobId);
    expect(job.result?.sourceSize).toEqual(observation);
    const again = await tool.invoke(request, context);
    const repeated = again[0];
    if (repeated.type !== "text") throw new Error("Text receipt required");
    expect(JSON.parse(repeated.text).jobId).toBe(receipt.jobId);
    expect(execute).toHaveBeenCalledOnce();
    expect(context.assertJobAuthorized).toHaveBeenCalledWith([
      "carrot.read",
      "carrot.process",
    ]);
    await expect(
      tool.invoke({ ...request, blockId: "a" }, context),
    ).rejects.toThrow();
    await expect(
      tool.invoke({ ...request, imagePath: "private" }, context),
    ).rejects.toThrow();
    await expect(tool.invoke(request)).rejects.toMatchObject({
      code: "access_denied",
    });
  } finally {
    await service.close();
  }
});

it("expires observations without expiring their durable receipt", () => {
  expect(
    publicMcpJobResult({ sourceSize: observation }, 1800999)?.sourceSize,
  ).toEqual(observation);
  expect(publicMcpJobResult({ sourceSize: observation }, 1801000)).toEqual({
    observationExpired: true,
  });
});

it("restores source-size receipts without restoring stale measurements", async () => {
  let disk: unknown = null;
  const persistence = {
    load: async () => structuredClone(disk),
    save: async (value: unknown) => {
      disk = structuredClone(value);
    },
  };
  const service = new McpOperationService(vi.fn(), () => 1000, persistence);
  const request = target();
  const input = {
    owner: "owner",
    requestId: request.requestId,
    kind: "sourceSize",
    parameters: request,
    assertAuthorized: vi.fn(),
    execute: vi.fn(async () => ({ pagesChanged: 0, sourceSize: observation })),
  };
  const receipt = await service.start(input);
  await settle(service, receipt.jobId);
  await service.close();
  expect(JSON.stringify(disk)).not.toContain(observation.sourceImageSha256);
  expect(parseMcpJobJournal(disk)[0].kind).toBe("sourceSize");
  const restored = new McpOperationService(vi.fn(), () => 1000, persistence);
  try {
    await restored.ready();
    expect(restored.status(receipt.jobId, "owner").result).toMatchObject({
      observationExpired: true,
      pagesChanged: 0,
    });
    expect((await restored.start(input)).jobId).toBe(receipt.jobId);
    expect(input.execute).toHaveBeenCalledOnce();
    expect(() => restored.status(receipt.jobId, "different-owner")).toThrow();
  } finally {
    await restored.close();
  }
});
