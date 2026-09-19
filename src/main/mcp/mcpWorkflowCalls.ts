import { z } from "zod/v4";
import type { McpTool } from "./mcpReadTools";
import type { McpOperationService } from "../application/mcpOperationService";
import { McpEditError } from "../application/mcpEditPolicy";
import { mcpToolResult } from "./mcpToolResult";

export type McpWorkflowSelectionWait = (
  owner: string,
  id: string,
  requestId: string,
  signal: AbortSignal,
) => Promise<{
  status: string;
  pages: { pageId: string; expectedRevision: string; state: string; result: string }[];
}>;
export type McpWorkflowSelectionRelease = (owner: string, id: string, requestId: string) => void;
/** No caller-selected tool name or raw command crosses the workflow transport contract. */
export class McpWorkflowCalls {
  constructor(
    private readonly tools: readonly McpTool[],
    private readonly operations: McpOperationService,
    private readonly owner: string,
    private readonly guard: () => void,
    readonly waitSelection?: McpWorkflowSelectionWait,
    readonly releaseSelection?: McpWorkflowSelectionRelease,
  ) {}
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.guard();
    const tool = this.tools.find((tool) => tool.name === name);
    if (!tool)
      throw new McpEditError("invalid_edit", "A required native workflow operation is unavailable.");
    const result = mcpToolResult(tool, await tool.invoke(args, {
      principalId: this.owner,
      assertAuthorized: this.guard,
      assertJobAuthorized: this.guard,
      assertScopes: this.guard,
    }));
    this.guard();
    return result.structuredContent;
  }
  async applySelection(batchId: string, requestId: string, signal: AbortSignal) {
    const tool = this.tools.find((tool) => tool.name === "carrot_apply_selection_batch");
    if (!tool || !this.waitSelection)
      throw new McpEditError("invalid_edit", "Native selection completion is unavailable.");
    this.guard();
    await tool.invoke({ batchId, requestId }, {
      principalId: this.owner,
      assertAuthorized: this.guard,
      assertJobAuthorized: this.guard,
      assertScopes: this.guard,
    });
    const completed = await this.waitSelection(this.owner, batchId, requestId, signal);
    this.guard();
    if (completed.status === "completed") this.releaseSelection?.(this.owner, batchId, requestId);
    return completed;
  }
  async job(name: string, args: Record<string, unknown>, signal: AbortSignal, onJob: (id: string) => Promise<void>) {
    // A native job can be admitted before cancellation is observed. Always wait for its completion lease.
    const tool = this.tools.find((tool) => tool.name === name);
    if (!tool)
      throw new McpEditError("invalid_edit", "Required native job is unavailable.");
    this.guard();
    const result = mcpToolResult(tool, await tool.invoke(args, {
      principalId: this.owner,
      assertAuthorized: this.guard,
      assertJobAuthorized: this.guard,
      assertScopes: this.guard,
    }));
    const { jobId } = z.object({ jobId: z.uuid() }).passthrough().parse(result.structuredContent);
    try {
      await onJob(jobId);
    } catch (error) {
      await this.operations.waitForCompletion(jobId, this.owner, AbortSignal.abort(error));
      throw error;
    }
    const completed = await this.operations.waitForCompletion(jobId, this.owner, signal);
    this.guard();
    return completeNativeResult(completed);
  }
}
function completeNativeResult(completed: Awaited<ReturnType<McpOperationService["waitForCompletion"]>>) {
  const result = completed.result;
  if (
    completed.status !== "completed" || result?.cleanupFailed ||
    result?.status === "partial" || result?.status === "failed" ||
    result?.status === "cancelled" || (result?.blocksIncomplete ?? 0) > 0
  )
    throw new McpEditError(
      "invalid_edit",
      "Native workflow job was incomplete, failed, cancelled or requires cleanup. Inspect its recorded job and saved changes before creating an explicit remaining-target plan.",
    );
  if (!result) throw new Error("Native job completed without result metadata.");
  return result;
}
