import {
  McpCompositePrepareSchema,
  McpCompositeBindSchema,
  McpCompositeMutationSchema,
} from "../../shared/mcpCompositeWorkflow";
import { McpCompositeReviewReportSchema } from "../../shared/mcpCompositeWorkflowReview";
import { McpCompositeDiscardSchema } from "../../shared/mcpCompositeWorkflowOutputs";
import { compositeWorkflowView } from "../application/mcpCompositeWorkflowProjection";
import { createMcpBatchTool } from "./mcpBatchTool";
import type { McpTool } from "./mcpReadTools";
import type { McpCompositeToolPort } from "./mcpCompositeToolPorts";
import { createMcpCompositeReadTools } from "./mcpCompositeReadTools";
import { authorizeMcpComposite } from "./mcpCompositeAuthorization";

const scopes = ["carrot.read"];

/** Public names select a closed controller operation; native family scopes remain authoritative. */
export function createMcpCompositeTools(
  options: McpCompositeToolPort,
): McpTool[] {
  const { service } = options;
  return [
    ...createMcpCompositeReadTools(options),
    ...preparationTools(service),
    ...executionTools(service),
    ...controlTools(service),
    ...reviewTools(service),
    discardTool(options),
  ];
}

function preparationTools(service: McpCompositeToolPort["service"]): McpTool[] {
  return [
    createMcpBatchTool({
      name: "carrot_prepare_composite",
      schema: McpCompositePrepareSchema,
      scopes,
      write: true,
      description:
        "Persist a same-owner, ordered composite with at most 32 declared native/review phases, 10 chapters and 50 pages. Preparation checks every declared family's required scopes and fixed settings/provider policy but starts no model, import, render or edit. Exact saved targets or the reviewed import mapping bound the plan. Native admissions, per-page edits, model attempts and 1-3 review passes have finite explicit budgets; unknown usage is never refunded. No automatic execution, cross-owner handoff or grant-based target expansion.",
      execute: async (args, owner, guard, authorize) =>
        compositeWorkflowView(
          await service.prepare(
            owner,
            McpCompositePrepareSchema.parse(args),
            authorizeMcpComposite(guard, authorize),
          ),
        ),
    }),
    createMcpBatchTool({
      name: "carrot_bind_composite",
      schema: McpCompositeBindSchema,
      scopes,
      write: true,
      description:
        "Bind only the next unadmitted phase to its concrete existing native action, current parent snapshot/version and exact predecessor receipts. This does not execute the action. Inputs remain session-only; restart requires explicit rebind before admission. The fixed family, page/block envelope, provider policy and remaining budgets cannot expand. Admitted attempts require exact reconciliation and cannot be rebound or automatically retried.",
      execute: async (args, owner, guard, authorize) =>
        compositeWorkflowView(
          await service.bind(
            owner,
            McpCompositeBindSchema.parse(args),
            authorizeMcpComposite(guard, authorize),
          ),
        ),
    }),
  ];
}

function executionTools(service: McpCompositeToolPort["service"]): McpTool[] {
  const tools: McpTool[] = [];
  for (const name of ["carrot_run_composite", "carrot_resume_composite"])
    tools.push({
      ...createMcpBatchTool({
        name,
        schema: McpCompositeMutationSchema,
        scopes,
        write: true,
        background: true,
        description:
          "Explicitly admit only the next bound native phase, or issue actual saved-render evidence for the next review phase. Returns parent metadata while native work settles; poll get_composite. Exact version/request replay never starts another child. Native budgets and attempt identity are saved before admission. Existing native queues, scopes, approvals, cleanup, partial outcomes and recovery remain authoritative. Unbound phases and host-review boundaries require explicit follow-up. No automatic retries, model fallback or restart execution.",
        execute: async (args, owner, guard, authorize) =>
          compositeWorkflowView(
            await service.run(
              owner,
              McpCompositeMutationSchema.parse(args),
              authorizeMcpComposite(guard, authorize),
            ),
          ),
      }),
      openWorld: true,
    });
  return tools;
}

function controlTools(service: McpCompositeToolPort["service"]): McpTool[] {
  const tools: McpTool[] = [];
  for (const direction of ["pause", "cancel"] as const)
    tools.push(
      createMcpBatchTool({
        name: `carrot_${direction}_composite`,
        schema: McpCompositeMutationSchema,
        scopes,
        write: true,
        background: true,
        description:
          direction === "pause"
            ? "Pause this owned composite at the admitted phase boundary. Current native work can finish and save; inspect its child receipt. No rollback or new phase starts."
            : "Cancel only this composite's admitted child and wait for its native cleanup. Earlier native saves remain saved, including partial results. A parent checkpoint error cannot skip cleanup. Cancellation is not Undo and does not cancel another parent.",
        execute: async (args, owner, guard, authorize) =>
          compositeWorkflowView(
            await service.control(
              owner,
              McpCompositeMutationSchema.parse(args),
              direction,
              authorizeMcpComposite(guard, authorize),
            ),
          ),
      }),
    );
  return tools;
}

function reviewTools(service: McpCompositeToolPort["service"]): McpTool[] {
  return [
    createMcpBatchTool({
      name: "carrot_reconcile_composite",
      schema: McpCompositeMutationSchema,
      scopes,
      write: true,
      description:
        "Inspect only the exact owned native family/request/receipt after an interrupted or uncertain admitted phase. No job, model, import or rendering is started. Proven native completion is checkpointed after current-source checks; absent, ambiguous, partial or expired evidence remains held. Never substitutes a newer job or treats changed page metadata as proof of success.",
      execute: async (args, owner, guard, authorize) =>
        compositeWorkflowView(
          await service.reconcile(
            owner,
            McpCompositeMutationSchema.parse(args),
            authorizeMcpComposite(guard, authorize),
          ),
        ),
    }),
    createMcpBatchTool({
      name: "carrot_submit_composite_review",
      schema: McpCompositeReviewReportSchema,
      scopes,
      write: true,
      description:
        "Submit a bounded connected-AI, host-reported judgment only after retrieving the issued actual render images for every assessed page. Native source, permissions, exact evidence IDs/pass and current revisions are checked again. This records the host's assessment, not a native quality guarantee, and does not set page reviewStatus. Corrections must be explicitly bound native actions followed by a fresh declared render pass. Findings overflow, exhausted passes, no progress and oscillation remain unresolved stops.",
      execute: async (args, owner, guard, authorize) =>
        compositeWorkflowView(
          await service.report(
            owner,
            McpCompositeReviewReportSchema.parse(args),
            authorizeMcpComposite(guard, authorize),
          ),
        ),
    }),
  ];
}

function discardTool(options: McpCompositeToolPort): McpTool {
  return createMcpBatchTool({
    name: "carrot_discard_composite",
    schema: McpCompositeDiscardSchema,
    scopes,
    write: true,
    description:
      "Discard only one owned settled composite with confirm=true. Its admitted child and physical cleanup must settle first. Does not delete imported pages, native changes, review images' sources or retained output, and never performs Undo. The discarded parent cannot resume.",
    execute: (args, owner, guard) =>
      options.discard(owner, McpCompositeDiscardSchema.parse(args).id, guard),
  });
}
