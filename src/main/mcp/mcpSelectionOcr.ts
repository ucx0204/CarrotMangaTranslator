import type { McpContextSnapshot } from "../application/mcpContextEditPolicy";
import type { McpOperationContext } from "../application/mcpOperationService";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { MangaPage } from "../../shared/libraryTypes";
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

type Runtime = Parameters<typeof recognizeMcpBlock>[5];
type Selected = ReturnType<typeof selectPages>[number];
export async function analyzeMcpSelectionOcr(
  app: InpaintingJobContext,
  saved: McpContextSnapshot,
  input: McpSelectionOcr,
  context: McpOperationContext,
  runtime?: Runtime,
) {
  const items: McpSelectionAnalysisItem[] = [];
  const total = input.pages.reduce((n, page) => n + page.targets.length, 0);
  for (const page of selectPages(saved, input)) {
    for (const target of page.targets) {
      items.push(
        await observeTarget(
          app,
          input,
          page,
          target,
          context,
          runtime,
          items.length,
        ),
      );
      context.progress({
        phase: "selected_ocr",
        completed: items.length,
        total,
      });
    }
  }
  return items;
}
function selectPages(saved: McpContextSnapshot, input: McpSelectionOcr) {
  // Validate every target before the first model invocation.
  return input.pages.map((target) => {
    const page = requireBatchPage(saved.chapter, { ...target, edits: [] });
    const targets = target.targets.map((entry) => ({
      entry,
      selected:
        entry.kind === "block"
          ? selectMcpBlockOcr(page, entry.blockId)
          : selectMcpSourceCrop(page, entry.sourceRect),
    }));
    return { target, page, targets };
  });
}
async function observeTarget(
  app: InpaintingJobContext,
  input: McpSelectionOcr,
  pageTarget: Selected,
  selectedTarget: Selected["targets"][number],
  context: McpOperationContext,
  runtime: Runtime,
  index: number,
): Promise<McpSelectionAnalysisItem> {
  context.assertAuthorized();
  const { target, page } = pageTarget;
  const { entry, selected } = selectedTarget;
  const block =
    entry.kind === "block"
      ? page.blocks.find((block) => block.id === entry.blockId)
      : null;
  const item: McpSelectionAnalysisItem = {
    itemId: `item-${index + 1}`,
    pageId: page.id,
    revision: target.revision,
    blockId: entry.kind === "block" ? entry.blockId : null,
    regionId: entry.kind === "region" ? entry.regionId : null,
    excludedReason: block?.generatedLettering ? "generated_lettering" : null,
    engine: null,
    ocr: null,
    translation: null,
    overlaps: [],
  };
  if (item.excludedReason) return item;
  const evidence = await recognizeMcpBlock(
    app,
    input.chapterId,
    page,
    selected.cropRect,
    context,
    runtime,
    {
      ...(input.sourceLanguage ? { sourceLanguage: input.sourceLanguage } : {}),
      ocrInputKind: entry.kind === "block" ? "known-block-crop" : "page",
    },
  );
  const { engine, ...observation } = evidence;
  item.engine = engine;
  item.ocr = buildMcpOcrObservation(selected, observation);
  item.overlaps = overlaps(page, item.ocr.regions);
  return item;
}
function overlaps(
  page: MangaPage,
  regions: NonNullable<McpSelectionAnalysisItem["ocr"]>["regions"],
) {
  return regions.map((region) => ({
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
