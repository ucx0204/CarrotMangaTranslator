import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import { MAX_BLOCKS_PER_PAGE } from "../../shared/ipcSchemaPrimitives";
import { resolvePageBlockOrder } from "../../shared/blockReadingOrder";
import { bboxToPixels, resolveBlockRenderBbox } from "../../shared/geometry";
import { normalizeBboxTo1000 } from "../../shared/bboxNormalization";
import { projectMcpEditableFields } from "../../shared/mcpBlockEditing";
import {
  McpStructurePreviewSchema,
  type McpStructurePreview,
} from "../../shared/mcpBlockStructure";
import { checkedMcpSourceBbox } from "./mcpSourceRectPolicy";
import { McpEditError } from "./mcpEditPolicy";

type StructureSnapshot = Pick<MangaPage, "blocks" | "blockOrder">;
export type StructurePlan = ReturnType<typeof planMcpStructure>;
type Part = Extract<
  McpStructurePreview["operation"],
  { kind: "split" }
>["parts"][number];
function invalid(message: string): never {
  throw new McpEditError("invalid_edit", message);
}

/** Pure structure calculation. No model, image, filesystem or app settings access. */
export function planMcpStructure(
  page: MangaPage,
  input: McpStructurePreview,
  nextId: () => string,
) {
  const parsed = McpStructurePreviewSchema.safeParse(input);
  if (!parsed.success)
    invalid(
      "Invalid structure change. Re-read blocks and author a bounded edit.",
    );
  const { operation: op } = parsed.data;
  const known = new Map(page.blocks.map((block) => [block.id, block]));
  if (known.size !== page.blocks.length)
    invalid("Duplicate stored block IDs must be repaired first.");
  const ids = op.kind === "merge" ? op.blockIds : [op.blockId];
  if (new Set(ids).size !== ids.length) invalid("Select distinct blocks.");
  const selected = ids.map((id) => {
    const block = known.get(id);
    if (!block)
      throw new McpEditError("not_found", "A selected block no longer exists.");
    assertOrdinaryBlock(page, block);
    return block;
  });
  const order = resolvePageBlockOrder(page);
  const added = replacementBlocks(page, parsed.data, selected, order, nextId);
  if (page.blocks.length - selected.length + added.length > MAX_BLOCKS_PER_PAGE)
    invalid("The result exceeds the app's page block limit.");
  for (const block of added) {
    if (
      known.has(block.id) ||
      added.filter((item) => item.id === block.id).length !== 1
    )
      invalid("Generated block IDs collided. Create a new preview.");
  }
  const after = replaceSelected(page, ids, added, order);
  const before = structuredClone({
    blocks: page.blocks,
    blockOrder: page.blockOrder,
  });
  return {
    before,
    after,
    beforeView: selected.map((block) => structureBlockView(page, block)),
    afterView: added.map((block) => structureBlockView(page, block)),
    beforeOrder: order,
    afterOrder: after.blockOrder,
    idMapping: ids.map((from) => ({
      from,
      to: added.map((block) => block.id),
    })),
    warnings: structureWarnings(page, op),
  };
}

function assertOrdinaryBlock(page: MangaPage, block: TranslationBlock) {
  const protectedFields = [
    "generatedLettering",
    "bubbleLayout",
    "perspectiveTransform",
    "curveLayout",
    "warpTransform",
    "sourceFontFacePx",
    "sourceFontFaceFallbackPx",
  ] as const;
  if (
    protectedFields.some((key) => block[key] !== undefined) ||
    block.fontSizeIntent === "source-match"
  )
    invalid(
      "This block has generated lettering or geometry-dependent typography. Do not disable its settings automatically; structure editing cannot safely transfer it yet.",
    );
  if (
    page.soundEffectReview?.resolvedRegions.some(
      (item) => item.blockId === block.id,
    )
  )
    invalid(
      "This block is referenced by sound-effect review. Keep its review ledger intact.",
    );
  if (block.sourceText.length > 20000 || block.translatedText.length > 20000)
    invalid(
      "Stored text exceeds the structure preview limit; it is not truncated.",
    );
}

function replacementBlocks(
  page: MangaPage,
  request: McpStructurePreview,
  selected: TranslationBlock[],
  order: string[],
  nextId: () => string,
): TranslationBlock[] {
  const op = request.operation;
  if (op.kind === "delete") return [];
  if (op.kind === "split") {
    assertTextPreserved([selected[0]], op.parts, op.textPolicy);
    return op.parts.map((part) =>
      createPart(page, selected[0], part, nextId()),
    );
  }
  if (
    Math.abs(order.indexOf(op.blockIds[0]) - order.indexOf(op.blockIds[1])) !==
    1
  )
    invalid("Merge only two adjacent blocks in the effective reading order.");
  const style = selected.find((block) => block.id === op.styleFromBlockId);
  if (!style) invalid("The style source must be one of the two merged blocks.");
  assertTextPreserved(selected, [op.result], op.textPolicy);
  return [createPart(page, style, op.result, nextId())];
}
function assertTextPreserved(
  before: TranslationBlock[],
  after: Part[],
  policy: "preserve" | "replace",
) {
  if (policy === "replace") return;
  for (const field of ["sourceText", "translatedText"] as const) {
    const prior = before.map((block) => block[field].trim());
    const next = after.map((block) => block[field].trim());
    const separators = ["", " ", "\n"];
    if (
      !separators.some((a) =>
        separators.some((b) => prior.join(a) === next.join(b)),
      )
    )
      invalid(
        "Structure editing would lose, duplicate or rewrite text. Inspect the page; use replace only for an intentional wording change, not to bypass a layout failure.",
      );
  }
}
function createPart(
  page: MangaPage,
  style: TranslationBlock,
  part: Part,
  id: string,
): TranslationBlock {
  return {
    ...structuredClone(style),
    id,
    sourceText: part.sourceText,
    translatedText: part.translatedText,
    bbox: checkedMcpSourceBbox(page, part.sourceRect),
    bboxSpace: "normalized_1000",
    renderBbox: checkedMcpSourceBbox(page, part.renderRect),
    renderBboxSpace: "normalized_1000",
    reviewStatus: "needs_review",
  };
}
function replaceSelected(
  page: MangaPage,
  ids: string[],
  added: TranslationBlock[],
  order: string[],
): StructureSnapshot & { blockOrder: string[] } {
  const chosen = new Set(ids);
  const index = page.blocks.findIndex((block) => chosen.has(block.id));
  const blocks = page.blocks.filter((block) => !chosen.has(block.id));
  blocks.splice(index, 0, ...added);
  const orderIndex = order.findIndex((id) => chosen.has(id));
  const blockOrder = order.filter((id) => !chosen.has(id));
  blockOrder.splice(orderIndex, 0, ...added.map((block) => block.id));
  return structuredClone({ blocks, blockOrder });
}
function structureBlockView(page: MangaPage, block: TranslationBlock) {
  return {
    id: block.id,
    sourceText: block.sourceText,
    translatedText: block.translatedText,
    sourceRect: bboxToPixels(
      normalizeBboxTo1000(block.bbox, page, block.bboxSpace),
      page.width,
      page.height,
    ),
    renderRect: bboxToPixels(
      resolveBlockRenderBbox(block, page),
      page.width,
      page.height,
    ),
    fields: projectMcpEditableFields(block),
    sourceDirection: block.sourceDirection,
    ...(block.speakerId === undefined ? {} : { speakerId: block.speakerId }),
    ...(block.glossaryEntryIds === undefined
      ? {}
      : { glossaryEntryIds: block.glossaryEntryIds }),
  };
}

function structureWarnings(
  page: MangaPage,
  op: McpStructurePreview["operation"],
) {
  const warnings = [
    "verify_rendering_after_apply",
    "workflow_status_may_remain_pending_after_undo",
    "existing_ocr_translation_proposals_become_stale",
  ];
  if (page.inpaintedImagePath || page.inpaintMaskPath)
    warnings.push("images_and_masks_retained_not_recomputed");
  if (op.kind === "delete")
    warnings.push("text_object_removed_not_raster_erased");
  if (op.kind === "merge")
    warnings.push(
      "selected_style_and_metadata_used",
      "source_rectangle_requires_erasure_review",
    );
  if (op.kind !== "delete" && op.textPolicy === "replace")
    warnings.push("explicit_text_replacement");
  return warnings;
}
