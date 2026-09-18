import type { McpContextSnapshot } from "../application/mcpContextEditPolicy";
import type { McpOperationContext } from "../application/mcpOperationService";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type {
  McpSelectionOcr,
  McpSelectionAnalysisItem,
} from "../../shared/mcpSelectionAnalysis";
import {
  buildMcpOcrObservation,
  selectMcpBlockOcr,
  selectMcpSourceCrop,
} from "../application/mcpBlockOcrService";
import { requireBatchPage } from "../application/mcpPageBatchPolicy";
import { bboxToPixels, bboxOverlapRatio } from "../../shared/geometry";
import { recognizeMcpBlock } from "./mcpBlockOcrAdapter";
import { McpEditError } from "../application/mcpEditPolicy";

export async function analyzeMcpSelectionOcr(
  app: InpaintingJobContext,
  saved: McpContextSnapshot,
  input: McpSelectionOcr,
  context: McpOperationContext,
  runtime?: Parameters<typeof recognizeMcpBlock>[5],
) {
  const items: McpSelectionAnalysisItem[] = [];
  const total = input.pages.reduce((n, page) => n + page.targets.length, 0);
  // Validate every target before the first model invocation.
  const pages = input.pages.map((target) => {
    const page = requireBatchPage(saved.chapter, { ...target, edits: [] });
    const targets = target.targets.map((entry) => {
      const selected =
        entry.kind === "block"
          ? selectMcpBlockOcr(page, entry.blockId)
          : selectMcpSourceCrop(page, entry.sourceRect);
      return { entry, selected };
    });
    return { target, page, targets };
  });
  for (const { target, page, targets } of pages) {
    for (const { entry, selected } of targets) {
      context.assertAuthorized();
      const block =
        entry.kind === "block"
          ? page.blocks.find((block) => block.id === entry.blockId)
          : null;
      if (entry.kind === "block" && !block)
        throw new McpEditError("not_found", "Selected block is missing.");
      const item: McpSelectionAnalysisItem = {
        itemId: `item-${items.length + 1}`,
        pageId: page.id,
        revision: target.revision,
        blockId: entry.kind === "block" ? entry.blockId : null,
        regionId: entry.kind === "region" ? entry.regionId : null,
        excludedReason: block?.generatedLettering
          ? "generated_lettering"
          : null,
        engine: null,
        ocr: null,
        translation: null,
        overlaps: [],
      };
      if (!item.excludedReason) {
        const evidence = await recognizeMcpBlock(
          app,
          input.chapterId,
          page,
          selected.cropRect,
          context,
          runtime,
          {
            ...(input.sourceLanguage
              ? { sourceLanguage: input.sourceLanguage }
              : {}),
            ocrInputKind: entry.kind === "block" ? "known-block-crop" : "page",
          },
        );
        const { engine, ...observation } = evidence;
        item.engine = engine;
        item.ocr = buildMcpOcrObservation(selected, observation);
        item.overlaps = item.ocr.regions.map((region) => ({
          sequence: region.sequence,
          blockIds: page.blocks
            .filter((block) => {
              const rect =
                block.bboxSpace === "pixels"
                  ? block.bbox
                  : bboxToPixels(block.bbox, page.width, page.height);
              return bboxOverlapRatio(region.sourceRect, rect) > 0;
            })
            .map((block) => block.id),
        }));
      }
      items.push(item);
      context.progress({
        phase: "selected_ocr",
        completed: items.length,
        total,
      });
    }
  }
  return items;
}
