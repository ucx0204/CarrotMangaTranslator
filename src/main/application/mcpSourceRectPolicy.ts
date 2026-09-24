import type { MangaPage } from "../../shared/libraryTypes";
import type { BBox, TranslationBlock } from "../../shared/textTypes";
import { normalizeBboxTo1000 } from "../../shared/bboxNormalization";
import { isGeneratedBubbleLayout } from "../../shared/bubbleLayout";
import {
  bboxToPixels,
  resolveBlockRenderBbox,
  resolveEffectiveRenderBbox,
} from "../../shared/geometry";
import { parseRichText } from "../../shared/richTextMarkup";
import { getActiveGeneratedLettering } from "../../shared/generatedLettering";
import {
  McpSourceRectPatchSchema,
  type McpSourceRectPatch,
  type McpSourceRectWarning,
} from "../../shared/mcpSourceRect";
import { McpEditError } from "./mcpEditPolicy";

/** Change source evidence only. No inference, mask repair, image mutation or
 * typography recalculation runs here. Legacy fallback placement is made explicit. */
export function applyMcpSourceRect(
  page: MangaPage,
  request: McpSourceRectPatch,
) {
  const bbox = checkedMcpSourceBbox(page, request.sourceRect);
  const selected = page.blocks.filter((block) => block.id === request.blockId);
  if (!selected.length)
    throw new McpEditError("not_found", "Source block not found.");
  if (selected.length !== 1)
    throw new McpEditError(
      "invalid_edit",
      "The page has duplicate block IDs. Repair it before editing.",
    );
  const block = selected[0];
  const previous = normalizeBboxTo1000(block.bbox, page, block.bboxSpace);
  const changed = !sameBox(previous, bbox);
  if (changed) assertIndependentTypography(block);
  const pinned = changed && !block.renderBbox;
  const next = changed
    ? {
        ...block,
        bbox,
        bboxSpace: "normalized_1000" as const,
        ...(pinned
          ? {
              renderBbox: existingRenderFrame(block, page),
              renderBboxSpace: "normalized_1000" as const,
            }
          : {}),
      }
    : block;
  return {
    blocks: page.blocks.map((item) => (item === block ? next : item)),
    blockOrder: page.blockOrder,
    changed,
    result: {
      changed,
      previousSourceRect: bboxToPixels(previous, page.width, page.height),
      sourceRect: bboxToPixels(
        changed ? bbox : previous,
        page.width,
        page.height,
      ),
      sourceBbox: changed ? bbox : previous,
      sourceBboxSpace: "normalized_1000" as const,
      renderFramePinned: pinned,
      warnings: changed ? retainedEvidenceWarnings(page, block) : [],
    },
  };
}

/** Generated layouts can use source geometry to accept font-face measurements
 * and peer fallbacks. Do not change fonts, copy that algorithm or claim parity
 * by preserving only stored scalar fields. No-op inspection remains allowed. */
function assertIndependentTypography(block: TranslationBlock): void {
  if (
    isGeneratedBubbleLayout(block.bubbleLayout) &&
    (block.sourceFontFacePx !== undefined ||
      block.fontSizeIntent === "source-match")
  )
    throw new McpEditError(
      "invalid_edit",
      "This block uses source geometry for automatic typography. A source-only edit cannot guarantee its existing layout; no changes were saved.",
    );
}

export function checkedMcpSourceBbox(page: MangaPage, value: BBox): BBox {
  const parsed = McpSourceRectPatchSchema.shape.sourceRect.safeParse(value);
  if (
    !parsed.success ||
    !Number.isSafeInteger(page.width) ||
    !Number.isSafeInteger(page.height) ||
    page.width <= 0 ||
    page.height <= 0
  )
    throw new McpEditError(
      "invalid_edit",
      "Source rectangle and page dimensions must be finite positive pixel bounds.",
    );
  const rect = parsed.data;
  if (
    rect.x > page.width ||
    rect.y > page.height ||
    rect.w > page.width - rect.x ||
    rect.h > page.height - rect.y
  )
    throw new McpEditError(
      "invalid_edit",
      "Source rectangle must fit entirely inside the original page. It is never clipped silently.",
    );
  const bbox = normalizeBboxTo1000(rect, page, "pixels");
  if (!sameBox(rect, bboxToPixels(bbox, page.width, page.height)))
    throw new McpEditError(
      "invalid_edit",
      "Source rectangle is below the app's normalized geometry minimum. Enlarge it to at least 1/1000 of the page on each axis.",
    );
  return bbox;
}
function sameBox(a: BBox, b: BBox) {
  return (["x", "y", "w", "h"] as const).every(
    (key) => Math.abs(a[key] - b[key]) <= 1e-8,
  );
}
function existingRenderFrame(block: TranslationBlock, page: MangaPage) {
  if (getActiveGeneratedLettering(block))
    return resolveBlockRenderBbox(block, page);
  const text = parseRichText(
    block.translatedText || block.sourceText || "...",
    Boolean(block.bold),
    Boolean(block.italic),
  ).plainText;
  return resolveEffectiveRenderBbox(block, page, text);
}
function retainedEvidenceWarnings(
  page: MangaPage,
  block: TranslationBlock,
): McpSourceRectWarning[] {
  const warnings: McpSourceRectWarning[] = ["source_text_not_rechecked"];
  if (page.inpaintedImagePath || page.inpaintMaskPath)
    warnings.push("erasure_and_masks_retained");
  if (block.generatedLettering) warnings.push("generated_lettering_retained");
  if (
    block.sourceFontFacePx !== undefined ||
    block.fontSizeIntent === "source-match"
  )
    warnings.push("source_font_metrics_retained");
  if (block.bubbleLayout) warnings.push("bubble_layout_retained");
  return warnings;
}
