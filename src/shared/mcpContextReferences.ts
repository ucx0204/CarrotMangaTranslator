import { z } from "zod/v4";
import type { ChapterSnapshot } from "./libraryTypes";
import type { ChapterStoryMemory, WorkStyleGuide } from "./workContextTypes";

export const MCP_CONTEXT_GRAPH_CHAPTERS = 100;
export const MCP_CONTEXT_GRAPH_PAGES = 1000;
export const MCP_CONTEXT_GRAPH_BLOCKS = 100000;
export const MCP_CONTEXT_GRAPH_REFERENCES = 200000;

/** Native saved data only; this snapshot is never accepted from a remote caller. */
export type McpContextReferenceSnapshot = {
  workId: string;
  workTitle: string;
  styleGuide: WorkStyleGuide;
  chapters: Array<{
    chapter: ChapterSnapshot;
    storyMemory: ChapterStoryMemory;
  }>;
};

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const entryId = z.string().min(1).max(200);
const count = z.number().int().nonnegative();
const entity = z.enum(["character", "glossary"]);
const referenceStatus = z.enum(["active", "disabled", "missing", "ambiguous"]);

export const McpContextReferencesSchema = z
  .object({
    chapterId: id,
    entity: entity.optional(),
    entryIds: z.array(entryId).min(1).max(100).optional(),
    issuesOnly: z.boolean().default(false),
    offset: count.max(MCP_CONTEXT_GRAPH_REFERENCES).default(0),
    limit: count.min(1).max(100).default(50),
    snapshot: z
      .string()
      .regex(/^[a-f0-9]{16}$/)
      .optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.offset > 0 && !input.snapshot)
      context.addIssue({
        code: "custom",
        message: "Continuation requires the first result's snapshot.",
      });
    if (
      input.entryIds &&
      new Set(input.entryIds).size !== input.entryIds.length
    )
      context.addIssue({
        code: "custom",
        message: "Entry IDs must be distinct.",
      });
  });
export type McpContextReferences = z.infer<typeof McpContextReferencesSchema>;

const reference = z
  .object({
    chapterId: id,
    pageId: id,
    blockId: entryId.nullable(),
    memoryIndex: count.nullable(),
    kind: z.enum([
      "block-speaker",
      "block-glossary",
      "memory-character",
      "memory-glossary",
    ]),
    entity,
    entryId,
    status: referenceStatus,
    duplicate: z.boolean(),
    orphanedMemory: z.boolean(),
  })
  .strict();
export type McpContextReference = z.infer<typeof reference>;

export const mcpContextReferenceOutputs = {
  carrot_get_context_references: z
    .object({
      workId: id,
      anchorChapterId: id,
      snapshot: z.string().regex(/^[a-f0-9]{16}$/),
      total: count,
      offset: count,
      limit: count.min(1).max(100),
      nextOffset: count.nullable(),
      counts: z
        .object({
          chapters: count,
          pages: count,
          blocks: count,
          memories: count,
          references: count,
          active: count,
          disabled: count,
          missing: count,
          ambiguous: count,
          duplicateReferences: count,
          orphanedMemories: count,
          duplicateMemories: count,
        })
        .strict(),
      references: z.array(reference).max(100),
      pagesChanged: z.literal(0),
      note: z.string().max(1000),
    })
    .strict(),
};
