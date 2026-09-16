import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { McpOperationService } from "../application/mcpOperationService";
import { McpErasureRecoveryService } from "../application/mcpErasureRecoveryService";
import { createMcpPageEditScope } from "./mcpPageEditScope";
import { createMcpErasureRecoveryTools } from "./mcpErasureRecoveryTools";
import type { eraseMcpPage } from "./mcpErasureAdapter";

/** No engine, alternate history store, artifact URL or authentication override. */
export function createMcpErasureRecoverySession(
  app: InpaintingJobContext,
  operations: McpOperationService,
  notifySaved: (chapterId: string, pageId: string) => void,
) {
  const history = app.inpaintingRevisionStore;
  if (!history) return undefined;
  const service = new McpErasureRecoveryService({
    readJob: async (id, owner) => {
      await operations.ready();
      return operations.status(id, owner);
    },
    inspect: (id, target) => history.inspectSinglePageTransaction(id, target),
    apply: (id, target, direction, revision, assertCanCommit) =>
      history.applySinglePageTransaction(id, direction, { ...target, revision, assertCanCommit }),
    withPageEdit: createMcpPageEditScope(app),
    notifySaved,
  });
  return {
    tools: createMcpErasureRecoveryTools(service),
    remember: (jobId: string, result: Awaited<ReturnType<typeof eraseMcpPage>>) => {
      if ("historyTransaction" in result && result.historyTransaction)
        service.remember(jobId, result.historyTransaction.transactionId);
    },
    stop: () => service.stop(),
    close: () => service.close(),
  };
}
