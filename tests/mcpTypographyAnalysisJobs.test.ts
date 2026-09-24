import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { McpOperationService } from "../src/main/application/mcpOperationService";
import { createMcpTypographyAnalysisTool } from "../src/main/mcp/mcpTypographyAnalysisTool";
import {
  mcpOutputSchemas,
  mcpToolOutputSchema,
} from "../src/main/mcp/mcpOutputSchemas";
import {
  publicMcpJobResult,
  parseMcpJobJournal,
} from "../src/main/application/mcpJobJournal";
import { typographyAnalysisFixture } from "./mcpTypographyAnalysis.fixture";

const caller = () => ({
  principalId: "owner",
  assertAuthorized: vi.fn(),
  assertScopes: vi.fn(),
  assertJobAuthorized: vi.fn(),
});
async function settle(service: McpOperationService, id: string) {
  for (let i = 0; i < 200; i++) {
    const job = service.status(id, "owner");
    if (job.status !== "running") return job;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Analysis did not settle");
}
function decode(
  items: Awaited<
    ReturnType<ReturnType<typeof createMcpTypographyAnalysisTool>["invoke"]>
  >,
) {
  expect(items).toHaveLength(1);
  const item = items[0];
  if (item.type !== "text") throw new Error("Expected text-only receipt");
  return JSON.parse(item.text);
}

it("registers explicit processing scopes, strict input and output without pretending to apply a font", async () => {
  const f = typographyAnalysisFixture();
  const jobs = new McpOperationService(vi.fn(), () => 1000);
  const execute = vi.fn(f.service.run.bind(f.service));
  const tool = createMcpTypographyAnalysisTool(jobs, execute);
  const auth = caller();
  const request = await f.target();
  try {
    expect(tool.requiredScopes).toEqual(["carrot.read", "carrot.process"]);
    expect(tool.destructive).toBe(false);
    expect(tool.readOnly).toBe(false);
    expect(tool.openWorld).toBe(true);
    expect(mcpToolOutputSchema(tool.name)).toBeDefined();
    const receipt = decode(await tool.invoke(request, auth));
    const result = await settle(jobs, receipt.jobId);
    expect(result.status).toBe("completed");
    expect(result.result?.typographyAnalysis?.pages).toHaveLength(3);
    expect(mcpOutputSchemas.carrot_get_job.safeParse(result).success).toBe(
      true,
    );
    expect(decode(await tool.invoke(request, auth)).jobId).toBe(receipt.jobId);
    expect(execute).toHaveBeenCalledOnce();
    expect(auth.assertJobAuthorized).toHaveBeenCalledWith([
      "carrot.read",
      "carrot.process",
    ]);
    await expect(
      tool.invoke({ ...request, mode: "size" }, auth),
    ).rejects.toMatchObject({ code: "invalid_edit" });
    await expect(
      tool.invoke({ ...request, imagePath: "private" }, auth),
    ).rejects.toThrow();
    await expect(tool.invoke(request)).rejects.toMatchObject({
      code: "access_denied",
    });
    await expect(
      tool.invoke(request, { ...auth, assertScopes: undefined }),
    ).rejects.toMatchObject({ code: "access_denied" });
    expect(() => jobs.status(receipt.jobId, "other")).toThrow();
    expect(() => jobs.file(receipt.jobId, "owner")).toThrow();
  } finally {
    await jobs.close();
  }
});

it("expires observations exactly at the boundary but retains the receipt metadata", async () => {
  const f = typographyAnalysisFixture();
  const result = await f.service.run(await f.target(), f.context);
  expect(publicMcpJobResult(result, 1800999)?.typographyAnalysis).toBeDefined();
  expect(publicMcpJobResult(result, 1801000)).toMatchObject({
    pagesChanged: 0,
    observationExpired: true,
  });
  expect(
    publicMcpJobResult(result, 1801000)?.typographyAnalysis,
  ).toBeUndefined();
});

it("retains durable requests without original hashes or stale font choices after restart", async () => {
  const f = typographyAnalysisFixture();
  let disk: unknown = null;
  const persistence = {
    load: async () => structuredClone(disk),
    save: async (value: unknown) => {
      disk = structuredClone(value);
    },
  };
  const jobs = new McpOperationService(vi.fn(), () => 1000, persistence);
  const request = await f.target();
  const execute = vi.fn(() => f.service.run(request, f.context));
  const input = {
    kind: "typographyAnalysis",
    owner: "owner",
    requestId: request.requestId,
    parameters: request,
    assertAuthorized: vi.fn(),
    execute,
  };
  const receipt = await jobs.start(input);
  await settle(jobs, receipt.jobId);
  await jobs.close();
  expect(parseMcpJobJournal(disk)[0].kind).toBe("typographyAnalysis");
  expect(JSON.stringify(disk)).not.toMatch(
    /sourceImageSha256|synthetic-group|PRIVATE/,
  );
  const restored = new McpOperationService(vi.fn(), () => 1000, persistence);
  try {
    await restored.ready();
    expect(restored.status(receipt.jobId, "owner").result).toMatchObject({
      pagesChanged: 0,
      observationExpired: true,
    });
    expect(
      restored.status(receipt.jobId, "owner").result?.typographyAnalysis,
    ).toBeUndefined();
    expect((await restored.start(input)).jobId).toBe(receipt.jobId);
    expect(execute).toHaveBeenCalledOnce();
  } finally {
    await restored.close();
  }
});

it("requires a new preflight instead of applying single-page retry to failed analysis", async () => {
  const f = typographyAnalysisFixture();
  const jobs = new McpOperationService(vi.fn());
  const tool = createMcpTypographyAnalysisTool(jobs, async () => {
    throw new Error("fixture runtime failure");
  });
  try {
    const request = await f.target();
    const receipt = decode(await tool.invoke(request, caller()));
    expect((await settle(jobs, receipt.jobId)).status).toBe("failed");
    expect(() =>
      jobs.retryTarget(receipt.jobId, "owner", request.pages[0].revision),
    ).toThrow("single-page retry");
  } finally {
    await jobs.close();
  }
});

it("cancels only the requested owned job and does not admit parallel work", async () => {
  const f = typographyAnalysisFixture();
  const jobs = new McpOperationService(vi.fn());
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const execute = vi.fn<Parameters<typeof createMcpTypographyAnalysisTool>[1]>(
    async (_input, context) => {
      await blocked;
      context.assertAuthorized();
      return {};
    },
  );
  const tool = createMcpTypographyAnalysisTool(jobs, execute);
  try {
    const request = await f.target();
    const receipt = decode(await tool.invoke(request, caller()));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await expect(
      tool.invoke({ ...request, requestId: randomUUID() }, caller()),
    ).rejects.toMatchObject({ code: "editor_busy" });
    await expect(jobs.cancel(receipt.jobId, "other")).rejects.toMatchObject({
      code: "not_found",
    });
    await jobs.cancel(receipt.jobId, "owner");
    release();
    const result = await settle(jobs, receipt.jobId);
    expect(result.status).toBe("cancelled");
    expect(result.result).toBeUndefined();
  } finally {
    release();
    await jobs.close();
  }
});
