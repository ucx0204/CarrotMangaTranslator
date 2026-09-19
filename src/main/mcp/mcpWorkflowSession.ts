import type { McpPreferences } from "../../shared/mcpDesktopTypes";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { McpOperationService } from "../application/mcpOperationService";
import { McpWorkflowService } from "../application/mcpWorkflowService";
import type { McpRetentionStorage } from "./mcpRetentionStorage";
import type { McpTool } from "./mcpReadTools";
import type { McpWorkflowSelectionWait } from "./mcpWorkflowCalls";
import { McpWorkflowRepository } from "./mcpWorkflowRepository";
import { createMcpWorkflowRuntime } from "./mcpWorkflowRuntime";
import { createMcpWorkflowTools } from "./mcpWorkflowTools";

export function createMcpWorkflowSession(options: {
  app: InpaintingJobContext;
  operations: McpOperationService;
  storage: McpRetentionStorage;
  tools: readonly McpTool[];
  preferences: McpPreferences;
  waitSelection?: McpWorkflowSelectionWait;
  reportError: (error: unknown) => void;
}) {
  const runtime = createMcpWorkflowRuntime(options);
  const service = new McpWorkflowService({
    ...runtime,
    repository: new McpWorkflowRepository(options.storage),
    reportError: options.reportError,
    now: options.storage.now,
  });
  return {
    tools: createMcpWorkflowTools(service, Boolean(options.preferences.allowEditing && options.preferences.allowProcessing)),
    stop: () => service.stop(),
    close: () => service.close(),
  };
}
