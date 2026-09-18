import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { McpOperationContext } from "../application/mcpOperationService";
import {
  McpSelectionAnalysisService,
  validateMcpSelection,
} from "../application/mcpSelectionAnalysisService";
import type { McpSelectionInput } from "../../shared/mcpSelectionAnalysis";
import { readWorkContextForEdit, getRunPaths, openChapter } from "../library";
import { getAppSettings } from "../settingsStore";
import { withExecutionSettings } from "../settings/executionSettings";
import { buildBaseOptions } from "../pipeline/options";
import { reserveJobChapter, acquireJobPage } from "../jobs/jobPageOwnership";
import { McpEditError } from "../application/mcpEditPolicy";
import { runMcpAppJob } from "./mcpAppJob";
import {
  captureMcpSelectionEvidence,
  verifyMcpSelectionEvidence,
} from "./mcpSelectionEvidence";
import { analyzeMcpSelectionOcr } from "./mcpSelectionOcr";
import { analyzeMcpSelectionTranslation } from "./mcpSelectionTranslation";

type Runtime = {
  ocr?: Parameters<typeof analyzeMcpSelectionOcr>[4];
  translation?: Parameters<typeof analyzeMcpSelectionTranslation>[4];
};
export function createMcpSelectionAnalysisAdapter(
  app: InpaintingJobContext,
  runtime: Runtime = {},
) {
  const analyses = createAnalysisService(app, runtime);
  return {
    analyses,
    run: async (
      owner: string,
      input: McpSelectionInput,
      operation: McpOperationContext,
    ) => {
      operation.assertAuthorized();
      const settings = await getAppSettings(app.appPaths);
      assertPermissions(input, settings.modelProvider);
      operation.assertAuthorized();
      return withExecutionSettings(settings, () =>
        runMcpAppJob(
          app,
          operation,
          "gemma-analysis",
          async (context) => {
            const saved = await readWorkContextForEdit(input.chapterId);
            validateMcpSelection(saved, input);
            context.assertAuthorized();
            reserveJobChapter(
              app.jobs,
              context.id,
              saved.chapter,
              input.pages.map((page) => page.pageId),
            );
            for (const page of input.pages) {
              await acquireJobPage(
                app.jobs,
                context.id,
                input.chapterId,
                page.pageId,
                openChapter,
              );
              context.assertAuthorized();
            }
            return withExecutionSettings(settings, () =>
              analyses.run(owner, input, context),
            );
          },
          {
            resources:
              !("expectedEngine" in input) || settings.modelProvider === "gemma"
                ? [{ kind: "model-runtime", scope: "*", access: "write" }]
                : [],
          },
        ),
      );
    },
  };
}
function assertPermissions(input: McpSelectionInput, provider: string) {
  if (!("expectedEngine" in input)) {
    if (!input.allowAssetDownloads)
      throw new McpEditError(
        "access_denied",
        "Selected native OCR requires explicit app-managed asset permission. Installed-only preparation is not exposed.",
      );
  } else {
    if (provider !== input.expectedEngine)
      throw new McpEditError(
        "revision_conflict",
        "Configured translation provider changed. No alternate engine was started.",
      );
    if (
      provider === "gemma" ? !input.allowAssetDownloads : !input.allowExternal
    )
      throw new McpEditError(
        "access_denied",
        "This selection lacks permission for its configured local assets or external text processing.",
      );
  }
}

function createAnalysisService(app: InpaintingJobContext, runtime: Runtime) {
  const analyses = new McpSelectionAnalysisService({
    read: readWorkContextForEdit,
    verify: verifyMcpSelectionEvidence,
    analyze: async (saved, input, operation) => {
      const binding = await captureMcpSelectionEvidence(
        saved,
        input,
        operation.assertAuthorized,
      );
      const settings = await getAppSettings(app.appPaths);
      operation.assertAuthorized();
      const paths = await getRunPaths(input.chapterId, operation.id);
      const base = buildBaseOptions(
        operation.id,
        paths.runDir,
        settings,
        app.appPaths,
      );
      const items =
        "expectedEngine" in input
          ? await analyzeMcpSelectionTranslation(
              saved,
              input,
              base,
              operation,
              runtime.translation,
            )
          : await analyzeMcpSelectionOcr(
              app,
              saved,
              input,
              operation,
              runtime.ocr,
            );
      return { items, binding };
    },
  });
  return analyses;
}
