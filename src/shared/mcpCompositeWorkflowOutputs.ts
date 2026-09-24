import { z } from "zod/v4";
import {
  McpCompositeIdentifierSchema as id,
  McpCompositeFingerprintSchema as fingerprint,
  McpCompositeCountSchema as count,
  McpCompositePrepareSchema,
  McpCompositePageSchema,
  McpCompositePhaseSchema,
  McpCompositeBudgetSchema,
  McpCompositeChildReferenceSchema,
  McpCompositeImportPreflightOutputSchema,
} from "./mcpCompositeWorkflow";
import { McpCompositeOutcomeSchema } from "./mcpCompositeWorkflowOutcome";
import { McpCompositeWorkflowActionKindSchema } from "./mcpCompositeWorkflowActions";
import {
  McpCompositeRenderEvidenceSchema,
  McpCompositeFindingSchema,
} from "./mcpCompositeWorkflowReview";
import { mcpReviewOutputSchemas } from "./mcpReviewSchemas";

export const McpCompositeGetSchema = z.object({ id: z.uuid() }).strict();
export const McpCompositeListSchema = z
  .object({
    offset: count.default(0),
    limit: count.min(1).max(25).default(25),
    snapshot: z
      .string()
      .regex(/^[a-f0-9]{16}$/)
      .optional(),
  })
  .strict();
export const McpCompositeReviewGetSchema = McpCompositeListSchema.extend({
  id: z.uuid(),
  phaseId: id,
});
export const McpCompositeEvidenceGetSchema = McpCompositeGetSchema.extend({
  phaseId: id,
  evidenceId: z.uuid(),
});
export const McpCompositeNativeReviewSchema = McpCompositeGetSchema.extend({
  offset: count.default(0),
  limit: count.min(1).max(25).default(25),
  snapshot: fingerprint.optional(),
});
export const McpCompositeDiscardSchema = McpCompositeGetSchema.extend({
  confirm: z.literal(true),
});

const phaseStatus = z.enum([
  "unbound",
  "bound",
  "running",
  "awaiting-review",
  "completed",
  "skipped",
  "held",
]);
const reported = z
  .object({
    reviewerKind: z.literal("connected-ai"),
    verdictOrigin: z.literal("host-reported"),
    verdict: z.enum(["accepted", "needs-correction", "blocked"]),
    findingsCount: count.max(250),
    findingsOverflow: z.boolean(),
  })
  .strict();
const binding = z
  .object({
    family: McpCompositeWorkflowActionKindSchema,
    nativeRequestId: z.uuid(),
    inputFingerprint: fingerprint,
    snapshot: fingerprint,
  })
  .strict();
const phase = z
  .object({
    descriptor: McpCompositePhaseSchema,
    status: phaseStatus,
    binding: binding.optional(),
    attemptId: z.uuid().optional(),
    child: McpCompositeChildReferenceSchema.optional(),
    outcome: McpCompositeOutcomeSchema.optional(),
    evidenceCount: count.max(50),
    report: reported.optional(),
  })
  .strict();
const summary = z
  .object({
    kind: z.literal("composite-workflow"),
    format: z.literal(1),
    id: z.uuid(),
    version: count,
    status: z.enum([
      "prepared",
      "running",
      "awaiting-review",
      "paused",
      "held",
      "completed",
      "cancelled",
    ]),
    stopReason: z
      .enum([
        "native-outcome",
        "checkpoint-failed",
        "interrupted",
        "no-progress",
        "oscillation",
        "review-blocked",
        "budget",
      ])
      .optional(),
    createdAt: count,
    updatedAt: count,
    expiresAt: count,
    pageCount: count.max(50),
    phaseCount: count.min(1).max(32),
    completedPhases: count.max(32),
    usageUnknown: z.boolean(),
    retention: z.literal(
      "seven-days; same-profile-and-owner; no-automatic-reexecution",
    ),
    automaticResume: z.literal(false),
    crossOwnerHandoff: z.literal(false),
  })
  .strict();
export const McpCompositeViewSchema = summary.extend({
  plan: McpCompositePrepareSchema,
  snapshot: fingerprint,
  targets: z.array(McpCompositePageSchema).max(50),
  phases: z.array(phase).min(1).max(32),
  used: McpCompositeBudgetSchema.extend({ admissions: count.max(500) }),
});
const window = {
  snapshot: z.string().regex(/^[a-f0-9]{16}$/),
  total: count,
  offset: count,
  limit: count.min(1).max(25),
  nextOffset: count.nullable(),
};
const evidence = McpCompositeRenderEvidenceSchema.omit({ owner: true });
const review = z
  .object({
    id: z.uuid(),
    version: count,
    phaseId: id,
    status: phaseStatus,
    evidence: z.array(evidence).max(50),
    report: reported.optional(),
    findings: z
      .object({ ...window, items: z.array(McpCompositeFindingSchema).max(25) })
      .strict(),
    observation: z.literal(
      "metadata-only; retrieve-issued-render-image-before-host-assessment",
    ),
  })
  .strict();
export const mcpCompositeWorkflowOutputs = {
  carrot_preflight_composite_import: McpCompositeImportPreflightOutputSchema,
  carrot_prepare_composite: McpCompositeViewSchema,
  carrot_bind_composite: McpCompositeViewSchema,
  carrot_run_composite: McpCompositeViewSchema,
  carrot_resume_composite: McpCompositeViewSchema,
  carrot_get_composite: McpCompositeViewSchema,
  carrot_pause_composite: McpCompositeViewSchema,
  carrot_cancel_composite: McpCompositeViewSchema,
  carrot_reconcile_composite: McpCompositeViewSchema,
  carrot_submit_composite_review: McpCompositeViewSchema,
  carrot_list_composites: z
    .object({ ...window, items: z.array(summary).max(25) })
    .strict(),
  carrot_get_composite_review: review,
  carrot_get_composite_native_review: z
    .object({
      id: z.uuid(),
      version: count,
      snapshot: fingerprint,
      scope: z.literal("selected-saved-metadata-only"),
      total: count.max(50),
      offset: count,
      limit: count.min(1).max(25),
      nextOffset: count.nullable(),
      pages: z
        .array(
          z
            .object({
              workId: id,
              chapterId: id,
              blockScope: z.literal("whole-page-saved-metadata"),
              review:
                mcpReviewOutputSchemas.carrot_get_chapter_review.shape.pages
                  .element,
            })
            .strict(),
        )
        .max(25),
      checked: z.tuple([
        z.literal("saved-page-metadata"),
        z.literal("current-parent-source-binding"),
      ]),
      notChecked: z.tuple([
        z.literal("existing-app-export-preflight"),
        z.literal("image-file-readability"),
        z.literal("renderer-and-font-assets"),
        z.literal("live-job-or-unsaved-editor-state"),
        z.literal("image-transfer-permission-and-redaction"),
        z.literal("model-readiness"),
        z.literal("translation-quality"),
      ]),
      executionReserved: z.literal(false),
    })
    .strict(),
  carrot_get_composite_review_image: z
    .object({
      id: z.uuid(),
      version: count,
      evidence,
      verification: z.literal("current-source-and-permission-rechecked"),
      qualityVerdict: z.literal("host-assessment-required"),
    })
    .strict(),
  carrot_discard_composite: z
    .object({
      id: z.uuid(),
      status: z.literal("discarded"),
      pageChanges: z.literal(0),
    })
    .strict(),
};
