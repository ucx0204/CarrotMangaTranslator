import { z } from "zod/v4";
import { McpWorkflowGetSchema, mcpWorkflowOutputs } from "./mcpWorkflow";

const connection = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const McpWorkflowHandoffIdentitySchema = z.object({}).strict();
export const McpWorkflowHandoffOfferSchema = McpWorkflowGetSchema.extend({
  version: z.number().int().nonnegative(),
  requestId: z.uuid(),
  targetConnectionId: connection,
}).strict();
export const McpWorkflowHandoffAcceptSchema = McpWorkflowGetSchema.extend({
  offerId: z.uuid(),
  version: z.number().int().nonnegative(),
  requestId: z.uuid(),
}).strict();
export const McpWorkflowHandoffRevokeSchema = McpWorkflowGetSchema.extend({
  offerId: z.uuid(),
}).strict();
export type McpWorkflowHandoffOffer = z.infer<
  typeof McpWorkflowHandoffOfferSchema
>;
export type McpWorkflowHandoffAccept = z.infer<
  typeof McpWorkflowHandoffAcceptSchema
>;
export const mcpWorkflowHandoffOutputs = {
  carrot_get_workflow_handoff_identity: z
    .object({
      connectionId: connection,
      grantsAccess: z.literal(false),
    })
    .strict(),
  carrot_offer_workflow_handoff: z
    .object({
      id: z.uuid(),
      offerId: z.uuid(),
      version: z.number().int().nonnegative(),
      targetConnectionId: connection,
      expiresAt: z.number().int().nonnegative(),
      historyTransferred: z.literal(false),
    })
    .strict(),
  carrot_accept_workflow_handoff: z
    .object({
      workflow: mcpWorkflowOutputs.carrot_get_workflow,
      status: z.enum(["transferred", "already_transferred"]),
      historyTransferred: z.literal(false),
    })
    .strict(),
  carrot_revoke_workflow_handoff: z
    .object({
      id: z.uuid(),
      offerId: z.uuid(),
      status: z.literal("revoked"),
      pageChanges: z.literal(0),
    })
    .strict(),
};
