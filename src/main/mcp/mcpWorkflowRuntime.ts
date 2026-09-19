import type { AppSettings } from "../../shared/settingsTypes";
import type { McpWorkflowPrepare } from "../../shared/mcpWorkflow";
import type { McpWorkflowRecord, McpWorkflowStep, McpWorkflowOutcome } from "../application/mcpWorkflowPolicy";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { McpOperationService } from "../application/mcpOperationService";
import { McpEditError } from "../application/mcpEditPolicy";
import { getAppSettings } from "../settingsStore";
import { withExecutionSettings } from "../settings/executionSettings";
import { assertModelCleanupComplete } from "../runtimeSupport/modelCleanupBarrier";
import type { McpRetentionStorage } from "./mcpRetentionStorage";
import type { McpTool } from "./mcpReadTools";
import { McpWorkflowCalls, type McpWorkflowSelectionWait } from "./mcpWorkflowCalls";
import { prepareWorkflowPages, readWorkflowPage, verifyWorkflowPages, workflowSettingsFingerprint } from "./mcpWorkflowEvidence";
import { reconcileNativeWorkflow } from "./mcpWorkflowReconciliation";
import { translateWorkflowPage, workflowTranslationBlocks } from "./mcpWorkflowTranslation";

type Options = {
  app: InpaintingJobContext;
  operations: McpOperationService;
  storage: McpRetentionStorage;
  tools: readonly McpTool[];
  waitSelection?: McpWorkflowSelectionWait;
};
export function createMcpWorkflowRuntime(options: Options) {
  return {
    prepare: async (input: McpWorkflowPrepare, guard: () => void) => {
      const settings = await getAppSettings(options.app.appPaths);
      validateWorkflowSettings(input, settings);
      const pages = await prepareWorkflowPages(input, guard);
      guard();
      return { pages, settings: workflowSettingsFingerprint(settings) };
    },
    open: async (record: McpWorkflowRecord, guard: () => void) => {
      guard();
      const settings = await getAppSettings(options.app.appPaths);
      validateWorkflowSettings(record.input, settings);
      if (workflowSettingsFingerprint(settings) !== record.settingsFingerprint)
        throw new McpEditError("revision_conflict", "Workflow execution settings changed. Restore them or prepare a new remaining-target plan; no model fallback was started.");
      const calls = new McpWorkflowCalls(options.tools, options.operations, record.owner, guard, options.waitSelection);
      const reconcile = (current: McpWorkflowRecord, step: McpWorkflowStep) =>
        reconcileNativeWorkflow(options.storage, current, step, guard);
      return {
        verify: (current: McpWorkflowRecord, changedPage?: number) => verifyWorkflowPages(current, guard, changedPage),
        cost: async (current: McpWorkflowRecord, step: McpWorkflowStep) => {
          const stage = current.input.stages[step.stageIndex];
          if (stage.kind !== "translate") return 0;
          const { page } = await readWorkflowPage(current.pages[step.pageIndex], guard);
          return workflowTranslationBlocks(page, stage).length;
        },
        reconcile,
        execute: async (current: McpWorkflowRecord, step: McpWorkflowStep, signal: AbortSignal, onJob: (id: string) => Promise<void>) => {
          const outcome = await withExecutionSettings(settings, () => executeStage(current, step, calls, signal, onJob, guard));
          const recovered = await reconcile(current, step);
          return recovered?.outcome ?? outcome;
        },
      };
    },
  };
}
function validateWorkflowSettings(input: McpWorkflowPrepare, settings: AppSettings) {
  for (const stage of input.stages) {
    if (stage.kind !== "translate") continue;
    if (stage.expectedEngine !== settings.modelProvider)
      throw new McpEditError("revision_conflict", "Workflow translation provider differs from the configured provider.");
    if (stage.expectedEngine === "gemma" ? !stage.allowAssetDownloads : !stage.allowExternal)
      throw new McpEditError("access_denied", "Explicit permission for local assets or external text processing is required.");
  }
}
async function executeStage(record: McpWorkflowRecord, step: McpWorkflowStep, calls: McpWorkflowCalls, signal: AbortSignal, onJob: (id: string) => Promise<void>, guard: () => void): Promise<McpWorkflowOutcome> {
  guard();
  if (step.stage !== "export-png") assertModelCleanupComplete();
  if (step.stage === "translate") return translateWorkflowPage(record, step, calls, signal, onJob, guard);
  const target = record.pages[step.pageIndex];
  const { page } = await readWorkflowPage(target, guard);
  if ((step.stage === "ocr" && page.blocks.length > 0) ||
      (step.stage === "erase" && !page.blocks.some((block) => !block.inpaintExcluded && !block.generatedLettering)))
    return { revision: target.revision };
  const names = { ocr: "carrot_run_page_ocr", erase: "carrot_run_page_erasure", "export-png": "carrot_export_page_png" };
  if (step.stage === "await-external" || !step.attemptId) throw new Error("External steps cannot invoke native engines.");
  const result = await calls.job(names[step.stage], {
    chapterId: target.chapterId, pageId: target.pageId, revision: target.revision, requestId: step.attemptId,
  }, signal, onJob);
  if (typeof result.revision !== "string") throw new Error("Native workflow result has no exact revision.");
  return { revision: result.revision, ...(result.retainedOutputId ? { outputId: result.retainedOutputId } : {}) };
}
