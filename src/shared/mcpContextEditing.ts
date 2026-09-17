import { z } from "zod/v4";
import {
  CharacterProfileSchema,
  GlossaryEntrySchema,
} from "./ipcWorkContextSchemas";
import { hashStableValue } from "./blockFingerprint";
import type { ChapterStoryMemory, WorkStyleGuide } from "./workContextTypes";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const entryId = z.string().min(1).max(200);
const revision = z.string().regex(/^[a-f0-9]{16}$/);
const aliases = z.array(z.string().max(200)).max(50);
const glossaryFields = z
  .object({
    source: z.string().trim().min(1).max(400).optional(),
    target: z.string().max(400).optional(),
    category: z.enum(GlossaryEntrySchema.shape.category.options).optional(),
    aliases: aliases.optional(),
    note: z.string().max(2000).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
const characterFields = z
  .object({
    displayName: z.string().trim().min(1).max(200).optional(),
    sourceNames: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
    targetName: z.string().max(200).optional(),
    aliases: aliases.optional(),
    speechStyle: z
      .enum(CharacterProfileSchema.shape.speechStyle.options)
      .optional(),
    customSpeechStyle: z.string().max(1000).optional(),
    note: z.string().max(2000).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
const rulesFields = z
  .object({
    honorifics: z.enum(["preserve", "adapt", "drop"]).optional(),
    sfxMode: z.enum(["preserve", "translate", "note"]).optional(),
    defaultTone: z.enum(["natural_korean", "literal"]).optional(),
  })
  .strict();
const memoryFields = z
  .object({
    summary: z.string().max(1200).optional(),
    visualSummary: z.string().max(1200).optional(),
    glossaryEntryIds: z.array(entryId).max(100).optional(),
    characterIds: z.array(entryId).max(100).optional(),
  })
  .strict();
const common = { changeId: id };
const glossaryChange = z
  .object({
    ...common,
    entity: z.literal("glossary"),
    entryId: entryId.optional(),
    values: glossaryFields,
  })
  .strict();
const characterChange = z
  .object({
    ...common,
    entity: z.literal("character"),
    entryId: entryId.optional(),
    values: characterFields,
  })
  .strict();
const McpContextChangeSchema = z.discriminatedUnion("entity", [
  glossaryChange,
  characterChange,
  z
    .object({ ...common, entity: z.literal("rules"), values: rulesFields })
    .strict(),
  z
    .object({
      ...common,
      entity: z.literal("memory"),
      pageId: id,
      pageRevision: z.string().regex(/^page-v1:[a-f0-9]{16}$/),
      values: memoryFields,
    })
    .strict(),
]);
export type McpContextChange = z.infer<typeof McpContextChangeSchema>;

const target = { chapterId: id, revision, requestId: z.string().uuid() };
export const McpContextPreviewSchema = z
  .object({
    ...target,
    changes: z.array(McpContextChangeSchema).min(1).max(100),
  })
  .strict();
export type McpContextPreview = z.infer<typeof McpContextPreviewSchema>;

const source = z
  .object({
    title: z.string().min(1).max(500),
    url: z
      .string()
      .url()
      .max(2048)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            ["https:", "http:"].includes(url.protocol) &&
            !url.username &&
            !url.password
          );
        } catch (_error) {
          return false;
        }
      }),
  })
  .strict();
export const McpExternalResearchSchema = z
  .object({
    ...target,
    changes: z
      .array(
        z
          .object({
            change: z.discriminatedUnion("entity", [
              glossaryChange,
              characterChange,
            ]),
            reason: z.string().min(1).max(2000),
            sources: z.array(source).min(1).max(20),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export const McpContextApplySchema = z
  .object({
    proposalId: z.string().uuid(),
    requestId: z.string().uuid(),
    selectedChangeIds: z.array(id).min(1).max(100),
  })
  .strict();
export const McpContextInspectSchema = z
  .object({
    proposalId: z.string().uuid(),
    offset: z.number().int().min(0).max(1_000_000).default(0),
    limit: z.number().int().min(1).max(25).default(10),
  })
  .strict();
export const McpContextResearchTargetSchema = z
  .object({
    ...target,
    researchTitle: z.string().trim().min(1).max(200),
    engine: z.enum(["tavily", "codex-web"]),
  })
  .strict();
export type McpContextResearchTarget = z.infer<
  typeof McpContextResearchTargetSchema
>;

const proposalMetadata = z
  .object({
    proposalId: z.string().uuid(),
    chapterId: id,
    workId: id,
    revision,
    source: z.enum(["edit", "external-research", "app-research"]),
    changeIds: z.array(id).max(100),
    expiresAt: z.number().int().nonnegative(),
    warnings: z.array(z.string().max(2000)).max(100),
  })
  .strict();
export const McpContextResearchResultSchema = proposalMetadata
  .extend({
    queryCount: z.number().int().nonnegative(),
    sourceCount: z.number().int().nonnegative(),
    tavilyCreditsUsed: z.number().nonnegative(),
  })
  .strict();
const summary = z
  .object({
    changeId: id,
    entity: z.enum(["glossary", "character", "rules", "memory"]),
    targetId: entryId,
    changed: z.boolean(),
    before: z.record(z.string(), z.json()).nullable(),
    after: z.record(z.string(), z.json()),
    reason: z.string().max(2000).optional(),
    sources: z.array(source).max(20).optional(),
  })
  .strict();
export type McpContextChangeSummary = z.infer<typeof summary>;
export const mcpContextOutputSchemas = {
  carrot_preview_context_edit: proposalMetadata,
  carrot_preview_context_research: proposalMetadata,
  carrot_get_context_proposal: proposalMetadata
    .extend({
      total: z.number().int().nonnegative(),
      offset: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
      nextOffset: z.number().int().nonnegative().nullable(),
      changes: z.array(summary).max(25),
    })
    .strict(),
  carrot_apply_context_proposal: z
    .object({
      proposalId: z.string().uuid(),
      requestId: z.string().uuid(),
      status: z.enum(["applied", "already_applied"]),
      previousRevision: revision,
      revision,
      changesApplied: z.number().int().nonnegative(),
      selectedChangeIds: z.array(id).max(100),
      pagesChanged: z.literal(0),
      note: z.string().max(1000),
    })
    .strict(),
};

/** Root timestamps of absent default files are generated on every read. A read
 * revision identifies content, never those transient defaults. Entry timestamps
 * and all memory evidence remain part of the fingerprint. */
export function mcpContextRevision(context: {
  workId: string;
  workTitle: string;
  styleGuide: WorkStyleGuide;
  storyMemory: ChapterStoryMemory;
}): string {
  const {
    createdAt: _created,
    updatedAt: _updated,
    ...guide
  } = context.styleGuide;
  const { updatedAt: _memoryUpdated, ...memory } = context.storyMemory;
  return hashStableValue({
    workId: context.workId,
    workTitle: context.workTitle,
    guide,
    memory,
  });
}
