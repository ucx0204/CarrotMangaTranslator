import { z } from "zod";
import { constrainEditableRenderBbox } from "./editableRenderGeometry";
import { TranslationBlockObjectSchema } from "./ipcSchemaPrimitives";
import type { BBox, Point, TranslationBlock } from "./textTypes";

const BLOCK_LIBRARY_SCHEMA_VERSION = 1 as const;
export const MAX_BLOCK_LIBRARY_ENTRIES = 2000;
const MAX_BLOCK_LIBRARY_NAME_LENGTH = 120;

const BlockLibraryTemplateSchema = TranslationBlockObjectSchema.pick({
  sourceText: true,
  translatedText: true,
  textRole: true,
  sourceDirection: true,
  renderDirection: true,
  rotationDeg: true,
  perspectiveTransform: true,
  curveLayout: true,
  warpTransform: true,
  fontFamily: true,
  fontSizePx: true,
  lineHeight: true,
  letterSpacing: true,
  fontWidthScale: true,
  wordBreak: true,
  textAlign: true,
  textColor: true,
  textOpacity: true,
  outlineColor: true,
  outlineWidthPx: true,
  outlineWidthScale: true,
  textEffect: true,
  bold: true,
  italic: true,
  backgroundColor: true,
  opacity: true,
  autoFitText: true,
})
  .extend({
    size: z
      .object({
        w: z.number().finite().min(1).max(4000),
        h: z.number().finite().min(1).max(4000),
      })
      .strict(),
  })
  .strict();

type BlockLibraryTemplateV1 = z.infer<typeof BlockLibraryTemplateSchema>;

export const BlockLibraryEntryV1Schema = z
  .object({
    schemaVersion: z.literal(BLOCK_LIBRARY_SCHEMA_VERSION),
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(MAX_BLOCK_LIBRARY_NAME_LENGTH),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    lastUsedAt: z.string().datetime(),
    block: BlockLibraryTemplateSchema,
  })
  .strict();

export type BlockLibraryEntryV1 = z.infer<typeof BlockLibraryEntryV1Schema>;

export const BlockLibrarySnapshotV1Schema = z
  .object({
    schemaVersion: z.literal(BLOCK_LIBRARY_SCHEMA_VERSION),
    entries: z.array(BlockLibraryEntryV1Schema).max(MAX_BLOCK_LIBRARY_ENTRIES),
  })
  .strict();

export type BlockLibrarySnapshotV1 = z.infer<
  typeof BlockLibrarySnapshotV1Schema
>;

export const SaveBlockLibraryEntryInputSchema = z
  .object({
    name: z.string().min(1).max(MAX_BLOCK_LIBRARY_NAME_LENGTH),
    block: BlockLibraryTemplateSchema,
  })
  .strict();

export type SaveBlockLibraryEntryInput = z.infer<
  typeof SaveBlockLibraryEntryInputSchema
>;

export const RenameBlockLibraryEntryInputSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(MAX_BLOCK_LIBRARY_NAME_LENGTH),
  })
  .strict();

export type RenameBlockLibraryEntryInput = z.infer<
  typeof RenameBlockLibraryEntryInputSchema
>;

export const UpdateBlockLibraryEntryInputSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(MAX_BLOCK_LIBRARY_NAME_LENGTH),
    block: BlockLibraryTemplateSchema,
  })
  .strict();

export type UpdateBlockLibraryEntryInput = z.infer<
  typeof UpdateBlockLibraryEntryInputSchema
>;

export const BlockLibraryEntryIdSchema = z.string().min(1).max(200);

export function createEmptyBlockLibrarySnapshot(): BlockLibrarySnapshotV1 {
  return { schemaVersion: BLOCK_LIBRARY_SCHEMA_VERSION, entries: [] };
}

export function resolveBlockLibraryDefaultName(
  block: Pick<TranslationBlock, "sourceText" | "translatedText">,
): string {
  const candidate = block.sourceText.trim() || block.translatedText.trim();
  const normalized = candidate.replace(/\s+/g, " ").trim();
  return normalized.slice(0, MAX_BLOCK_LIBRARY_NAME_LENGTH) || "새 블록";
}

export function createBlockLibrarySaveInput(
  block: TranslationBlock,
  pageSize: { width: number; height: number },
  name = resolveBlockLibraryDefaultName(block),
): SaveBlockLibraryEntryInput {
  const size = resolveLibraryBlockSize(block, pageSize);
  const input: SaveBlockLibraryEntryInput = {
    name: normalizeBlockLibraryName(name),
    block: {
      sourceText: block.sourceText,
      translatedText: block.translatedText,
      sourceDirection: block.sourceDirection,
      renderDirection: block.renderDirection,
      fontSizePx: block.fontSizePx,
      lineHeight: block.lineHeight,
      textAlign: block.textAlign,
      textColor: block.textColor,
      backgroundColor: block.backgroundColor,
      opacity: block.opacity,
      size,
    },
  };
  copyDefinedTemplateFields(block, input.block);
  return SaveBlockLibraryEntryInputSchema.parse(input);
}

export function instantiateBlockLibraryEntry(
  entry: BlockLibraryEntryV1,
  id: string,
  center: Point = { x: 500, y: 500 },
): TranslationBlock {
  const { size, ...template } = entry.block;
  const requestedRenderBbox: BBox = {
    x: center.x - size.w / 2,
    y: center.y - size.h / 2,
    w: size.w,
    h: size.h,
  };
  const renderBbox = constrainEditableRenderBbox(template, requestedRenderBbox);
  const sourceSize = {
    w: Math.min(1000, size.w),
    h: Math.min(1000, size.h),
  };
  const bbox: BBox = {
    x: clampFinite(center.x - sourceSize.w / 2, 0, 1000 - sourceSize.w),
    y: clampFinite(center.y - sourceSize.h / 2, 0, 1000 - sourceSize.h),
    ...sourceSize,
  };
  return {
    id,
    type: "nonsolid",
    bbox,
    bboxSpace: "normalized_1000",
    renderBbox,
    renderBboxSpace: "normalized_1000",
    confidence: 1,
    ...template,
  };
}

function resolveLibraryBlockSize(
  block: TranslationBlock,
  pageSize: { width: number; height: number },
): { w: number; h: number } {
  const bbox = block.renderBbox ?? block.bbox;
  const bboxSpace = block.renderBbox ? block.renderBboxSpace : block.bboxSpace;
  const width =
    bboxSpace === "pixels"
      ? (bbox.w / Math.max(1, pageSize.width)) * 1000
      : bbox.w;
  const height =
    bboxSpace === "pixels"
      ? (bbox.h / Math.max(1, pageSize.height)) * 1000
      : bbox.h;
  const maximum = block.renderBbox ? 4000 : 1000;
  return {
    w: clampFinite(width, 1, maximum),
    h: clampFinite(height, 1, maximum),
  };
}

function clampFinite(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizeBlockLibraryName(name: string): string {
  const normalized = name.replace(/\s+/g, " ").trim();
  if (!normalized) return "새 블록";
  return normalized.slice(0, MAX_BLOCK_LIBRARY_NAME_LENGTH);
}

const OPTIONAL_TEMPLATE_FIELDS = [
  "textRole",
  "rotationDeg",
  "perspectiveTransform",
  "curveLayout",
  "warpTransform",
  "fontFamily",
  "letterSpacing",
  "fontWidthScale",
  "wordBreak",
  "textOpacity",
  "outlineColor",
  "outlineWidthPx",
  "outlineWidthScale",
  "textEffect",
  "bold",
  "italic",
  "autoFitText",
] as const;

function copyDefinedTemplateFields(
  block: TranslationBlock,
  target: BlockLibraryTemplateV1,
): void {
  for (const key of OPTIONAL_TEMPLATE_FIELDS) {
    const value = block[key];
    if (value !== undefined) {
      Object.assign(target, { [key]: value });
    }
  }
}
