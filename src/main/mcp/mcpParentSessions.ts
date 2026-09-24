import type {
  PageSessionOptions,
  McpPageSessionResources,
} from "./mcpPageSessionTypes";
import type { createMcpAuxiliarySessions } from "./mcpAuxiliarySessions";
import type { McpTool } from "./mcpReadTools";
import type { McpParentAdmission } from "./mcpParentAdmission";
import { getAppSettings } from "../settingsStore";
import { createMcpWorkflowSession } from "./mcpWorkflowSession";
import { createMcpCompositeSession } from "./mcpCompositeSession";

/** Both parent families share admission; only their exact typed workflow child can enter the active composite. */
export function createMcpParentSessions(
  options: PageSessionOptions,
  resources: McpPageSessionResources,
  nativeTools: readonly McpTool[],
  auxiliary: ReturnType<typeof createMcpAuxiliarySessions>,
  admission: McpParentAdmission,
) {
  const { storage, operations, retained, compositeRepository } = resources;
  if (!storage || !compositeRepository) return undefined;
  const workflow = createMcpWorkflowSession({
    app: options.app,
    operations,
    storage,
    preferences: options.preferences,
    tools: nativeTools.map((tool) => retained?.wrap(tool) ?? tool),
    waitSelection: auxiliary.waitSelection,
    releaseSelection: auxiliary.releaseSelection,
    reportError: options.reportError,
    acquireRun: (owner, input) => admission.acquireWorkflow(owner, input),
  });
  const { imageReviewMapping, workFileReviewMapping, ...completion } =
    auxiliary.composite;
  if (!imageReviewMapping || !workFileReviewMapping)
    throw new Error(
      "Composite native import review must reuse the session's owned import authorities.",
    );
  const composite = createMcpCompositeSession({
    ...completion,
    operations,
    workflow: workflow.completion,
    settings: () => getAppSettings(options.app.appPaths),
    preferences: options.preferences,
    imageReviewMapping,
    workFileReviewMapping,
    repository: compositeRepository,
    admission,
    reportError: options.reportError,
  });
  return {
    tools: [...workflow.tools, ...composite.tools],
    bindNativeTools: composite.bindNativeTools,
    stop: () => {
      composite.stop();
      workflow.stop();
    },
    close: async () => {
      composite.stop();
      workflow.stop();
      const errors: unknown[] = [];
      try {
        await composite.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        await workflow.close();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length)
        throw new AggregateError(errors, "Native parent cleanup failed.", {
          cause: errors[0],
        });
    },
  };
}
