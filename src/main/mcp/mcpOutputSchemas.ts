import { mcpTranslationBatchOutputs } from "../../shared/mcpTranslationBatch";
import { mcpStructureOutputs } from "../../shared/mcpBlockStructure";
import { mcpErasureRecoveryOutputs } from "../../shared/mcpErasureRecoverySchemas";
import { z } from "zod/v4";
import {
  McpContextResearchTargetSchema,
  mcpContextOutputSchemas,
} from "../../shared/mcpContextEditing";
import { mcpJobResultMetadataSchema } from "../application/mcpJobJournal";
import { mcpReviewOutputSchemas } from "../../shared/mcpReviewSchemas";
import { McpEditableFieldsSchema } from "../../shared/mcpBlockEditing";
import { McpSourceRectResultSchema } from "../../shared/mcpSourceRect";

const text = z.string();
const count = z.number().int().nonnegative();
const size = z.number().positive();
const flag = z.boolean();
const revision = text.regex(/^page-v1:[a-f0-9]{16}$/);
const window = {
  total: count,
  offset: count,
  limit: count,
  nextOffset: count.nullable(),
};
const target = { chapterId: text, pageId: text, revision };
const rect = z
  .object({ x: z.number(), y: z.number(), w: size, h: size })
  .strict();
const direction = z.enum(["horizontal", "vertical"]);
const block = z
  .object({
    id: text,
    fields: McpEditableFieldsSchema.optional(),
    sourceText: text,
    translatedText: text,
    bbox: rect,
    bboxSpace: z.enum(["pixels", "normalized_1000"]).optional(),
    renderBbox: rect.optional(),
    renderBboxSpace: z.enum(["pixels", "normalized_1000"]).optional(),
    textRole: z.enum(["ordinary", "sound"]).optional(),
    sourceDirection: direction,
    renderDirection: direction,
    fontSizePx: size,
    reviewStatus: z.enum(["draft", "needs_review", "reviewed"]).optional(),
    hasGeneratedLettering: flag,
  })
  .strict();
const image = z
  .object({
    ...target,
    kind: z.enum(["source-crop", "rendered-page"]),
    sourceWidth: size,
    sourceHeight: size,
    width: size,
    height: size,
    crop: rect.nullable(),
    pixelMapping: z
      .object({
        originX: z.number(),
        originY: z.number(),
        scaleX: size,
        scaleY: size,
      })
      .strict(),
  })
  .strict();

const jobTarget = z
  .object({
    chapterId: text,
    pageId: text,
    blockId: text.optional(),
    contextMode: z.enum(["none", "saved"]).optional(),
    revision,
    requestId: text.uuid(),
  })
  .strict();

const mcpJobReceiptOutput = z
  .object({
    target: z.union([jobTarget, McpContextResearchTargetSchema]).optional(),
    persistence: z.enum(["durable", "memory"]),
    jobId: text.uuid(),
    requestId: text,
    kind: text,
    status: z.enum([
      "running",
      "completed",
      "partial",
      "failed",
      "cancelled",
      "interrupted",
    ]),
    cancellationRequested: flag,
    progress: z
      .object({
        phase: text,
        completed: count.optional(),
        total: count.optional(),
      })
      .strict(),
    result: mcpJobResultMetadataSchema.strict().optional(),
    error: z.object({ code: text, message: text }).strict().optional(),
    startedAt: count,
    finishedAt: count.optional(),
  })
  .strict();

/** Public projections only. JSON Schema and runtime validation share these definitions. */
export const mcpOutputSchemas: Record<string, z.ZodType> = {
  ...mcpReviewOutputSchemas,
  ...mcpStructureOutputs,
  ...mcpTranslationBatchOutputs,
  ...mcpContextOutputSchemas,
  ...mcpErasureRecoveryOutputs,
  carrot_update_block_source_rect: McpSourceRectResultSchema,
  carrot_get_server_info: z
    .object({
      serverId: text.regex(/^[a-f0-9]{64}$/),
      dataProfileId: text.regex(/^[a-f0-9]{64}$/),
      runtimeId: text.uuid(),
      startedAt: count,
      appVersion: text,
      resource: text.url(),
      mode: z.enum(["development", "installed"]),
      serverVersion: text,
      protocolVersion: text,
      authorizationStorage: text,
      dataScope: text,
      autoTransferAuthorization: z.literal(false),
    })
    .strict(),
  carrot_get_capabilities: z
    .object({
      mode: text,
      features: z.array(text),
      editing: flag,
      translation: flag,
      ocr: flag,
      erasure: flag,
      pngExport: flag,
      imageTransfer: flag,
      imageRedaction: text,
      sampling: flag,
      oauth: flag,
    })
    .strict(),
  carrot_list_works: z
    .object({
      ...window,
      works: z.array(
        z
          .object({
            id: text,
            title: text,
            chapterCount: count,
            updatedAt: text,
          })
          .strict(),
      ),
    })
    .strict(),
  carrot_list_chapters: z
    .object({
      ...window,
      workId: text,
      chapters: z.array(
        z
          .object({
            id: text,
            title: text,
            status: text,
            pageCount: count,
            updatedAt: text,
          })
          .strict(),
      ),
    })
    .strict(),
  carrot_get_chapter: z
    .object({
      ...window,
      id: text,
      workId: text,
      title: text,
      status: text,
      updatedAt: text,
      pages: z.array(
        z
          .object({
            id: text,
            name: text,
            width: size,
            height: size,
            analysisStatus: text,
            blockCount: count,
            updatedAt: text,
          })
          .strict(),
      ),
    })
    .strict(),
  carrot_get_page_blocks: z
    .object({
      ...target,
      ...window,
      width: size,
      height: size,
      blockOrder: z.array(text).optional(),
      effectiveBlockOrder: z.array(text).optional(),
      blocks: z.array(block),
    })
    .strict(),
  carrot_get_page_preview: z
    .object({
      pageId: text,
      updatedAt: text,
      sourceWidth: size,
      sourceHeight: size,
      previewWidth: size,
      previewHeight: size,
    })
    .strict(),
  carrot_get_page_crop: image,
  carrot_render_page_preview: image,
  carrot_get_work_context: z
    .object({
      ...window,
      chapterId: text,
      workId: text,
      workTitle: text,
      revision: text,
      section: z.enum(["overview", "glossary", "characters", "memory"]),
      rules: z
        .object({ honorifics: text, sfxMode: text, defaultTone: text })
        .strict(),
      counts: z
        .object({ glossary: count, characters: count, memory: count })
        .strict(),
      entries: z.array(z.record(text, z.unknown())),
      note: text,
    })
    .strict(),
  carrot_create_page_blocks: z
    .object({
      status: z.enum(["saved", "already_applied"]),
      revision,
      blockIds: z.array(text),
    })
    .strict(),
  carrot_update_page_blocks: z
    .object({
      status: z.enum(["saved", "already_applied"]),
      revision,
      changedBlockIds: z.array(text),
      blocks: z.array(block),
      warnings: z.array(text),
    })
    .strict(),
  carrot_set_page_reading_order: z
    .object({
      status: z.enum(["saved", "already_applied"]),
      revision,
      changed: flag,
      blockOrder: z.array(text),
      previousBlockOrder: z.array(text),
    })
    .strict(),
  carrot_update_translations: z
    .object({
      status: z.enum(["saved", "already_applied"]),
      revision,
      changed: count,
      previousTranslations: z.array(
        z
          .object({
            blockId: text,
            translatedText: text,
          })
          .strict(),
      ),
    })
    .strict(),
  carrot_list_jobs: z
    .object({ ...window, jobs: z.array(mcpJobReceiptOutput) })
    .strict(),
  carrot_retry_job: mcpJobReceiptOutput,
  carrot_get_job_file: z
    .object({
      jobId: text.uuid(),
      kind: z.literal("rendered-page-png"),
      url: text.url(),
      bytes: count,
      mimeType: z.literal("image/png"),
      sha256: text,
      expiresAt: count,
      access: text,
    })
    .passthrough(),
  carrot_get_job: mcpJobReceiptOutput,
  carrot_cancel_job: mcpJobReceiptOutput,
  carrot_export_page_png: mcpJobReceiptOutput,
  carrot_run_page_ocr: mcpJobReceiptOutput,
  carrot_run_block_ocr: mcpJobReceiptOutput,
  carrot_run_block_translation: mcpJobReceiptOutput,
  carrot_run_context_research: mcpJobReceiptOutput,
  carrot_run_page_erasure: mcpJobReceiptOutput,
};

const errorSchema = z
  .object({
    error: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    nextAction: z.string(),
  })
  .strict();
const schemas = new Map<string, Record<string, unknown>>();

export function mcpToolOutputSchema(
  name: string,
): Record<string, unknown> | undefined {
  const schema = mcpOutputSchemas[name];
  if (!schema) return undefined;
  let result = schemas.get(name);
  if (!result) {
    result = {
      ...z.toJSONSchema(z.union([schema, errorSchema])),
      type: "object",
    };
    schemas.set(name, result);
  }
  return result;
}
