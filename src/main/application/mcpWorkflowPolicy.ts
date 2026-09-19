import { z } from "zod/v4";
import {
  McpWorkflowPrepareSchema,
  mcpWorkflowOutputs,
} from "../../shared/mcpWorkflow";
import { hashStableValue } from "../../shared/blockFingerprint";
import { McpEditError } from "./mcpEditPolicy";

const publicView = mcpWorkflowOutputs.carrot_get_workflow;
const hash = z.string().regex(/^[a-f0-9]{16}$/);
export const McpWorkflowPageSchema = publicView.shape.pages.element
  .extend({
    workId: z.string().min(1).max(128),
    membership: hash,
    contextRevision: hash,
    fingerprint: hash,
    sourceFingerprint: hash,
  })
  .strict();
export type McpWorkflowPage = z.infer<typeof McpWorkflowPageSchema>;
const storedStep = publicView.shape.steps.element
  .extend({
    stageIndex: z.number().int().nonnegative(),
    pageIndex: z.number().int().nonnegative(),
    attemptId: z.uuid().nullable(),
  })
  .strict();
export type McpWorkflowStep = z.infer<typeof storedStep>;
export const McpWorkflowRecordSchema = z
  .object({
    format: z.literal(1),
    id: z.uuid(),
    owner: z.string().min(1).max(128),
    version: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    input: McpWorkflowPrepareSchema,
    inputFingerprint: hash,
    settingsFingerprint: hash,
    pages: z.array(McpWorkflowPageSchema).min(1).max(50),
    steps: z.array(storedStep).min(1).max(250),
    status: publicView.shape.status,
    lastError: z.string().max(128).nullable(),
    pageAttemptsUsed: z.number().int().nonnegative().max(500),
    translationRequestsReserved: z.number().int().nonnegative().max(5000),
    requests: z
      .array(z.object({ requestId: z.uuid(), fingerprint: hash }).strict())
      .max(64),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.inputFingerprint !== hashStableValue(value.input) ||
      value.steps.length !== value.pages.length * value.input.stages.length ||
      value.pages.length !==
        value.input.chapters.reduce(
          (n, chapter) => n + chapter.pages.length,
          0,
        ) ||
      value.steps.some(
        (step, index) =>
          step.index !== index ||
          step.pageIndex !== index % value.pages.length ||
          step.stageIndex !== Math.floor(index / value.pages.length) ||
          step.stage !== value.input.stages[step.stageIndex]?.kind ||
          step.pageId !== value.pages[step.pageIndex]?.pageId ||
          step.chapterId !== value.pages[step.pageIndex]?.chapterId,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Inconsistent fixed workflow plan.",
      });
    if (
      new Set(value.requests.map((request) => request.requestId)).size !==
      value.requests.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Duplicate workflow action receipts.",
      });
  });
export type McpWorkflowRecord = z.infer<typeof McpWorkflowRecordSchema>;
export type McpWorkflowOutcome = {
  revision: string;
  outputId?: string;
  changeId?: string;
};
export function workflowSteps(
  input: McpWorkflowRecord["input"],
  pages: McpWorkflowPage[],
) {
  return input.stages.flatMap((stage, stageIndex) =>
    pages.map((page, pageIndex) => ({
      index: stageIndex * pages.length + pageIndex,
      stage: stage.kind,
      stageIndex,
      pageIndex,
      chapterId: page.chapterId,
      pageId: page.pageId,
      status: "pending" as const,
      attempts: 0,
      attemptId: null,
      jobId: null,
      outputId: null,
      changeId: null,
      errorCode: null,
    })),
  );
}
export function workflowView(
  record: McpWorkflowRecord,
  active?: { pause: boolean; controller: AbortController },
) {
  const view = {
    id: record.id,
    version: record.version,
    reason: record.input.reason,
    status: active
      ? "running"
      : record.status === "running"
        ? "interrupted"
        : record.status,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    pageCount: record.pages.length,
    stages: record.input.stages,
    completedSteps: record.steps.filter((step) => step.status === "completed")
      .length,
    totalSteps: record.steps.length,
    pageAttemptsUsed: record.pageAttemptsUsed,
    translationRequestsReserved: record.translationRequestsReserved,
    maxPageAttempts: record.input.maxPageAttempts,
    maxTranslationRequests: record.input.maxTranslationRequests,
    pauseRequested: active?.pause ?? false,
    cancellationRequested: active?.controller.signal.aborted ?? false,
    activeStep:
      record.steps.find(
        (step) =>
          step.status === "running" || step.status === "waiting_external",
      )?.index ?? null,
    lastError: record.lastError,
    pages: record.pages.map(
      ({ chapterId, pageId, revision, reviewRevision }) => ({
        chapterId,
        pageId,
        revision,
        reviewRevision,
      }),
    ),
    steps: record.steps.map(
      ({
        stageIndex: _stage,
        pageIndex: _page,
        attemptId: _attempt,
        ...step
      }) => step,
    ),
    warnings: [
      "explicit_resume_only",
      "native_operations_sequential",
      "saved_memory_not_regenerated",
      "pause_is_not_undo",
      "uncertain_attempts_require_review",
      "page_attempts_are_not_model_token_costs",
    ],
  };
  return publicView.parse(view);
}
export function assertWorkflowVersion(
  record: McpWorkflowRecord,
  version: number,
) {
  if (record.version !== version)
    throw new McpEditError(
      "revision_conflict",
      "Workflow changed. Read its current version before resuming.",
    );
}
export function workflowError(error: unknown): string {
  return error instanceof McpEditError ? error.code : "workflow_step_failed";
}
