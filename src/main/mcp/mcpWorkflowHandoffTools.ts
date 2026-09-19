import { z } from "zod/v4";
import {
  McpWorkflowHandoffIdentitySchema,
  McpWorkflowHandoffOfferSchema,
  McpWorkflowHandoffAcceptSchema,
  McpWorkflowHandoffRevokeSchema,
} from "../../shared/mcpWorkflowHandoff";
import type { McpWorkflowHandoffService } from "../application/mcpWorkflowHandoffService";
import { McpEditError } from "../application/mcpEditPolicy";
import { McpInvalidParams } from "./mcpArguments";
import { createMcpBatchTool } from "./mcpBatchTool";
import { authorizeMcpWorkflow } from "./mcpWorkflowAuthorization";
import { textContent, type McpTool } from "./mcpReadTools";

const scopes = ["carrot.read", "carrot.edit", "carrot.process"];
export function createMcpWorkflowHandoffTools(
  service: McpWorkflowHandoffService,
  enabled: boolean,
): McpTool[] {
  if (!enabled) return [];
  return [
    createMcpBatchTool({
      name: "carrot_get_workflow_handoff_identity",
      schema: McpWorkflowHandoffIdentitySchema,
      scopes,
      write: false,
      description:
        "Return ONLY this already approved connection's workflow-handoff identity. It is an address, not a token, permission grant or list of other connections. The same connection can resume from a new conversation without handoff.",
      execute: async (_args, owner, guard) => {
        guard();
        return { connectionId: owner, grantsAccess: false as const };
      },
    }),
    createMcpBatchTool({
      name: "carrot_offer_workflow_handoff",
      schema: McpWorkflowHandoffOfferSchema,
      scopes,
      write: true,
      background: true,
      description:
        "Offer ONE owned settled workflow at its exact current version to an explicitly named already-approved receiving connection. Receiver must separately accept. No page changes or execution occur. Offer expires in ten minutes, on MCP restart, or if either approval is revoked. Uncertain/failed attempts must be reconciled first. Previous native job records, undo history and output files are NOT transferred.",
      execute: (args, owner, guard) =>
        service.offer(owner, McpWorkflowHandoffOfferSchema.parse(args), guard),
    }),
    acceptTool(service),
    createMcpBatchTool({
      name: "carrot_revoke_workflow_handoff",
      schema: McpWorkflowHandoffRevokeSchema,
      scopes,
      write: true,
      description:
        "The current offering connection can revoke its own pending workflow handoff. This does not revoke OAuth approvals, change pages, cancel a workflow or take back an already completed transfer.",
      execute: async (args, owner, guard) =>
        service.revoke(
          owner,
          McpWorkflowHandoffRevokeSchema.parse(args),
          guard,
        ),
    }),
  ];
}

function acceptTool(service: McpWorkflowHandoffService): McpTool {
  return {
    name: "carrot_accept_workflow_handoff",
    oauth: true,
    requiredScopes: scopes,
    readOnly: false,
    destructive: true,
    idempotent: true,
    inputSchema: z.toJSONSchema(McpWorkflowHandoffAcceptSchema),
    description:
      "The addressed receiving connection explicitly accepts one live handoff offer. Rechecks both approvals, exact workflow version, source/page/context evidence and receiver permissions for all stages. Atomically transfers the settled plan only. Completed steps remain complete; old native job/change/output IDs are cleared because those remain owned by the original connection. Does not run work. Use an explicit resume afterward. Exact accepted request replay survives restart.",
    invoke: async (args, context) => {
      if (!context?.principalId)
        throw new McpEditError(
          "access_denied",
          "An approved receiving connection is required.",
        );
      const parsed = McpWorkflowHandoffAcceptSchema.safeParse(args);
      if (!parsed.success) throw new McpInvalidParams();
      const guard = () => {
        context.assertAuthorized();
        context.assertScopes?.(scopes);
      };
      guard();
      return textContent(
        await service.accept(
          context.principalId,
          parsed.data,
          (record) => authorizeMcpWorkflow(context, record),
          guard,
        ),
      );
    },
  };
}
