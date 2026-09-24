import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { McpOperationService } from "../application/mcpOperationService";
import { McpTypographyAnalysisService } from "../application/mcpTypographyAnalysisService";
import { McpTypographyReadService } from "../application/mcpTypographyReadService";
import { McpEditError } from "../application/mcpEditPolicy";
import { requireBatchPage } from "../application/mcpPageBatchPolicy";
import { openChapter, readWorkContextForEdit } from "../library";
import { reserveJobChapter, acquireJobPage } from "../jobs/jobPageOwnership";
import { readMcpFontCatalog } from "./mcpFontCatalogAdapter";
import { createMcpTypographyAnalyzer } from "./mcpTypographyAnalysisAdapter";
import { createMcpTypographyAnalysisTool } from "./mcpTypographyAnalysisTool";
import { runMcpAppJob } from "./mcpAppJob";
import type { McpTool } from "./mcpReadTools";

export function createMcpTypographyAnalysisSession(
  app: InpaintingJobContext,
  operations: McpOperationService,
  enabled: boolean,
  runtime?: Parameters<typeof createMcpTypographyAnalyzer>[1],
): McpTool[] {
  if (!enabled) return [];
  const service = new McpTypographyAnalysisService({
    read: readWorkContextForEdit,
    preparation: new McpTypographyReadService({
      openChapter,
      readCatalog: () => readMcpFontCatalog(app.appPaths),
      analysisToolAvailable: true,
    }),
    analyze: createMcpTypographyAnalyzer(app, runtime),
  });
  return [
    createMcpTypographyAnalysisTool(operations, (request, operation) =>
      runMcpAppJob(
        app,
        operation,
        "gemma-analysis",
        async (context) => {
          const chapter = await openChapter(request.chapterId);
          context.assertAuthorized();
          if (chapter.id !== request.chapterId)
            throw new McpEditError(
              "not_found",
              "Requested typography chapter is unavailable.",
            );
          for (const page of request.pages)
            requireBatchPage(chapter, { ...page, edits: [] });
          reserveJobChapter(
            app.jobs,
            context.id,
            chapter,
            request.pages.map((page) => page.pageId),
          );
          for (const target of request.pages) {
            await acquireJobPage(
              app.jobs,
              context.id,
              request.chapterId,
              target.pageId,
              openChapter,
            );
            context.assertAuthorized();
          }
          return service.run(request, context);
        },
        {
          resources:
            request.mode === "size"
              ? []
              : [{ kind: "model-runtime", scope: "*", access: "write" }],
        },
      ),
    ),
  ];
}
