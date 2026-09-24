import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { McpOperationExecutor } from "../application/mcpOperationService";
import { McpBlockOcrService } from "../application/mcpBlockOcrService";
import { McpBlockOcrTargetSchema } from "../../shared/mcpBlockOcr";
import { openChapter } from "../library";
import { runMcpAppJob } from "./mcpAppJob";
import { recognizeMcpBlock } from "./mcpBlockOcrAdapter";

export function createMcpBlockOcrExecutor(
  app: InpaintingJobContext,
  runtime?: Parameters<typeof recognizeMcpBlock>[5],
): McpOperationExecutor {
  return (target, context) => {
    const request = McpBlockOcrTargetSchema.parse(target);
    return runMcpAppJob(
      app,
      context,
      "gemma-analysis",
      (job) =>
        new McpBlockOcrService({
          openChapter,
          recognize: (page, rect, operation) =>
            recognizeMcpBlock(
              app,
              request.chapterId,
              page,
              rect,
              operation,
              runtime,
            ),
        }).run(request, job),
      {
        resources: [{ kind: "model-runtime", scope: "*", access: "write" }],
        page: { ...request, readChapter: openChapter },
      },
    );
  };
}
