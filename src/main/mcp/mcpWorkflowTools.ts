import { z } from "zod/v4";
import {
  McpWorkflowPrepareSchema, McpWorkflowGetSchema, McpWorkflowRunSchema,
  McpWorkflowExternalSchema, McpWorkflowListSchema, McpWorkflowDiscardSchema,
} from "../../shared/mcpWorkflow";
import type { McpWorkflowService } from "../application/mcpWorkflowService";
import type { McpWorkflowRecord } from "../application/mcpWorkflowPolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import { createMcpBatchTool } from "./mcpBatchTool";
import { McpInvalidParams } from "./mcpArguments";
import { textContent, type McpTool } from "./mcpReadTools";

const readScopes = ["carrot.read"];
const editScopes = ["carrot.read", "carrot.edit", "carrot.process"];
export function createMcpWorkflowTools(service: McpWorkflowService, enabled: boolean) {
  const tools = [
    createMcpBatchTool({
      name: "carrot_get_workflow", schema: McpWorkflowGetSchema, scopes: readScopes, write: false,
      description: "Inspect an owned persistent fixed-target workflow, page/stage outcomes, native job/change/output IDs, pause/cancel state and exact version. Metadata only, no images or raw page content. Restart never runs it automatically. Completed steps are not repeated; unknown interrupted attempts require reconciliation or explicit retry. Saved context is read, not regenerated.",
      execute: (args, owner, guard) => service.get(owner, McpWorkflowGetSchema.parse(args).id, guard),
    }),
    createMcpBatchTool({
      name: "carrot_list_workflows", schema: McpWorkflowListSchema, scopes: readScopes, write: false,
      description: "List this connection's unexpired workflow plans in the existing seven-day encrypted retention catalog. Paginate with the returned snapshot. No execution, handoff to another OAuth identity, page changes or file links.",
      execute: (args, owner, guard) => service.list(owner, McpWorkflowListSchema.parse(args), guard),
    }),
  ];
  if (!enabled) return tools;
  tools.push(createMcpBatchTool({
    name: "carrot_prepare_workflow", schema: McpWorkflowPrepareSchema, scopes: editScopes, write: true,
    description: "Persist an explicit ordered workflow for 1-10 chapters and at most 50 saved page IDs/current revisions. Stages are only OCR-empty-pages, selected saved-source translation, native page erasure, PNG export or external-result waiting, in the supplied order; no implicit stage is inserted. Each stage processes the fixed pages sequentially in saved chapter order. Existing OCR blocks and, by default, nonempty translations are preserved. Native local operations require explicit asset permission; external text requests require allowExternal. No model, page edit or rendering occurs during preparation. Models currently use each native child operation's own load/release cycle. maxPageAttempts and maxTranslationRequests bound explicit retries. Settings changes on resume require a new plan or restoring settings. Poll/read, then explicitly run.",
    execute: (args, owner, guard) => service.prepare(owner, McpWorkflowPrepareSchema.parse(args), guard),
  }));
  for (const name of ["carrot_run_workflow", "carrot_resume_workflow"])
    tools.push(runTool(name, service));
  for (const direction of ["pause", "cancel"] as const)
    tools.push(createMcpBatchTool({
      name: `carrot_${direction}_workflow`, schema: McpWorkflowGetSchema, scopes: ["carrot.read", "carrot.process"], write: true,
      description: direction === "pause"
        ? "Pause an owned workflow at the next settled native-operation boundary. Current work may finish and save; no new step then starts. Poll until no longer running. Does not undo anything."
        : "Cancel an owned workflow and signal only its current admitted native operation. It stays running until native cleanup settles. Saved pages remain saved; inspect durable changes for explicit undo. Never cancels another connection's work.",
      execute: (args, owner, guard) => service.control(owner, McpWorkflowGetSchema.parse(args).id, direction, guard),
    }));
  tools.push(createMcpBatchTool({
    name: "carrot_accept_workflow_external", schema: McpWorkflowExternalSchema, scopes: editScopes, write: true,
    description: "Acknowledge that the currently waiting external page was saved with the existing editing/upload tools. Requires its exact CURRENT page/review revisions and workflow version. Does not accept raw text/images or write the page. Original identity, chapter order, context and other fixed pages must match. Acceptance marks only that step complete and leaves the workflow paused for explicit resume. A filename or claimed AI result is not evidence of a saved page.",
    execute: (args, owner, guard) => service.acceptExternal(owner, McpWorkflowExternalSchema.parse(args), guard),
  }), createMcpBatchTool({
    name: "carrot_discard_workflow", schema: McpWorkflowDiscardSchema, scopes: editScopes, write: true,
    description: "Discard one owned settled workflow plan with confirm=true. Does not delete page data, native change history or retained output. Running work must first settle after cancellation. A discarded plan cannot resume.",
    execute: (args, owner, guard) => service.discard(owner, McpWorkflowDiscardSchema.parse(args).id, guard),
  }));
  return tools;
}
function runTool(name: string, service: McpWorkflowService): McpTool {
  return {
    name, oauth: true, requiredScopes: editScopes, readOnly: false, destructive: true, idempotent: true, openWorld: true,
    inputSchema: z.toJSONSchema(McpWorkflowRunSchema),
    description: "Explicitly run/resume an owned prepared workflow at its current version. Rechecks settings, source/page/context evidence and live approval before native execution. PNG plans additionally require carrot.images. Same requestId never starts another run. Completed steps stay complete; retryFailed=true explicitly permits another attempt only when the saved pre-state still matches and no completed native receipt can be reconciled. Retries consume the retained budgets. No local model parallelism, automatic fallback, automatic cross-connection takeover, implicit undo or automatic restart resume. Returns immediately; poll carrot_get_workflow and its native job IDs.",
    invoke: async (args, context) => {
      const parsed = McpWorkflowRunSchema.safeParse(args);
      if (!parsed.success) throw new McpInvalidParams();
      if (!context?.principalId) throw new McpEditError("access_denied", "An approved connection is required.");
      const authorize = (record: McpWorkflowRecord) => {
        const scopes = [...editScopes, ...(record.input.stages.some((stage) => stage.kind === "export-png") ? ["carrot.images"] : [])];
        if (context.assertJobAuthorized) context.assertJobAuthorized(scopes);
        else {
          context.assertAuthorized();
          if (!context.assertScopes) throw new McpEditError("access_denied", "Scope verification is required.");
          context.assertScopes(scopes);
        }
      };
      return textContent(await service.run(context.principalId, parsed.data, authorize));
    },
  };
}
