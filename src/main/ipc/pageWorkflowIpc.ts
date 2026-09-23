import { pageWorkflowIpcContracts } from "../../shared/ipcPageWorkflowContracts";
import { preflightPageWorkflow } from "../../shared/pageWorkflowPolicy";
import {
  freezeWorkflowRules,
  workflowRuleEffects,
} from "../../shared/pageWorkflowRules";
import { openChapter } from "../library";
import { getAppSettings } from "../settingsStore";
import { ConditionalBatchSchemeStore } from "../conditionalBatchSchemeStore";
import { readPageWorkflowRun } from "../pageWorkflowRunStore";
import { startPageWorkflowJob } from "../jobs/pageWorkflowJob";
import { trustedHandleContract } from "./trustedIpc";
import type { IpcContext } from "./context";

export function registerPageWorkflowIpc(context: IpcContext): void {
  trustedHandleContract(
    context,
    pageWorkflowIpcContracts.preflightPageWorkflow,
    async (_event, request) => {
      const previous = request.resumeRunId
        ? await readPageWorkflowRun(
            context.appPaths.dataRoot,
            request.resumeRunId,
          )
        : null;
      const resolved = previous?.request ?? request;
      const chapters = await Promise.all(
        resolved.selection.map((s) => openChapter(s.chapterId)),
      );
      const result = preflightPageWorkflow(resolved, chapters);
      try {
        const rules =
          previous?.rules ??
          freezeWorkflowRules(
            resolved.plan,
            await new ConditionalBatchSchemeStore(
              context.appPaths.dataRoot,
            ).list(),
          );
        result.ruleEffects = workflowRuleEffects(rules);
      } catch (error) {
        result.issues.push({
          chapterId: "",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return result;
    },
  );
  trustedHandleContract(
    context,
    pageWorkflowIpcContracts.startPageWorkflow,
    async (_event, request) =>
      startPageWorkflowJob(
        context,
        request,
        await getAppSettings(context.appPaths),
      ),
  );
  trustedHandleContract(
    context,
    pageWorkflowIpcContracts.getPageWorkflowRun,
    async (_event, runId) => ({
      ...(await readPageWorkflowRun(context.appPaths.dataRoot, runId)).request,
      resumeRunId: runId,
    }),
  );
}
