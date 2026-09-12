import { createHash } from "node:crypto";
import type { MangaPage } from "../../shared/libraryTypes";
import type {
  McpPageReading,
  McpReadingBlock,
} from "../../shared/mcpReadingTypes";
import type { BlockFormatDefaults } from "../../shared/blockFormat";
import { applyFormatDefaultsToBlock } from "../../shared/blockFormat";
import { normalizeBboxTo1000 } from "../../shared/bboxNormalization";
import { estimateFontSizePx } from "../../shared/blockGeometryValues";
import { resolveBlockVisualStyle } from "../../shared/blockVisuals";
import { hashStableValue } from "../../shared/blockFingerprint";
import type { PixelRect } from "../../shared/region";
import { McpEditError } from "./mcpEditPolicy";

/** Source coordinates are validated in pixels then normalized by the app geometry contract. */
export function prepareMcpReading(
  page: MangaPage,
  request: McpPageReading,
  defaults?: BlockFormatDefaults,
) {
  if (
    new Set(request.blocks.map((entry) => entry.key)).size !==
    request.blocks.length
  )
    throw new McpEditError(
      "invalid_edit",
      "Reading keys must be unique in this request.",
    );
  const blocks = request.blocks.map((entry) =>
    buildReadingBlock(page, request.requestId, entry, defaults),
  );
  const existing = new Map(page.blocks.map((block) => [block.id, block]));
  const found = blocks.filter((block) => existing.has(block.id));
  if (!found.length) return { blocks, alreadyApplied: false };
  if (
    found.length !== blocks.length ||
    found.some(
      (block) =>
        hashStableValue(readingFields(block)) !==
        hashStableValue(readingFields(existing.get(block.id) ?? block)),
    )
  )
    throw new McpEditError(
      "revision_conflict",
      "This reading request was already used with different content. Do not reuse its requestId for a different reading.",
    );
  return { blocks, alreadyApplied: true };
}
function buildReadingBlock(
  page: MangaPage,
  requestId: string,
  entry: McpReadingBlock,
  defaults?: BlockFormatDefaults,
) {
  assertRect(page, entry.sourceRect);
  assertRect(page, entry.renderRect ?? entry.sourceRect);
  const bbox = normalizeBboxTo1000(entry.sourceRect, page, "pixels");
  const renderBbox = normalizeBboxTo1000(
    entry.renderRect ?? entry.sourceRect,
    page,
    "pixels",
  );
  const visual = resolveBlockVisualStyle("nonsolid");
  return applyFormatDefaultsToBlock(
    {
      id: `mcp-${createHash("sha256")
        .update(JSON.stringify([page.id, requestId, entry.key]))
        .digest("hex")
        .slice(0, 32)}`,
      type: "nonsolid",
      bbox,
      renderBbox,
      bboxSpace: "normalized_1000",
      renderBboxSpace: "normalized_1000",
      sourceText: entry.sourceText,
      translatedText: entry.translatedText,
      sourceDirection: entry.sourceDirection ?? "horizontal",
      renderDirection: entry.renderDirection ?? "horizontal",
      textRole: entry.textRole ?? "ordinary",
      confidence: 1,
      reviewStatus: "needs_review",
      fontSizePx: estimateFontSizePx(
        entry.translatedText || entry.sourceText || "...",
        renderBbox,
        page,
      ),
      lineHeight: 1.18,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: visual.backgroundColor,
      opacity: visual.defaultOpacity,
      autoFitText: true,
    },
    defaults,
  );
}
function readingFields(block: ReturnType<typeof buildReadingBlock>) {
  return {
    sourceText: block.sourceText,
    translatedText: block.translatedText,
    bbox: block.bbox,
    renderBbox: block.renderBbox,
    sourceDirection: block.sourceDirection,
    textRole: block.textRole,
  };
}
function assertRect(page: MangaPage, rect: PixelRect): void {
  if (
    !Object.values(rect).every(Number.isSafeInteger) ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.w < 1 ||
    rect.h < 1 ||
    rect.x + rect.w > page.width ||
    rect.y + rect.h > page.height
  )
    throw new McpEditError(
      "invalid_edit",
      "Reading rectangles must be integer pixels wholly inside the original page.",
    );
}
