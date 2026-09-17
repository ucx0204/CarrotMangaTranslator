import { McpExportBatchService } from "../application/mcpExportBatchService";
import type { McpOperationService } from "../application/mcpOperationService";
import type { McpPageExportService } from "../application/mcpPageExportService";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import { preflightPageImageExport } from "../jobs/pageImageExportSelection";
import { openChapter, listLibrary } from "../library";
import type { McpArtifactStore } from "./mcpArtifactStore";
import { runMcpAppJob } from "./mcpAppJob";
import { createMcpExportBatchTools } from "./mcpExportBatchTools";

/** Both single and multiple PNG exports use exactly the same app job/handoff. */
export function createMcpExportBatchAdapter(options: {
  app: InpaintingJobContext;
  exporter: McpPageExportService;
  operations: McpOperationService;
  artifacts: McpArtifactStore;
  allowImages: boolean;
  reportError: (error: unknown) => void;
}) {
  const exportPage: ConstructorParameters<
    typeof McpExportBatchService
  >[0]["exportPage"] = (target, context, retainedAccess) =>
    runMcpAppJob(
      options.app,
      context,
      "page-export",
      (job) => options.exporter.export(target, job, retainedAccess),
      { resources: [], page: { ...target, readChapter: openChapter } },
    );
  const service = new McpExportBatchService({
    openChapter,
    exportPage,
    reportError: options.reportError,
    archive: options.artifacts.zip.bind(options.artifacts),
    preflight: (chapter, pageIds) =>
      preflightPageImageExport(
        {
          workId: chapter.workId,
          outputFormat: "png",
          omitText: false,
          selections: [{ chapterId: chapter.id, mode: "page-set", pageIds }],
        },
        { listLibrary, openChapter: async () => chapter },
      ),
  });
  return {
    exportPage: (
      target: Parameters<typeof exportPage>[0],
      context: Parameters<typeof exportPage>[1],
    ) => exportPage(target, context, async () => context.assertAuthorized()),
    tools: createMcpExportBatchTools(
      service,
      options.operations,
      options.allowImages,
    ),
  };
}
