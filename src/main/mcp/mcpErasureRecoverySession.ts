import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { McpOperationService } from "../application/mcpOperationService";
import { McpErasureRecoveryService } from "../application/mcpErasureRecoveryService";
import { createMcpPageEditScope } from "./mcpPageEditScope";
import { createMcpErasureRecoveryTools } from "./mcpErasureRecoveryTools";

/** No model or independent history store. Only native references are remembered. */
export function createMcpErasureRecoverySession(
  app: InpaintingJobContext,
  operations: McpOperationService,
  notifySaved: (chapterId: string, pageId: string) => void,
) {
  const history = app.inpaintingRevisionStore;
  const inspect = history?.inspectSinglePageTransaction?.bind(history);
  const apply = history?.applySinglePageTransaction?.bind(history);
  if (!inspect || !apply) return undefined;
  const service = new McpErasureRecoveryService({
    readJob: async (id, owner) => {
      await operations.ready();
      const job = operations.status(id, owner);
      return {
        ...job,
        target: job.target && "pageId" in job.target ? job.target : undefined,
      };
    },
    inspect,
    apply: (id, target, direction, revision, assertCanCommit) =>
      apply(id, direction, { ...target, revision, assertCanCommit }),
    withPageEdit: createMcpPageEditScope(app),
    notifySaved,
  });
  return {
    tools: createMcpErasureRecoveryTools(service),
    remember: (jobId: string, transactionId: string) =>
      service.remember(jobId, transactionId),
    stop: () => service.stop(),
    close: () => service.close(),
  };
}
