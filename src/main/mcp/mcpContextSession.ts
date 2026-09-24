import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { McpPreferences } from "../../shared/mcpDesktopTypes";
import type { McpOperationService } from "../application/mcpOperationService";
import {
  McpContextProposalService,
  type McpContextResearchRetention,
} from "../application/mcpContextProposalService";
import { readWorkContextForEdit, commitWorkContextEdit } from "../library";
import { withMcpContextEditScope } from "./mcpContextEditScope";
import { createMcpContextEditingTools } from "./mcpContextTools";
import { createMcpContextResearchExecutor } from "./mcpContextResearchAdapter";
import { createMcpContextResearchTool } from "./mcpContextResearchTool";
import { createMcpResearchBatchSession } from "./mcpResearchBatchSession";
import type { McpRetentionStorage } from "./mcpRetentionStorage";
import { McpResearchProposalRepository } from "./mcpResearchProposalRepository";
import { McpResearchProposalApplication } from "./mcpResearchProposalApplication";
import { McpRetentionCatalog } from "./mcpRetentionCatalog";
import { McpRetentionListSchema } from "../../shared/mcpRetention";
import { createMcpBatchTool } from "./mcpBatchTool";

type Retention = {
  storage: McpRetentionStorage;
  editing: ConstructorParameters<typeof McpResearchProposalApplication>[2];
};

export function createMcpContextSession(
  app: InpaintingJobContext,
  operations: McpOperationService,
  preferences: McpPreferences,
  retention?: Retention,
) {
  const lifetime = new AbortController();
  const research = retention
    ? retainedResearch(app, retention, lifetime.signal)
    : undefined;
  const proposals = new McpContextProposalService({
    read: readWorkContextForEdit,
    commit: commitWorkContextEdit,
    withEdit: withMcpContextEditScope,
    retained: research?.port,
  });
  const execute = createMcpContextResearchExecutor(app, proposals);
  const batches = retention
    ? createMcpResearchBatchSession({
        app,
        operations,
        storage: retention.storage,
        execute,
        lifetime: lifetime.signal,
        enabled: Boolean(preferences.allowProcessing),
      })
    : undefined;
  const stop = () => {
    batches?.stop();
    lifetime.abort();
    proposals.stop();
  };
  return {
    researchCompletion: batches?.completion,
    tools: [
      ...(batches?.tools ?? []),
      ...(research ? [research.list] : []),
      ...createMcpContextEditingTools(proposals, preferences.allowEditing),
      ...(preferences.allowProcessing
        ? [createMcpContextResearchTool(operations, execute)]
        : []),
    ],
    stop,
    close: async () => {
      stop();
      await batches?.close();
      await proposals.close();
    },
  };
}

/** Native injection only. No public input accepts stored records or page snapshots. */
function retainedResearch(
  app: InpaintingJobContext,
  retention: Retention,
  lifetime: AbortSignal,
) {
  const repository = new McpResearchProposalRepository(
    retention.storage,
    lifetime,
  );
  const application = new McpResearchProposalApplication(
    repository,
    app,
    retention.editing,
    lifetime,
  );
  const catalog = new McpRetentionCatalog(retention.storage, lifetime, false);
  const port: McpContextResearchRetention = {
    prepare: (owner, input, guard) => repository.prepare(owner, input, guard),
    inspect: (owner, input, guard) => repository.inspect(owner, input, guard),
    apply: (owner, input, guard) => application.apply(owner, input, guard),
  };
  const list = createMcpBatchTool({
    name: "carrot_list_context_proposals",
    schema: McpRetentionListSchema,
    scopes: ["carrot.read"],
    write: false,
    description:
      "List this approved connection's retained research proposal IDs after reconnection or restart. Metadata only; no models, context changes or file transfer. Use snapshot for pagination and carrot_get_context_proposal for exact before/after changes and sources. Seven-day retention shares the existing capacity and storage budget. Availability and current work state are checked again on read/apply. Manual session-only edit previews are not listed. Discard a retained review explicitly with carrot_discard_retained.",
    execute: (args, owner, guard) =>
      catalog.list(
        owner,
        "research-proposal",
        McpRetentionListSchema.parse(args),
        guard,
      ),
  });
  return { port, list };
}
