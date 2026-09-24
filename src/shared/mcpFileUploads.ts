import { z } from "zod/v4";
import {
  MCP_UPLOAD_CHUNK_BYTES,
  McpImageUploadChunkSchema,
  McpImageUploadGetSchema,
} from "./mcpImageUploads";
import { McpChooseImportSchema } from "./mcpLibraryImport";
import { MCP_EXCHANGE_BYTES } from "./mcpExchangeFiles";

const MCP_FILE_UPLOAD_BYTES = 128 * 1024 * 1024;
export const MCP_FILE_UPLOAD_SESSION_BYTES = 256 * 1024 * 1024;
const filename = z
  .string()
  .min(1)
  .max(240)
  .regex(
    /^[^/\\:<>"|?*\u0000-\u001f\u007f]+\.(png|jpg|jpeg|webp|zip|cbz|pdf|rar|cbr|mgtshare|txt|csv|tsv|json)$/i,
  );
export const McpFileUploadBeginSchema = z
  .object({
    requestId: z.uuid(),
    filename,
    bytes: z.number().int().min(1).max(MCP_FILE_UPLOAD_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .refine(
    (input) =>
      !/\.(txt|csv|tsv|json)$/i.test(input.filename) ||
      input.bytes <= MCP_EXCHANGE_BYTES,
    "Text and context uploads are limited to 4 MiB of encoded bytes.",
  );
export type McpFileUploadBegin = z.infer<typeof McpFileUploadBeginSchema>;
export const McpFileUploadChunkSchema = McpImageUploadChunkSchema.extend({
  offset: z.number().int().min(0).max(MCP_FILE_UPLOAD_BYTES),
}).strict();
export const McpUploadedImportSchema = McpChooseImportSchema.extend({
  uploadId: McpImageUploadGetSchema.shape.uploadId,
  kind: z.enum(["images", "archive", "pdf"]),
}).strict();
export type McpUploadedImport = z.infer<typeof McpUploadedImportSchema>;
const receipt = z
  .object({
    uploadId: z.uuid(),
    filename,
    status: z.enum(["receiving", "ready"]),
    validation: z.enum(["pending", "bytes-verified"]),
    expectedBytes: z.number().int().positive().max(MCP_FILE_UPLOAD_BYTES),
    receivedBytes: z.number().int().nonnegative().max(MCP_FILE_UPLOAD_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.number().int().positive(),
    chunkBytes: z.literal(MCP_UPLOAD_CHUNK_BYTES),
    retention: z.literal("session-only"),
    importable: z.literal("not-yet-checked"),
  })
  .strict();
export const mcpFileUploadOutputs = {
  carrot_begin_file_upload: receipt,
  carrot_write_file_upload: receipt,
  carrot_finish_file_upload: receipt,
  carrot_get_file_upload: receipt,
  carrot_discard_file_upload: z
    .object({ uploadId: z.uuid(), discarded: z.literal(true) })
    .strict(),
};
