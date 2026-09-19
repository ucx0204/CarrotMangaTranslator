import { z } from "zod/v4";
import { McpSourceRectPatchSchema } from "./mcpSourceRect";
import { mcpTranslationBatchOutputs } from "./mcpTranslationBatch";

const { chapterId, pageId, blockId, revision, sourceRect } =
  McpSourceRectPatchSchema.shape;
const regionId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const text = z.string().max(2000);
const blockIds = z
  .array(blockId)
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length);
const decision = z
  .object({
    regionId,
    action: z.enum(["include", "exclude", "restore"]),
    sourceRect: sourceRect.optional(),
  })
  .strict();
const command = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("review"),
      decisions: z.array(decision).max(100).default([]),
      additions: z
        .array(z.object({ key: regionId, sourceRect }).strict())
        .max(100)
        .default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("materialize"),
      entries: z
        .array(
          z
            .object({
              regionId,
              sourceText: text.trim().min(1),
              translatedText: text.default(""),
              allowOverlap: z.boolean().default(false),
            })
            .strict(),
        )
        .min(1)
        .max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("text"),
      edits: z
        .array(
          z
            .object({
              blockId,
              sourceText: text.optional(),
              translatedText: text.optional(),
            })
            .strict()
            .refine(
              (edit) =>
                edit.sourceText !== undefined ||
                edit.translatedText !== undefined,
            ),
        )
        .min(1)
        .max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("image-state"),
      blockIds,
      state: z.enum(["enable", "disable", "remove"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("generate"),
      blockIds: blockIds.refine((ids) => ids.length <= 10),
      expectedProvider: z.literal("codex"),
      expectedModel: z.string().trim().min(1).max(128),
      allowExternalProcessing: z.boolean().default(false),
      replaceExisting: z.boolean().default(false),
      allowRenderAdjustment: z.boolean().default(false),
      invertColors: z.boolean().default(false),
    })
    .strict(),
]);
export const McpSoundEffectPrepareSchema = z
  .object({
    chapterId,
    pageId,
    revision,
    reviewRevision: revision,
    contextRevision: z.string().regex(/^[a-f0-9]{16}$/),
    requestId: z.uuid(),
    reason: z.string().trim().min(1).max(2000),
    command,
  })
  .strict();
export type McpSoundEffectPrepare = z.infer<typeof McpSoundEffectPrepareSchema>;
export const McpSoundEffectReadSchema = z
  .object({
    chapterId,
    pageId,
    reviewRevision: revision.optional(),
    offset: z.number().int().min(0).max(10000).default(0),
    limit: z.number().int().min(1).max(25).default(25),
  })
  .strict()
  .refine((value) => !value.offset || value.reviewRevision !== undefined);
export const McpSoundEffectImageSchema = z
  .object({ batchId: z.uuid(), blockId })
  .strict();
export const McpSoundEffectPlanReferenceSchema = z
  .object({
    batchId: z.uuid(),
    expiresAt: z.number().int().nonnegative(),
    generationCalls: z.number().int().nonnegative(),
    failedItems: z.number().int().nonnegative(),
  })
  .strict();
const state = z
  .object({
    sourceText: z.string().max(20000),
    translatedText: z.string().max(20000),
    state: z.string(),
    sourceRect: sourceRect.optional(),
    renderRect: sourceRect.optional(),
    imageState: z.enum(["none", "active", "disabled", "stale"]),
    generationBlocked: z.boolean(),
  })
  .strict();
const item = z
  .object({
    id: z.string(),
    kind: z.enum(["candidate", "block"]),
    blockId: z.string().nullable(),
    ...state.shape,
  })
  .strict();
export type McpSoundEffectItem = z.infer<typeof item>;
const change = z
  .object({
    pageId,
    id: z.string(),
    action: z.string(),
    before: state.nullable(),
    after: state.nullable(),
    changed: z.boolean(),
    excludedReason: z.string().nullable(),
    warnings: z.array(z.string()),
  })
  .strict();
export type McpSoundEffectChange = z.infer<typeof change>;
export const mcpSoundEffectOutputs = {
  carrot_get_sound_effects: z
    .object({
      chapterId,
      pageId,
      revision,
      reviewRevision: revision,
      contextRevision: z.string().regex(/^[a-f0-9]{16}$/),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      total: z.number().int().nonnegative(),
      offset: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
      nextOffset: z.number().int().nonnegative().nullable(),
      items: z.array(item).max(25),
      generation: z
        .object({
          provider: z.literal("codex"),
          configuredModel: z.string(),
          runtimeChecked: z.literal(false),
        })
        .strict(),
      warnings: z.array(z.string()),
    })
    .strict(),
  carrot_get_sound_effect_batch:
    mcpTranslationBatchOutputs.carrot_get_translation_batch
      .extend({ changes: z.array(change).max(25) })
      .strict(),
  carrot_apply_sound_effect_batch:
    mcpTranslationBatchOutputs.carrot_apply_translation_batch,
  carrot_undo_sound_effect_batch:
    mcpTranslationBatchOutputs.carrot_undo_translation_batch,
  carrot_redo_sound_effect_batch:
    mcpTranslationBatchOutputs.carrot_redo_translation_batch,
  carrot_cancel_sound_effect_batch:
    mcpTranslationBatchOutputs.carrot_cancel_translation_batch,
  carrot_get_sound_effect_image: z
    .object({
      batchId: z.uuid(),
      blockId,
      kind: z.literal("sound-effect-asset"),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      previewWidth: z.number().int().positive(),
      previewHeight: z.number().int().positive(),
      note: z.string(),
    })
    .strict(),
};
