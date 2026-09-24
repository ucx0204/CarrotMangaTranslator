import { McpExportBatchService } from "../application/mcpExportBatchService";
import type { McpOperationService } from "../application/mcpOperationService";
import type { McpPageExportService } from "../application/mcpPageExportService";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import { preflightPageImageExport } from "../jobs/pageImageExportSelection";
import { openChapter, listLibrary } from "../library";
import type { McpArtifactStore } from "./mcpArtifactStore";
import { runMcpAppJob } from "./mcpAppJob";
import { createMcpExportBatchTools } from "./mcpExportBatchTools";
import { readMcpExportSourceName } from "./mcpSourceExport";
import {
  createMcpExportSourceResolver,
  type McpExportSourceBorrow,
} from "./mcpExportSourceResolver";

/** All image formats join the same native job ownership and page handoff. */
export function createMcpExportBatchAdapter(options: {
  app: InpaintingJobContext;
  exporter: McpPageExportService;
  operations: McpOperationService;
  artifacts: McpArtifactStore;
  allowImages: boolean;
  reportError: (error: unknown) => void;
  borrowOutput?: McpExportSourceBorrow;
}) {
  const exportPage: ConstructorParameters<
    typeof McpExportBatchService
  >[0]["exportPage"] = (target, context, retainedAccess) =>
    runMcpAppJob(
      options.app,
      context,
      "page-export",
      async (job) =>
        target.imageExport
          ? options.exporter.exportImage(
              { ...target, imageExport: target.imageExport },
              job,
              retainedAccess,
            )
          : options.exporter.export(target, job, retainedAccess),
      { resources: [], page: { ...target, readChapter: openChapter } },
    );
  const service = new McpExportBatchService({
    openChapter,
    readSourceName: readMcpExportSourceName,
    exportPage,
    reportError: options.reportError,
    archive: options.artifacts.zip.bind(options.artifacts),
    preflight: (chapter, pageIds, imageExport) =>
      preflightPageImageExport(
        {
          workId: chapter.workId,
          outputFormat: imageExport?.format ?? "png",
          omitText: imageExport?.omitText ?? false,
          jpegQuality:
            imageExport?.format === "source"
              ? imageExport.jpegQuality
              : imageExport?.quality,
          webpQuality:
            imageExport?.format === "source"
              ? imageExport.webpQuality
              : imageExport?.quality,
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
      options.borrowOutput
        ? createMcpExportSourceResolver({
            operations: options.operations,
            artifacts: options.artifacts,
            borrowOutput: options.borrowOutput,
          })
        : undefined,
    ),
  };
}
