import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mcpSourceTypographyItem } from "./mcpSourceTypographyItem";
import { McpSourceSizeTargetSchema } from "../../shared/mcpSourceSize";
import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import { estimatePageSourceFontSizes } from "../pipeline/sourceFontSizeEstimator";
import { McpSourceSizeService } from "../application/mcpSourceSizeService";
import { McpEditError } from "../application/mcpEditPolicy";
import type {
  McpOperationContext,
  McpOperationExecutor,
} from "../application/mcpOperationService";
import { openChapter } from "../library";
import { runMcpAppJob } from "./mcpAppJob";

/** Existing original-raster estimator; no model, OCR, downloads or writer. */
export async function measureMcpSourceSizes(
  page: MangaPage,
  blocks: TranslationBlock[],
  context: McpOperationContext,
  loadRaster?: Parameters<typeof estimatePageSourceFontSizes>[0]["loadRaster"],
) {
  context.assertAuthorized();
  const digest = async () =>
    createHash("sha256")
      .update(await readFile(page.imagePath))
      .digest("hex");
  const sourceImageSha256 = await digest();
  context.assertAuthorized();
  const items = blocks.map((block, index) =>
    mcpSourceTypographyItem(page, block, index),
  );
  const estimates = await estimatePageSourceFontSizes({
    enabled: true,
    loadRaster,
    items,
    page,
    signal: context.signal,
  });
  context.assertAuthorized();
  if ((await digest()) !== sourceImageSha256)
    throw new McpEditError(
      "revision_conflict",
      "Original image changed during source measurement.",
    );
  context.assertAuthorized();
  return {
    sourceImageSha256,
    estimates: estimates.map((estimate) => estimate ?? null),
  };
}

export function createMcpSourceSizeExecutor(
  app: InpaintingJobContext,
): McpOperationExecutor {
  return (target, context) => {
    const request = McpSourceSizeTargetSchema.parse(target);
    return runMcpAppJob(
      app,
      context,
      "gemma-analysis",
      (job) =>
        new McpSourceSizeService({
          openChapter,
          measure: measureMcpSourceSizes,
        }).run(request, job),
      { resources: [], page: { ...request, readChapter: openChapter } },
    );
  };
}
