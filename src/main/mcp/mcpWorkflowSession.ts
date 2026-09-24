import { readWorkContextEditSnapshotUnlocked } from "../library/libraryContextEditingFacade";
import type { McpPreferences } from "../../shared/mcpDesktopTypes";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { McpOperationService } from "../application/mcpOperationService";
import { McpWorkflowService } from "../application/mcpWorkflowService";
import { McpWorkflowHandoffService } from "../application/mcpWorkflowHandoffService";
import type { McpWorkflowRecord } from "../application/mcpWorkflowPolicy";
import type { McpRetentionStorage } from "./mcpRetentionStorage";
import type { McpTool } from "./mcpReadTools";
import type {
  McpWorkflowSelectionWait,
  McpWorkflowSelectionRelease,
} from "./mcpWorkflowCalls";
import { McpWorkflowRepository } from "./mcpWorkflowRepository";
import { createMcpWorkflowRuntime } from "./mcpWorkflowRuntime";
import { createMcpWorkflowTools } from "./mcpWorkflowTools";
import { createMcpWorkflowHandoffTools } from "./mcpWorkflowHandoffTools";
import type { McpWorkflowRun } from "../../shared/mcpWorkflow";

export function createMcpWorkflowSession(options: {
  app: InpaintingJobContext;
  operations: McpOperationService;
  storage: McpRetentionStorage;
  tools: readonly McpTool[];
  preferences: McpPreferences;
  waitSelection?: McpWorkflowSelectionWait;
  releaseSelection?: McpWorkflowSelectionRelease;
  reportError: (error: unknown) => void;
  acquireRun?: (
    owner: string,
    input: McpWorkflowRun,
  ) => { release: () => void };
}) {
  const runtime = createMcpWorkflowRuntime(options);
  const repository = new McpWorkflowRepository(options.storage);
  const service = new McpWorkflowService({
    ...runtime,
    repository,
    reportError: options.reportError,
    now: options.storage.now,
    acquireRun: options.acquireRun,
  });
  const verify = async (
    record: McpWorkflowRecord,
    guard: () => void,
    readContext?: typeof readWorkContextEditSnapshotUnlocked,
  ) => {
    guard();
    const opened = await runtime.open(record, guard, readContext);
    await opened.verify(record);
    guard();
  };
  const handoff = new McpWorkflowHandoffService({
    now: options.storage.now,
    load: (owner, id) => repository.load(owner, id),
    exclusive: (run) => service.settled(run),
    verify,
    transfer: (record, recipient, input, guard) =>
      repository.transfer(record, recipient, input, guard, () =>
        verify(record, guard, readWorkContextEditSnapshotUnlocked),
      ),
  });
  const enabled = Boolean(
    options.preferences.allowEditing && options.preferences.allowProcessing,
  );
  const stop = () => {
    handoff.stop();
    service.stop();
  };
  return {
    completion: service.completion,
    tools: [
      ...createMcpWorkflowTools(service, enabled),
      ...createMcpWorkflowHandoffTools(handoff, enabled),
    ],
    stop,
    close: async () => {
      stop();
      await service.close();
    },
  };
}
