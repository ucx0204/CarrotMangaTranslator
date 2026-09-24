import { z } from "zod";
import type { TranslationBlock } from "./textTypes";
import { TranslationBlockSchema } from "./ipcSchemaPrimitives";
import {
  WorkStyleGuideSchema,
  ChapterStoryMemorySchema,
} from "./ipcWorkContextSchemas";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const fingerprint = z.string().regex(/^[a-f0-9]{16}$/);
const count = z.number().int().nonnegative();
const references = TranslationBlockSchema.innerType()
  .pick({
    speakerId: true,
    glossaryEntryIds: true,
  })
  .strict();
export type ContextBlockReferences = z.infer<typeof references>;
const block = z
  .object({
    blockId: z.string().min(1).max(200),
    before: references,
    after: references,
  })
  .strict();
export const ContextMigrationDeltaSchema = z
  .object({
    guide: z
      .object({ before: WorkStyleGuideSchema, after: WorkStyleGuideSchema })
      .strict()
      .optional(),
    memories: z
      .array(
        z
          .object({
            chapterId: id,
            beforePresent: z.boolean().optional(),
            before: ChapterStoryMemorySchema,
            after: ChapterStoryMemorySchema,
          })
          .strict(),
      )
      .max(100),
    pages: z
      .array(
        z
          .object({
            chapterId: id,
            pageId: id,
            blocks: z.array(block).min(1).max(100000),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict()
  .superRefine((delta, context) => {
    const pageKeys = delta.pages.map(
      (page) => `${page.chapterId}/${page.pageId}`,
    );
    if (
      new Set(pageKeys).size !== pageKeys.length ||
      new Set(delta.memories.map((memory) => memory.chapterId)).size !==
        delta.memories.length ||
      delta.pages.some(
        (page) =>
          new Set(page.blocks.map((item) => item.blockId)).size !==
          page.blocks.length,
      )
    )
      context.addIssue({
        code: "custom",
        message: "Duplicate context migration targets.",
      });
  });
export type ContextMigrationDelta = z.infer<typeof ContextMigrationDeltaSchema>;

/** Private native record. No transport accepts this shape, raw pages, or file paths. */
export const RetainedContextMigrationSchema = z
  .object({
    format: z.literal(1),
    id: z.string().uuid(),
    owner: id,
    workId: id,
    anchorChapterId: id,
    requestId: z.string().uuid(),
    signature: fingerprint,
    operation: z
      .enum([
        "carrot_apply_memory_refresh",
        "carrot_apply_context_proposal",
        "carrot_apply_context_import",
      ])
      .optional(),
    createdAt: count,
    expiresAt: count,
    beforeSnapshot: fingerprint,
    afterSnapshot: fingerprint,
    guideBeforePresent: z.boolean(),
    delta: ContextMigrationDeltaSchema,
    actions: z
      .array(
        z
          .object({
            requestId: z.string().uuid(),
            signature: fingerprint,
            direction: z.enum(["undo", "redo"]),
            referenceSnapshot: fingerprint,
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
export type RetainedContextMigration = z.infer<
  typeof RetainedContextMigrationSchema
>;

export function contextBlockReferences(
  block: Pick<TranslationBlock, "speakerId" | "glossaryEntryIds">,
): ContextBlockReferences {
  return {
    ...(block.speakerId !== undefined ? { speakerId: block.speakerId } : {}),
    ...(block.glossaryEntryIds !== undefined
      ? { glossaryEntryIds: [...block.glossaryEntryIds] }
      : {}),
  };
}
export function restoreContextBlockReferences<
  T extends Pick<TranslationBlock, "speakerId" | "glossaryEntryIds">,
>(block: T, fields: ContextBlockReferences): T {
  const next = { ...block };
  delete next.speakerId;
  delete next.glossaryEntryIds;
  return Object.assign(next, structuredClone(fields));
}
