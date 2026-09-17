import { z } from "zod/v4";
import { McpBlockOcrTargetSchema } from "./mcpBlockOcr";

/** Same explicit saved-block target, but no OCR or page mutation. */
export const McpBlockTranslationTargetSchema = McpBlockOcrTargetSchema.extend({
  contextMode: z.enum(["none", "saved"]).default("saved"),
});
export type McpBlockTranslationTarget = z.infer<
  typeof McpBlockTranslationTargetSchema
>;

/** Model output is never a page object or an instruction to run tools. */
export const McpBlockTranslationReplySchema = z
  .object({
    blockId: McpBlockOcrTargetSchema.shape.blockId,
    translatedText: z.string().max(8192).refine((text) => text.trim().length > 0),
  })
  .strict();

/** Transient evidence; the durable journal retains only public job metadata. */
export const McpBlockTranslationProposalSchema = z
  .object({
    sourceText: z.string().max(20_000),
    previousTranslatedText: z.string().max(20_000),
    translatedText: McpBlockTranslationReplySchema.shape.translatedText,
    sourceLanguage: z.string().max(40),
    targetLanguage: z.string().max(40),
    model: z.string().min(1).max(256),
    execution: z.enum(["local", "external"]),
    contextMode: z.enum(["none", "saved"]),
    contextRevision: z.string().regex(/^[a-f0-9]{16}$/),
    differs: z.boolean(),
    requestCount: z.literal(1),
    warnings: z.array(z.enum([
      "review_before_apply",
      "same_as_source",
      "generated_lettering_retained",
      "context_budget_pruned",
      "saved_context_may_have_changed",
    ])).max(5),
  })
  .strict();
export type McpBlockTranslationProposal = z.infer<
  typeof McpBlockTranslationProposalSchema
>;
