import { z } from "zod";
import {
  MAX_BLOCKS_PER_PAGE,
  MAX_IMAGE_DIMENSION,
  TranslationBlockSchema,
} from "./ipcSchemaPrimitives";
import { clampBbox, normalizeBboxTo1000 } from "./bboxNormalization";
import { bboxToPixels, resolveBlockRenderBbox } from "./geometry";
import { constrainEditableRenderBbox } from "./editableRenderGeometry";
import { relocateGeneratedLettering } from "./generatedLettering";
import type { BBox, Point, TranslationBlock } from "./textTypes";

export const BLOCK_CLIPBOARD_MIME = "application/x-carrot-manga-blocks+json";
const MAX_CLIPBOARD_LENGTH = 64_000_000;

const BlockClipboardSchema = z
  .object({
    kind: z.literal("carrot-manga-blocks"),
    version: z.literal(1),
    pageSize: z
      .object({
        width: z.number().finite().positive().max(MAX_IMAGE_DIMENSION),
        height: z.number().finite().positive().max(MAX_IMAGE_DIMENSION),
      })
      .strict(),
    blocks: z.array(TranslationBlockSchema).min(1).max(MAX_BLOCKS_PER_PAGE),
  })
  .strict();

type BlockClipboard = z.infer<typeof BlockClipboardSchema>;
type PageSize = BlockClipboard["pageSize"];

export function serializeBlockClipboard(
  blocks: readonly TranslationBlock[],
  pageSize: PageSize,
): string {
  const payload = BlockClipboardSchema.parse({
    kind: "carrot-manga-blocks",
    version: 1,
    pageSize: { width: pageSize.width, height: pageSize.height },
    blocks: blocks.map((block) => ({
      ...block,
      bbox: normalizeBboxTo1000(block.bbox, pageSize, block.bboxSpace),
      bboxSpace: "normalized_1000",
      renderBbox: resolveBlockRenderBbox(block, pageSize),
      renderBboxSpace: "normalized_1000",
    })),
  });
  const serialized = JSON.stringify(payload);
  if (serialized.length > MAX_CLIPBOARD_LENGTH) {
    throw new Error("Block clipboard exceeds its size limit");
  }
  return serialized;
}

/** Clipboard data is untrusted; malformed blocks never reach chapter state. */
export function parseBlockClipboard(serialized: string): BlockClipboard {
  if (serialized.length > MAX_CLIPBOARD_LENGTH) {
    throw new Error("Block clipboard exceeds its size limit");
  }
  return BlockClipboardSchema.parse(JSON.parse(serialized));
}

export function instantiateClipboardBlocks(
  payload: BlockClipboard,
  pageSize: PageSize,
  center: Point,
  createId: () => string,
): TranslationBlock[] {
  const boxes = payload.blocks.map((block) =>
    bboxToPixels(
      resolveBlockRenderBbox(block, payload.pageSize),
      payload.pageSize.width,
      payload.pageSize.height,
    ),
  );
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  const origin = { x: (left + right) / 2, y: (top + bottom) / 2 };
  return payload.blocks.map((block) => {
    const box = bboxToPixels(
      resolveBlockRenderBbox(block, payload.pageSize),
      payload.pageSize.width,
      payload.pageSize.height,
    );
    const renderBbox: BBox = {
      x: center.x + ((box.x - origin.x) / pageSize.width) * 1000,
      y: center.y + ((box.y - origin.y) / pageSize.height) * 1000,
      w: (box.w / pageSize.width) * 1000,
      h: (box.h / pageSize.height) * 1000,
    };
    return createPastedBlock(block, renderBbox, createId());
  });
}

function createPastedBlock(
  source: TranslationBlock,
  requestedBbox: BBox,
  id: string,
): TranslationBlock {
  const {
    speakerId: _speakerId,
    glossaryEntryIds: _glossaryEntryIds,
    visualClusterId: _visualClusterId,
    reviewStatus: _reviewStatus,
    reviewNote: _reviewNote,
    sourceFontFacePx: _sourceFontFacePx,
    sourceFontSizeConfidence: _sourceFontSizeConfidence,
    sourceFontSizeMethod: _sourceFontSizeMethod,
    bubbleLayout,
    ...portable
  } = structuredClone(source);
  const renderBbox = constrainEditableRenderBbox(portable, requestedBbox);
  const block: TranslationBlock = {
    ...portable,
    id,
    bbox: clampBbox(renderBbox),
    bboxSpace: "normalized_1000",
    renderBbox,
    renderBboxSpace: "normalized_1000",
    generatedLettering: relocateGeneratedLettering(
      source.generatedLettering,
      resolveBlockRenderBbox(source),
      renderBbox,
    ),
    // A pasted overlay has no source lettering to erase on its new page.
    inpaintExcluded: true,
  };
  if (bubbleLayout) {
    const {
      sourceImageRevision: _revision,
      modelId: _model,
      ...layout
    } = bubbleLayout;
    block.bubbleLayout = { ...layout, origin: "manual" };
  }
  return block;
}
