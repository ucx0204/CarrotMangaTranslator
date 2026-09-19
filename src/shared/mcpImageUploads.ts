import { z } from "zod/v4";
import { McpSourceRectPatchSchema } from "./mcpSourceRect";

const { chapterId, pageId, revision } = McpSourceRectPatchSchema.shape;
export const MCP_UPLOAD_CHUNK_BYTES = 32 * 1024;
export const MCP_UPLOAD_FILE_BYTES = 32 * 1024 * 1024;
export const MCP_UPLOAD_SESSION_BYTES = 128 * 1024 * 1024;
export const MCP_UPLOAD_LIFETIME_MS = 30 * 60_000;
export const McpImageUploadBeginSchema = z.object({
  chapterId, pageId, revision,
  contextRevision: z.string().regex(/^[a-f0-9]{16}$/),
  requestId: z.uuid(),
  purpose: z.enum(["image", "mask"]),
  mimeType: z.literal("image/png"),
  bytes: z.number().int().min(1).max(MCP_UPLOAD_FILE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().int().min(1).max(16_000_000),
  height: z.number().int().min(1).max(16_000_000),
}).strict().refine((value) => value.width * value.height <= 16_000_000);
export type McpImageUploadBegin = z.infer<typeof McpImageUploadBeginSchema>;
export const McpImageUploadGetSchema = z.object({ uploadId: z.uuid() }).strict();
export const McpImageUploadChunkSchema = McpImageUploadGetSchema.extend({
  offset: z.number().int().min(0).max(MCP_UPLOAD_FILE_BYTES),
  data: z.string().min(4).max(Math.ceil(MCP_UPLOAD_CHUNK_BYTES / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict();
export type McpImageUploadChunk = z.infer<typeof McpImageUploadChunkSchema>;
const receipt = z.object({
  uploadId: z.uuid(), chapterId, pageId, revision,
  purpose: z.enum(["image", "mask"]),
  mimeType: z.literal("image/png"),
  status: z.enum(["receiving", "ready"]),
  expectedBytes: z.number().int().positive(),
  receivedBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  chunkBytes: z.literal(MCP_UPLOAD_CHUNK_BYTES),
  hasTransparency: z.boolean().nullable(),
  selectedPixels: z.number().int().nonnegative().nullable(),
}).strict();
export const mcpImageUploadOutputs = {
  carrot_begin_image_upload: receipt,
  carrot_write_image_upload: receipt,
  carrot_finish_image_upload: receipt,
  carrot_get_image_upload: receipt,
  carrot_discard_image_upload: z.object({ uploadId: z.uuid(), discarded: z.literal(true) }).strict(),
};
