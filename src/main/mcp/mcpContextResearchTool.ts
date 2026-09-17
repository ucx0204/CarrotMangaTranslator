import { z } from "zod/v4";
import { McpContextResearchTargetSchema, type McpContextResearchTarget } from "../../shared/mcpContextEditing";
import type { McpOperationService, McpOperationContext } from "../application/mcpOperationService";
import { McpEditError } from "../application/mcpEditPolicy";
import { McpInvalidParams } from "./mcpArguments";
import { textContent, type McpTool } from "./mcpReadTools";

export function createMcpContextResearchTool(
  operations: McpOperationService,
  execute: (owner: string, target: McpContextResearchTarget, context: McpOperationContext) => Promise<Record<string, unknown>>,
): McpTool {
  const scopes = ["carrot.read", "carrot.process"];
  return {
    name: "carrot_run_context_research",
    description: "Run the app's configured Tavily/Gemma-or-API or Codex-web research for ONE existing work selected by chapterId. Read carrot_get_work_context for revision first and provide the explicit researchTitle and engine. Sends bounded saved work text and context to the configured research services, may use multiple searches/model requests and charge within the app's configured budgets. The existing Codex compatibility fallback can run if necessary. Saved text across the work may contain spoilers. Holds shared work-content/context leases; local model workloads remain exclusive through cleanup. Returns a job receipt, NOT completed research. Poll carrot_get_job, inspect the returned context proposal, and explicitly apply selected changes. NEVER changes glossary, characters, memories, translations or images during research. Restart/30-minute expiry requires a new proposal. No attachments.",
    inputSchema: z.toJSONSchema(McpContextResearchTargetSchema),
    requiredScopes: scopes, readOnly: false, destructive: false, idempotent: true, openWorld: true,
    invoke: async (args, context) => {
      const target = McpContextResearchTargetSchema.safeParse(args);
      if (!target.success) throw new McpInvalidParams();
      if (!context?.principalId || !context.assertScopes || !context.assertJobAuthorized)
        throw new McpEditError("access_denied", "An approved processing connection is required for research.");
      context.assertAuthorized();
      context.assertScopes(scopes);
      const owner = context.principalId;
      return textContent(await operations.start({
        owner, requestId: target.data.requestId, kind: "contextResearch", parameters: target.data,
        assertAuthorized: () => context.assertJobAuthorized?.(scopes),
        execute: (job) => execute(owner, target.data, job),
      }));
    },
  };
}
