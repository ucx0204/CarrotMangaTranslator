import {
  McpResearchBatchPrepareSchema,
  McpResearchBatchGetSchema,
  McpResearchBatchRunSchema,
  McpResearchBatchResolveSchema,
  McpResearchBatchDiscardSchema,
} from "../../shared/mcpResearchBatch";
import { McpRetentionListSchema } from "../../shared/mcpRetention";
import { McpResearchBatchService } from "../application/mcpResearchBatchService";
import { McpResearchBatchRepository } from "./mcpResearchBatchRepository";
import { createMcpResearchBatchRuntime } from "./mcpResearchBatchRuntime";
import { createMcpBatchTool } from "./mcpBatchTool";
import { McpEditError } from "../application/mcpEditPolicy";
import { logError } from "../logger";
import type { McpTool } from "./mcpReadTools";

type Options = Parameters<typeof createMcpResearchBatchRuntime>[0] & {
  enabled: boolean;
  reportError?: (error: unknown) => void;
};
export function createMcpResearchBatchSession(options: Options) {
  const service = new McpResearchBatchService({
    ...createMcpResearchBatchRuntime(options),
    repository: new McpResearchBatchRepository(options.storage),
    now: options.storage.now,
    reportError:
      options.reportError ??
      ((error) => logError("MCP research batch stopped", error)),
  });
  return {
    completion: service.completion,
    tools: [
      ...readTools(service),
      ...(options.enabled ? writeTools(service) : []),
    ],
    stop: () => service.stop(),
    close: () => service.close(),
  };
}
function readTools(service: McpResearchBatchService): McpTool[] {
  return [
    createMcpBatchTool({
      name: "carrot_get_research_batch",
      schema: McpResearchBatchGetSchema,
      scopes: ["carrot.read"],
      write: false,
      description:
        "Read an owned fixed multi-work research plan, current version, per-work holds/attempts, job/proposal IDs and known usage. Metadata only. A stopped running plan is interrupted, never automatically resumed. Proposal availability is checked separately with carrot_get_context_proposal. Unknown usage is not zero cost. No model or context edit.",
      execute: (args, owner, guard) =>
        service.get(owner, McpResearchBatchGetSchema.parse(args).id, guard),
    }),
    createMcpBatchTool({
      name: "carrot_list_research_batches",
      schema: McpRetentionListSchema,
      scopes: ["carrot.read"],
      write: false,
      description:
        "List this approved connection's unexpired research plans with snapshot-bound pagination. Same data profile/owner and shared seven-day retention apply. No research, sources, private paths or automatic execution.",
      execute: (args, owner, guard) =>
        service.list(owner, McpRetentionListSchema.parse(args), guard),
    }),
  ];
}
function writeTools(service: McpResearchBatchService): McpTool[] {
  return [...researchSpecs(service), ...controlSpecs(service)].map((spec) => {
    const background = spec.name === "carrot_run_research_batch";
    const tool = createMcpBatchTool<unknown>({
      ...spec,
      scopes: ["carrot.read", "carrot.process"],
      write: true,
      background,
    });
    return {
      ...tool,
      destructive: false,
      openWorld: background,
      invoke: async (args, context) => {
        if (background && !context?.assertJobAuthorized)
          throw new McpEditError(
            "access_denied",
            "Continuing research requires a verified processing connection.",
          );
        return tool.invoke(args, context);
      },
    };
  });
}
function researchSpecs(service: McpResearchBatchService) {
  return [
    {
      name: "carrot_prepare_research_batch",
      schema: McpResearchBatchPrepareSchema,
      description:
        "Prepare 1-10 explicitly selected unique works in supplied order. Read current context revision and carrot_get_context_references snapshot for each anchor chapter first. Persist the fixed work/evidence/settings and maximum 1-30 attempts, without running models or editing context. Unconfirmed titles or disallowed whole-work spoilers are held, not guessed. New works are never automatically included. Each native research attempt retains its existing search/model/account limits.",
      execute: (args: unknown, owner: string, guard: () => void) =>
        service.prepare(
          owner,
          McpResearchBatchPrepareSchema.parse(args),
          guard,
        ),
    },
    {
      name: "carrot_run_research_batch",
      schema: McpResearchBatchRunSchema,
      description:
        "Explicitly run/resume the owned current-version research plan. allowExternal=true acknowledges saved text/context transmission and configured account costs. Local Tavily analysis also requires allowAssetDownloads=true. Runs only eligible works sequentially through existing native research jobs; no automatic application, OCR, translation, rendering or new GPU queue. Completed proposals/no-change outcomes are never re-executed. Unknown or failed attempts require retryFailed=true after reconciliation and consume the fixed attempt budget. Returns promptly; poll carrot_get_research_batch. Settings changes require restoration or a new remaining-work plan.",
      execute: (args: unknown, owner: string, guard: () => void) =>
        service.run(owner, McpResearchBatchRunSchema.parse(args), guard),
    },
    {
      name: "carrot_resolve_research_hold",
      schema: McpResearchBatchResolveSchema,
      description:
        "Resolve one unattempted held work at the plan's current version with an explicitly confirmed research title and whole-work spoiler permission. Does not change the work/engine/evidence or execute research. Unsupported spoiler-limited research must remain held. Leaves the plan paused for a separate run request.",
      execute: (args: unknown, owner: string, guard: () => void) =>
        service.resolve(
          owner,
          McpResearchBatchResolveSchema.parse(args),
          guard,
        ),
    },
  ];
}
function controlSpecs(service: McpResearchBatchService) {
  return [
    ...(["pause", "cancel"] as const).map((direction) => ({
      name: `carrot_${direction}_research_batch`,
      schema: McpResearchBatchGetSchema,
      description:
        direction === "pause"
          ? "Pause this owned research batch after its current native child settles. The current review can finish and be retained; no following work starts. No Undo. Poll until no longer running."
          : "Signal cancellation only to this owned research batch's admitted child and wait for native cleanup before admitting more work. Completed reviews and usage remain recorded. Cancellation is not Undo or deletion.",
      execute: (args: unknown, owner: string, guard: () => void) =>
        service.control(
          owner,
          McpResearchBatchGetSchema.parse(args).id,
          direction,
          guard,
        ),
    })),
    {
      name: "carrot_discard_research_batch",
      schema: McpResearchBatchDiscardSchema,
      description:
        "Explicitly discard an owned settled research plan only. Running work must first finish cancellation/cleanup. Does not delete retained proposals, context recovery, artwork, credentials or model assets. The discarded plan cannot resume.",
      execute: (args: unknown, owner: string, guard: () => void) =>
        service.discard(
          owner,
          McpResearchBatchDiscardSchema.parse(args).id,
          guard,
        ),
    },
  ];
}
