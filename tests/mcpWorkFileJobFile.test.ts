import { expect, it, vi } from "vitest";
import { McpOperationService } from "../src/main/application/mcpOperationService";
import { createMcpOperationTools } from "../src/main/mcp/mcpOperationTools";
import { mcpJobFileOutput } from "../src/main/mcp/mcpJobOutputSchema";
import { mcpToolResult } from "../src/main/mcp/mcpToolResult";
import { workFileJobData } from "./mcpWorkFileJob.fixture";

async function fileFixture(patch: Record<string, unknown> = {}) {
  const data = workFileJobData();
  const errors: unknown[] = [];
  const operations = new McpOperationService((error) => errors.push(error));
  const execute = vi.fn(async () => ({ ...data.result, ...patch }));
  const accepted = await operations.start({
    owner: "owner",
    requestId: data.target.requestId,
    kind: "workFileExport",
    parameters: data.target,
    assertAuthorized: () => {},
    execute,
  });
  await operations.waitForCompletion(
    accepted.jobId,
    "owner",
    new AbortController().signal,
  );
  const scopes = new Set(["carrot.read", "carrot.images"]);
  const context = {
    principalId: "owner",
    assertAuthorized: () => {},
    assertScopes: (required: readonly string[]) => {
      if (required.some((scope) => !scopes.has(scope)))
        throw new Error("scope denied");
    },
  };
  const check = vi.fn(async (_url: string) => {});
  const unusedRaster = vi.fn(async () => {
    throw new Error("Must not render");
  });
  const tool = createMcpOperationTools(
    operations,
    { exportPng: unusedRaster },
    check,
  ).find((entry) => entry.name === "carrot_get_job_file");
  if (!tool) throw new Error("Missing working-file retrieval tool");
  const call = async (args: Record<string, unknown> = {}, caller = context) =>
    mcpToolResult(
      tool,
      await tool.invoke({ jobId: accepted.jobId, ...args }, caller),
    );
  return {
    data,
    errors,
    operations,
    execute,
    scopes,
    context,
    check,
    unusedRaster,
    jobId: accepted.jobId,
    call,
    close: () => operations.close(),
  };
}

it("projects a native file with its fixed MIME and name, attaching only on explicit request", async () => {
  const f = await fileFixture({
    sourcePath: "C:/private/source/page.png",
    outputPath: "C:/private/output/work.mgtshare",
    password: "private-secret",
    internal: { sourcePath: "C:/private/nested/page.png" },
  });
  try {
    expect(f.operations.file(f.jobId, "owner")).toEqual(f.data.result);
    for (const includeAttachment of [undefined, false, true]) {
      const result = await f.call(
        includeAttachment === undefined ? {} : { includeAttachment },
      );
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        jobId: f.jobId,
        ...f.data.result,
      });
      expect(result.content).toHaveLength(includeAttachment ? 2 : 1);
      expect(JSON.stringify(result)).not.toMatch(
        /C:\/private|sourcePath|outputPath|password|private-secret|"internal"/,
      );
      if (includeAttachment)
        expect(result.content[1]).toEqual({
          type: "resource_link",
          uri: f.data.result.url,
          name: "carrot-work.mgtshare",
          mimeType: "application/vnd.carrot.mgtshare",
          size: f.data.result.bytes,
        });
      else
        expect(result.content.every((item) => item.type === "text")).toBe(true);
    }
    expect(f.check).toHaveBeenCalledTimes(3);
    expect(f.check).toHaveBeenCalledWith(f.data.result.url);
    expect(JSON.stringify(f.operations.status(f.jobId, "owner"))).not.toMatch(
      /C:\/private|mcp-artifacts|"url"|password/,
    );
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.unusedRaster).not.toHaveBeenCalled();
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

it("rejects mismatched native MIME, filename, kind and invalid sizes before looking up a file", async () => {
  for (const patch of [
    { mimeType: "application/zip" },
    { mimeType: "image/png" },
    { mimeType: undefined },
    { filename: "private-title.mgtshare" },
    { filename: "carrot-work.zip" },
    { kind: "rendered-pages-zip" },
    { bytes: 0 },
    { bytes: 1.5 },
  ]) {
    const f = await fileFixture(patch);
    try {
      for (const includeAttachment of [false, true])
        await expect(f.call({ includeAttachment })).rejects.toThrow();
      expect(f.check).not.toHaveBeenCalled();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.unusedRaster).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  }
});

it("keeps source paths out of both the native metadata projection and its public schema", async () => {
  const data = workFileJobData();
  const valid = { jobId: data.record.id, ...data.result };
  expect(mcpJobFileOutput.safeParse(valid).success).toBe(true);
  for (const patch of [
    { sourcePath: "C:/private/page.png" },
    { outputPath: "C:/private/work.mgtshare" },
    { internal: { sourcePath: "C:/private/page.png" } },
    { workFileExport: { ...data.metadata, sourcePath: "C:/private/page.png" } },
  ])
    expect(mcpJobFileOutput.safeParse({ ...valid, ...patch }).success).toBe(
      false,
    );
  const f = await fileFixture({
    workFileExport: { ...data.metadata, sourcePath: "C:/private/page.png" },
  });
  try {
    expect(() => f.operations.file(f.jobId, "owner")).toThrow();
    for (const includeAttachment of [false, true])
      await expect(f.call({ includeAttachment })).rejects.toThrow();
    expect(f.check).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("requires a completed native export before disclosing a file", async () => {
  for (const status of ["partial", "failed", "cancelled"]) {
    const f = await fileFixture({ status });
    try {
      for (const includeAttachment of [false, true])
        await expect(f.call({ includeAttachment })).rejects.toThrow();
      expect(f.check).not.toHaveBeenCalled();
      expect(f.operations.status(f.jobId, "owner").status).toBe(status);
    } finally {
      await f.close();
    }
  }
});

it("requires the owning connection, both scopes and a whole-file request", async () => {
  const f = await fileFixture();
  try {
    for (const includeAttachment of [false, true]) {
      await expect(
        f.call(
          { includeAttachment },
          { ...f.context, principalId: "another-owner" },
        ),
      ).rejects.toThrow();
      await expect(
        f.call({ includeAttachment, pageId: "page" }),
      ).rejects.toThrow();
      for (const scope of ["carrot.read", "carrot.images"]) {
        f.scopes.delete(scope);
        await expect(f.call({ includeAttachment })).rejects.toThrow(/scope/);
        f.scopes.add(scope);
      }
    }
    expect(f.check).not.toHaveBeenCalled();
    expect(f.execute).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it("rechecks availability and authorization for native text links and attachments without repackaging", async () => {
  const f = await fileFixture();
  try {
    for (const includeAttachment of [false, true]) {
      f.check.mockRejectedValueOnce(new Error("artifact expired"));
      await expect(f.call({ includeAttachment })).rejects.toThrow(/expired/);
      f.check.mockImplementationOnce(async () => {
        f.scopes.delete("carrot.images");
      });
      await expect(f.call({ includeAttachment })).rejects.toThrow(/scope/);
      f.scopes.add("carrot.images");
    }
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.unusedRaster).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
