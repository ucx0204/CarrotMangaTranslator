import { z } from "zod/v4";
import type { McpTool } from "./mcpReadTools";
import type { McpOperationService } from "../application/mcpOperationService";
import { McpEditError } from "../application/mcpEditPolicy";
import { mcpToolResult } from "./mcpToolResult";

export type McpWorkflowSelectionWait = (owner: string, id: string, requestId: string, signal: AbortSignal) => Promise<{
  status: string;
  pages: { pageId: string; expectedRevision: string; state: string; result: string }[];
}>;
/** No caller-selected tool name or raw command crosses the workflow transport contract. */
export class McpWorkflowCalls {
  constructor(
    private readonly tools: readonly McpTool[],
    private readonly operations: McpOperationService,
    private readonly owner: string,
    private readonly guard: () => void,
    readonly waitSelection?: McpWorkflowSelectionWait,
  ) {}
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.guard();
    const tool = this.tools.find((tool) => tool.name === name);
    if (!tool) throw new McpEditError("invalid_edit", "A required native workflow operation is unavailable.");
    const result = mcpToolResult(tool, await tool.invoke(args, {
      principalId: this.owner,
      assertAuthorized: this.guard,
      assertJobAuthorized: this.guard,
      assertScopes: this.guard,
    }));
    this.guard();
    return result.structuredContent;
  }
  async job(name: string, args: Record<string, unknown>, signal: AbortSignal, onJob: (id: string) => Promise<void>) {
    // Invocation can admit a native job before a cancellation is observed. Always obtain its completion lease.
    const tool = this.tools.find((tool) => tool.name === name);
    if (!tool) throw new McpEditError("invalid_edit", "Required native job is unavailable.");
    this.guard();
    const result = mcpToolResult(tool, await tool.invoke(args, {
      principalId: this.owner, assertAuthorized: this.guard,
      assertJobAuthorized: this.guard, assertScopes: this.guard,
    }));
    const { jobId } = z.object({ jobId: z.uuid() }).passthrough().parse(result.structuredContent);
    try { await onJob(jobId); }
    catch (error) {
      await this.operations.waitForCompletion(jobId, this.owner, AbortSignal.abort(error));
      throw error;
    }
    const completed = await this.operations.waitForCompletion(jobId, this.owner, signal);
    this.guard();
    if (completed.status !== "completed" || completed.result?.cleanupFailed)
      throw new McpEditError("invalid_edit", "Native workflow job failed, was cancelled or requires cleanup. Inspect its recorded job ID before retrying.");
    if (!completed.result) throw new Error("Native job completed without result metadata.");
    return completed.result;
  }
}
