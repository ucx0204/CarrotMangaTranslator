import { z } from "zod/v4";
import {
  McpCompositeWorkflowActionKindSchema,
  McpCompositeWorkflowActionSchema,
  McpCompositeImportActionSchema,
} from "./mcpCompositeWorkflowActions";

const MCP_COMPOSITE_PHASES = 32;
export const MCP_COMPOSITE_RECEIPTS = 128;
export const MCP_COMPOSITE_BYTES = 1024 * 1024;
export const McpCompositeIdentifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/);
export const McpCompositeFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const McpCompositeCountSchema = z.number().int().nonnegative();
const id = McpCompositeIdentifierSchema;
const count = McpCompositeCountSchema;
export const McpCompositePageSchema = z
  .object({
    workId: id,
    chapterId: id,
    pageId: id,
    /** Empty means explicitly the whole saved page; nonempty restricts later edits to those blocks. */
    blockIds: z
      .array(id)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();
export type McpCompositePage = z.infer<typeof McpCompositePageSchema>;
export const McpCompositePagesSchema = z
  .array(McpCompositePageSchema)
  .min(1)
  .max(50)
  .superRefine((pages, context) => {
    const keys = pages.map((page) => `${page.chapterId}/${page.pageId}`);
    if (
      new Set(keys).size !== pages.length ||
      new Set(pages.map((page) => page.chapterId)).size > 10
    )
      context.addIssue({
        code: "custom",
        message: "Use distinct qualified pages in at most ten chapters.",
      });
  });
/** Imported page IDs are resolved only from the exact native reviewed-item receipt. */
const McpCompositeImportedTargetsSchema = z
  .object({
    kind: z.literal("reviewed-import"),
    phaseId: id,
    selectionFingerprint: McpCompositeFingerprintSchema,
    itemKeys: z
      .array(McpCompositeFingerprintSchema)
      .min(1)
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length),
    maxChapters: count.min(1).max(10),
    maxPages: count.min(1).max(50),
  })
  .strict();
const McpCompositeTargetEnvelopeSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("saved"), pages: McpCompositePagesSchema })
    .strict(),
  McpCompositeImportedTargetsSchema,
]);
/** Read-only native source review; does not reserve or execute the supplied import action. */
export const McpCompositeImportPreflightSchema = z
  .object({ phaseId: id, action: McpCompositeImportActionSchema })
  .strict();
export const McpCompositeImportPreflightOutputSchema =
  McpCompositeImportedTargetsSchema;
export type McpCompositeImportPreflight = z.infer<
  typeof McpCompositeImportPreflightSchema
>;
export type McpCompositeImportedTargets = z.infer<
  typeof McpCompositeImportedTargetsSchema
>;
const McpCompositeModelBudgetSchema = z
  .object({
    ocr: count.max(5000).default(0),
    translation: count.max(5000).default(0),
    erase: count.max(5000).default(0),
    research: count.max(30).default(0),
    typography: count.max(5000).default(0),
    soundEffect: count.max(5000).default(0),
  })
  .strict();
export const McpCompositeBudgetSchema = z
  .object({
    admissions: count.min(1).max(500).default(32),
    pageAttempts: count.max(500).default(0),
    translationRequests: count.max(5000).default(0),
    researchAttempts: count.max(30).default(0),
    selectedEdits: count.max(5000).default(0),
    models: McpCompositeModelBudgetSchema,
  })
  .strict();
export type McpCompositeBudget = z.infer<typeof McpCompositeBudgetSchema>;
export const McpCompositePhaseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("native"),
      id,
      action: McpCompositeWorkflowActionKindSchema,
      role: z.enum(["work", "correction"]).default("work"),
    })
    .strict(),
  z.object({ kind: z.literal("review"), id }).strict(),
]);
export const McpCompositePrepareSchema = z
  .object({
    requestId: z.uuid(),
    reason: z.string().trim().min(1).max(1000),
    targets: McpCompositeTargetEnvelopeSchema,
    phases: z.array(McpCompositePhaseSchema).min(1).max(MCP_COMPOSITE_PHASES),
    maxReviewPasses: count.min(1).max(3).default(1),
    budgets: McpCompositeBudgetSchema,
  })
  .strict()
  .superRefine((plan, context) => {
    if (
      new Set(plan.phases.map((phase) => phase.id)).size !== plan.phases.length
    )
      context.addIssue({
        code: "custom",
        message: "Phase IDs must be distinct.",
      });
    if (
      plan.phases.filter((phase) => phase.kind === "review").length >
      plan.maxReviewPasses
    )
      context.addIssue({
        code: "custom",
        message: "Review phases exceed the explicitly authorized pass budget.",
      });
    const target = plan.targets;
    if (
      target.kind === "reviewed-import" &&
      !plan.phases.some(
        (phase, index) =>
          index === 0 &&
          phase.id === target.phaseId &&
          phase.kind === "native" &&
          ["import-create", "work-file-import"].includes(phase.action),
      )
    )
      context.addIssue({
        code: "custom",
        message: "The exact reviewed import must be the first phase.",
      });
  });
export type McpCompositePrepare = z.infer<typeof McpCompositePrepareSchema>;
export const McpCompositeMutationSchema = z
  .object({ id: z.uuid(), version: count, requestId: z.uuid() })
  .strict();
export const McpCompositeChildReferenceSchema = z
  .object({
    kind: z.enum([
      "job",
      "workflow",
      "research-batch",
      "import-batch",
      "import",
      "work-file-import",
      "batch",
      "context",
      "output",
    ]),
    id,
    requestId: z.uuid(),
    family: McpCompositeWorkflowActionKindSchema,
    inputFingerprint: McpCompositeFingerprintSchema,
  })
  .strict();
export type McpCompositeChildReference = z.infer<
  typeof McpCompositeChildReferenceSchema
>;
export const McpCompositeBindSchema = McpCompositeMutationSchema.extend({
  phaseId: id,
  action: McpCompositeWorkflowActionSchema,
  expectedSnapshot: McpCompositeFingerprintSchema,
  predecessorReceipts: z
    .array(McpCompositeChildReferenceSchema)
    .max(MCP_COMPOSITE_PHASES),
});
export type McpCompositeBind = z.infer<typeof McpCompositeBindSchema>;
