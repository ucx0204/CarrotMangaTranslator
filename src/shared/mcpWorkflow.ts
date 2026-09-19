import { z } from "zod/v4";
import { McpSelectionTranslationSchema } from "./mcpSelectionAnalysis";
import {
  McpRecoveryActionSchema,
  McpRetentionListSchema,
} from "./mcpRetention";

const target = McpRecoveryActionSchema.shape.pages.element;
const count = z.number().int().nonnegative();
const translation = McpSelectionTranslationSchema.omit({
  chapterId: true,
  contextRevision: true,
  requestId: true,
  pages: true,
})
  .extend({ kind: z.literal("translate") })
  .strict();
const stage = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("ocr"), allowAssetDownloads: z.literal(true) })
    .strict(),
  translation,
  z
    .object({ kind: z.literal("erase"), allowAssetDownloads: z.literal(true) })
    .strict(),
  z.object({ kind: z.literal("export-png") }).strict(),
  z
    .object({
      kind: z.literal("await-external"),
      purpose: z.enum(["reading", "translation", "image"]),
    })
    .strict(),
]);
export type McpWorkflowStage = z.infer<typeof stage>;
export const McpWorkflowPrepareSchema = z
  .object({
    requestId: z.uuid(),
    reason: z.string().trim().min(1).max(1000),
    chapters: z
      .array(
        z
          .object({
            chapterId: target.shape.chapterId,
            pages: z
              .array(target.omit({ chapterId: true, reviewRevision: true }))
              .min(1)
              .max(50),
          })
          .strict(),
      )
      .min(1)
      .max(10),
    stages: z.array(stage).min(1).max(5),
    maxPageAttempts: count.min(1).max(500).default(200),
    maxTranslationRequests: count.max(5000).default(100),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.chapters.reduce((n, chapter) => n + chapter.pages.length, 0) > 50)
      ctx.addIssue({
        code: "custom",
        message: "At most 50 explicit pages per workflow.",
      });
    if (
      new Set(input.chapters.map((chapter) => chapter.chapterId)).size !==
      input.chapters.length
    )
      ctx.addIssue({ code: "custom", message: "Chapters must be unique." });
    for (const chapter of input.chapters)
      if (
        new Set(chapter.pages.map((page) => page.pageId)).size !==
        chapter.pages.length
      )
        ctx.addIssue({
          code: "custom",
          message: "Pages must be unique within each chapter.",
        });
    if (
      new Set(input.stages.map((item) => item.kind)).size !==
      input.stages.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Specify each stage at most once, in execution order.",
      });
  });
export type McpWorkflowPrepare = z.infer<typeof McpWorkflowPrepareSchema>;
export const McpWorkflowGetSchema = z.object({ id: z.uuid() }).strict();
export const McpWorkflowRunSchema = z
  .object({
    id: z.uuid(),
    version: count,
    requestId: z.uuid(),
    retryFailed: z.boolean().default(false),
  })
  .strict();
export type McpWorkflowRun = z.infer<typeof McpWorkflowRunSchema>;
export const McpWorkflowExternalSchema = z
  .object({
    id: z.uuid(),
    version: count,
    requestId: z.uuid(),
    page: target,
  })
  .strict();
export type McpWorkflowExternal = z.infer<typeof McpWorkflowExternalSchema>;
export const McpWorkflowDiscardSchema = z
  .object({ id: z.uuid(), confirm: z.literal(true) })
  .strict();
export const McpWorkflowListSchema = McpRetentionListSchema;
const status = z.enum([
  "prepared",
  "running",
  "paused",
  "waiting_external",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const step = z
  .object({
    index: count,
    stage: stage.options[0].shape.kind.or(
      z.enum(["translate", "erase", "export-png", "await-external"]),
    ),
    chapterId: target.shape.chapterId,
    pageId: target.shape.pageId,
    status: z.enum([
      "pending",
      "running",
      "completed",
      "failed",
      "waiting_external",
    ]),
    attempts: count,
    jobId: z.uuid().nullable(),
    outputId: z.uuid().nullable(),
    changeId: z.uuid().nullable(),
    errorCode: z.string().max(128).nullable(),
  })
  .strict();
const summary = z
  .object({
    id: z.uuid(),
    version: count,
    reason: z.string(),
    status,
    createdAt: count,
    expiresAt: count,
    pageCount: count,
    stages: z.array(stage).max(5),
    completedSteps: count,
    totalSteps: count,
    pageAttemptsUsed: count,
    translationRequestsReserved: count,
    maxPageAttempts: count,
    maxTranslationRequests: count,
    pauseRequested: z.boolean(),
    cancellationRequested: z.boolean(),
    activeStep: count.nullable(),
    lastError: z.string().max(128).nullable(),
    warnings: z.array(z.string()).max(20),
  })
  .strict();
const view = summary
  .extend({
    pages: z.array(target).max(50),
    steps: z.array(step).max(250),
  })
  .strict();
export type McpWorkflowView = z.infer<typeof view>;
export const mcpWorkflowOutputs = {
  carrot_prepare_workflow: view,
  carrot_get_workflow: view,
  carrot_run_workflow: view,
  carrot_resume_workflow: view,
  carrot_pause_workflow: view,
  carrot_cancel_workflow: view,
  carrot_accept_workflow_external: view,
  carrot_list_workflows: z
    .object({
      total: count,
      offset: count,
      limit: count,
      nextOffset: count.nullable(),
      snapshot: z.string().regex(/^[a-f0-9]{16}$/),
      items: z.array(summary).max(25),
    })
    .strict(),
  carrot_discard_workflow: z
    .object({
      id: z.uuid(),
      status: z.literal("discarded"),
      pageChanges: z.literal(0),
    })
    .strict(),
};
