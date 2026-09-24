import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { McpOperationExecutor } from "../application/mcpOperationService";
import { McpBlockTranslationService } from "../application/mcpBlockTranslationService";
import { McpBlockTranslationTargetSchema } from "../../shared/mcpBlockTranslation";
import { openChapter, getRunPaths } from "../library";
import { getAppSettings } from "../settingsStore";
import { buildBaseOptions } from "../pipeline/options";
import { runMcpAppJob } from "./mcpAppJob";
import { translateMcpBlock } from "./mcpBlockTranslationAdapter";
import { prepareMcpBlockTranslationOptions } from "./mcpBlockTranslationOptions";

export function createMcpBlockTranslationExecutor(
  app: InpaintingJobContext,
  runtime?: Parameters<typeof translateMcpBlock>[3],
): McpOperationExecutor {
  return async (target, operation) => {
    const request = McpBlockTranslationTargetSchema.parse(target);
    operation.assertAuthorized();
    const settings = await getAppSettings(app.appPaths);
    const paths = await getRunPaths(request.chapterId, operation.id);
    operation.assertAuthorized();
    const prepared = prepareMcpBlockTranslationOptions(
      buildBaseOptions(operation.id, paths.runDir, settings, app.appPaths),
    );
    return runMcpAppJob(
      app,
      operation,
      "gemma-analysis",
      (context) =>
        new McpBlockTranslationService({
          openChapter,
          translate: (input, guard) =>
            translateMcpBlock(input, prepared.options, guard, runtime),
        }).run(request, context),
      {
        resources:
          prepared.execution === "local"
            ? [{ kind: "model-runtime", scope: "*", access: "write" }]
            : [],
        page: { ...request, readChapter: openChapter },
      },
    );
  };
}
