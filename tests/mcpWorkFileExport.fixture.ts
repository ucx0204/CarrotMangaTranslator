import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { workFileFixture } from "./mcpWorkFileImport.fixture";
import {
  McpWorkFileExportReviewSchema,
  McpWorkFileExportTargetSchema,
  type McpWorkFileExportTarget,
} from "../src/shared/mcpWorkFileExport";

export async function workFileExportFixture() {
  const f = await workFileFixture();
  const { McpOperationService } =
    await import("../src/main/application/mcpOperationService");
  const { McpArtifactStore } = await import("../src/main/mcp/mcpArtifactStore");
  const { createMcpWorkFileExportAdapter } =
    await import("../src/main/mcp/mcpWorkFileExportAdapter");
  const { createMcpOperationTools } =
    await import("../src/main/mcp/mcpOperationTools");
  const { mcpToolResult } = await import("../src/main/mcp/mcpToolResult");
  const errors: unknown[] = [];
  const operations = new McpOperationService((error) => errors.push(error));
  const artifacts = new McpArtifactStore("https://work-file.test");
  const putOutput = artifacts.putWorkFile.bind(artifacts);
  const outputStore = vi.spyOn(artifacts, "putWorkFile");
  const adapter = createMcpWorkFileExportAdapter({
    app: f.app,
    operations,
    artifacts,
    allowImages: true,
  });
  const unusedRaster = vi.fn(async () => {
    throw new Error("Working-file export must not render.");
  });
  const tools = [
    ...adapter.tools,
    ...createMcpOperationTools(
      operations,
      { exportPng: unusedRaster },
      artifacts.assertAvailable.bind(artifacts),
    ),
  ];
  let allowed = true;
  const auth = (owner = "export-owner") =>
    f.auth(owner, () => {
      if (!allowed) throw new Error("permission revoked");
    });
  const invokeExport = async (name: string, args: object, caller = auth()) => {
    const tool = tools.find((item) => item.name === name);
    if (!tool) throw new Error(`Missing output tool ${name}`);
    const result = mcpToolResult(
      tool,
      await tool.invoke(args as Record<string, unknown>, caller),
    );
    if (result.isError)
      throw new Error(JSON.stringify(result.structuredContent));
    return result.structuredContent;
  };
  const preflight = async () =>
    McpWorkFileExportReviewSchema.parse(
      await invokeExport("carrot_preflight_work_file_export", {
        workId: "work",
        chapterIds: ["chapter"],
      }),
    );
  const command = async () => {
    const review = await preflight();
    return McpWorkFileExportTargetSchema.parse({
      workId: review.workId,
      chapterIds: review.chapterIds,
      snapshot: review.snapshot,
      sourceSnapshot: review.sourceSnapshot,
      requestId: randomUUID(),
      acknowledgeOriginalImages: true,
      acknowledgeV1Limitations: true,
    });
  };
  const exportFile = async (target: McpWorkFileExportTarget) => {
    const accepted = (await invokeExport(
      "carrot_export_work_file",
      target,
    )) as { jobId: string };
    const done = await operations.waitForCompletion(
      accepted.jobId,
      "export-owner",
      new AbortController().signal,
    );
    return { accepted, done };
  };
  return {
    ...f,
    outputErrors: errors,
    operations,
    artifacts,
    putOutput,
    outputStore,
    unusedRaster,
    outputAuth: auth,
    invokeExport,
    preflight,
    exportCommand: command,
    exportFile,
    permitOutput: (value: boolean) => {
      allowed = value;
    },
    close: async () => {
      operations.stop();
      artifacts.stop();
      await operations.close();
      await artifacts.close();
      await f.close();
    },
  };
}
