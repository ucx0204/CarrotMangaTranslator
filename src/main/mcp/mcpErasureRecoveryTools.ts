import { z } from "zod/v4";
import { mcpErasureRecoveryLookup, mcpErasureRecoveryAction } from "../../shared/mcpErasureRecoverySchemas";
import type { PageRevision } from "../../shared/pageRevisionTypes";
import type { McpErasureRecoveryService } from "../application/mcpErasureRecoveryService";
import { McpEditError } from "../application/mcpEditPolicy";
import { McpInvalidParams } from "./mcpArguments";
import { textContent, type McpTool } from "./mcpReadTools";

export function createMcpErasureRecoveryTools(service: McpErasureRecoveryService): McpTool[] {
  const lookup: McpTool = {
    name: "carrot_get_erasure_recovery", readOnly: true, destructive: false, idempotent: true,
    requiredScopes: ["carrot.read"],
    description: "Inspect whether this connection's completed single-block erasure can be undone or redone. Session-local image history only; restarting MCP/app or releasing history makes it unavailable. Subsequent page edits conflict instead of being overwritten. Returns current revision and metadata only; no image, file, model call or mutation. Availability is advisory until rechecked under the page lock.",
    inputSchema: z.toJSONSchema(mcpErasureRecoveryLookup),
    invoke: async (args, context) => {
      const parsed = mcpErasureRecoveryLookup.safeParse(args);
      if (!parsed.success) throw new McpInvalidParams();
      const { owner, authorize } = access(context, ["carrot.read"]);
      return textContent(await service.inspect(parsed.data.jobId, owner, authorize));
    },
  };
  return [lookup, ...(["undo", "redo"] as const).map((direction): McpTool => ({
    name: direction === "undo" ? "carrot_undo_erasure" : "carrot_redo_erasure",
    readOnly: false, destructive: true, idempotent: true, openWorld: false,
    requiredScopes: ["carrot.read", "carrot.process"],
    description: `${direction === "undo" ? "Undo" : "Redo"} ONLY the completed selected-block erasure identified by jobId, using the existing app image history and page ownership. Requires the fresh revision from carrot_get_erasure_recovery and a new UUID requestId per action. Reuse an identical requestId only for retries; cached receipts never apply again, even after an opposite action. Receipt revision is historical: inspect again for current availability. Does not rerun OCR, erasure models, translation, lettering or export. Any subsequent content change is rejected, not merged. No file attachments.`,
    inputSchema: z.toJSONSchema(mcpErasureRecoveryAction),
    invoke: async (args, context) => {
      const parsed = mcpErasureRecoveryAction.safeParse(args);
      if (!parsed.success) throw new McpInvalidParams();
      const { owner, authorize } = access(context, ["carrot.read", "carrot.process"]);
      return textContent(await service.apply({ ...parsed.data, revision: parsed.data.revision as PageRevision, direction }, owner, authorize));
    },
  }))];
}
function access(context: Parameters<McpTool["invoke"]>[1], scopes: readonly string[]) {
  const authorize = () => {
    if (!context?.principalId || !context.assertScopes)
      throw new McpEditError("access_denied", "An approved OAuth connection and scope verification are required.");
    context.assertAuthorized();
    context.assertScopes(scopes);
  };
  authorize();
  return { owner: context?.principalId ?? "", authorize };
}
