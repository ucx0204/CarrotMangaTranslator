import { z } from "zod/v4";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const revision = z.string().regex(/^page-v1:[a-f0-9]{16}$/);
const coordinate = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const extent = z.number().finite().positive().max(Number.MAX_SAFE_INTEGER);
const rect = z.object({ x: coordinate, y: coordinate, w: extent, h: extent }).strict();

/** Original-image pixels, including fractional pixels for lossless round trips.
 * Page bounds and the app's minimum normalized extent are checked by policy. */
export const McpSourceRectPatchSchema = z.object({
  chapterId: id,
  pageId: id,
  blockId: id,
  revision,
  sourceRect: rect,
}).strict();
export type McpSourceRectPatch = z.infer<typeof McpSourceRectPatchSchema>;

const warning = z.enum([
  "source_text_not_rechecked",
  "erasure_and_masks_retained",
  "generated_lettering_retained",
  "source_font_metrics_retained",
  "bubble_layout_retained",
]);
export type McpSourceRectWarning = z.infer<typeof warning>;
export const McpSourceRectResultSchema = z.object({
  chapterId: id,
  pageId: id,
  blockId: id,
  revision,
  status: z.enum(["saved", "already_applied"]),
  changed: z.boolean(),
  previousSourceRect: rect,
  sourceRect: rect,
  sourceBbox: rect,
  sourceBboxSpace: z.literal("normalized_1000"),
  renderFramePinned: z.boolean(),
  warnings: z.array(warning),
}).strict();
