import { z } from "zod/v4";
import {
  McpCompositePrepareSchema,
  McpCompositePageSchema,
  McpCompositeChildReferenceSchema,
  McpCompositeIdentifierSchema as id,
  McpCompositeFingerprintSchema as fingerprint,
  McpCompositeCountSchema as count,
  MCP_COMPOSITE_BYTES,
} from "../../shared/mcpCompositeWorkflow";
import { McpCompositeOutcomeSchema } from "../../shared/mcpCompositeWorkflowOutcome";
import { McpCompositeWorkflowActionKindSchema } from "../../shared/mcpCompositeWorkflowActions";
import {
  McpCompositeRenderEvidenceSchema,
  McpCompositeReviewReportSchema,
} from "../../shared/mcpCompositeWorkflowReview";
import {
  validateCompositeRecord,
  validateCompositeConsistency,
} from "./mcpCompositeWorkflowRecordValidation";
import type { McpCompositeRecord } from "./mcpCompositeWorkflowPorts";

const bounded = count.max(Number.MAX_SAFE_INTEGER);
const McpCompositeCostSchema = z
  .object({
    admissions: count.max(500),
    pageAttempts: count.max(500),
    translationRequests: count.max(5000),
    researchAttempts: count.max(30),
    selectedEdits: count.max(5000),
    pageEdits: z
      .array(
        z.object({ chapterId: id, pageId: id, edits: count.max(100) }).strict(),
      )
      .max(50),
    models: z
      .object({
        ocr: count.max(5000),
        translation: count.max(5000),
        erase: count.max(5000),
        research: count.max(30),
        typography: count.max(5000),
        soundEffect: count.max(5000),
      })
      .strict(),
  })
  .strict()
  .superRefine((cost, context) => {
    if (
      cost.pageEdits.reduce((sum, page) => sum + page.edits, 0) !==
        cost.selectedEdits ||
      new Set(cost.pageEdits.map((page) => `${page.chapterId}/${page.pageId}`))
        .size !== cost.pageEdits.length
    )
      context.addIssue({
        code: "custom",
        message: "Native selected-edit cost needs an exact page allocation.",
      });
  });
const revision = z.string().regex(/^page-v1:[a-f0-9]{16}$/);
const McpCompositeSnapshotSchema = z
  .object({
    fingerprint,
    policyFingerprint: fingerprint,
    pages: z
      .array(
        McpCompositePageSchema.extend({
          revision,
          reviewRevision: revision,
          sourceFingerprint: fingerprint,
          membershipFingerprint: fingerprint,
          memoryFingerprint: fingerprint,
          contextFingerprint: fingerprint,
          settingsFingerprint: fingerprint,
          fontFingerprint: fingerprint,
        }),
      )
      .max(50),
  })
  .strict();
const McpCompositeSavedBindingSchema = z
  .object({
    owner: id,
    compositeId: z.uuid(),
    phaseId: id,
    family: McpCompositeWorkflowActionKindSchema,
    inputFingerprint: fingerprint,
    nativeReference: z
      .object({
        requestId: z.uuid(),
        kind: id,
        fingerprint: z.string().regex(/^[a-f0-9]{16}$/),
      })
      .strict()
      .nullable(),
    nativeRequestId: z.uuid(),
    snapshot: McpCompositeSnapshotSchema,
    predecessorReceipts: z.array(McpCompositeChildReferenceSchema).max(32),
    cost: McpCompositeCostSchema,
  })
  .strict();
const phase = z
  .object({
    id,
    status: z.enum([
      "unbound",
      "bound",
      "running",
      "awaiting-review",
      "completed",
      "skipped",
      "held",
    ]),
    binding: McpCompositeSavedBindingSchema.optional(),
    attemptId: z.uuid().optional(),
    child: McpCompositeChildReferenceSchema.optional(),
    outcome: McpCompositeOutcomeSchema.optional(),
    evidence: z
      .array(McpCompositeRenderEvidenceSchema)
      .min(1)
      .max(50)
      .optional(),
    report: McpCompositeReviewReportSchema.optional(),
  })
  .strict();
export const McpCompositeRecordSchema = z
  .object({
    format: z.literal(1),
    kind: z.literal("composite-workflow"),
    id: z.uuid(),
    owner: id,
    version: bounded,
    createdAt: bounded,
    updatedAt: bounded,
    expiresAt: bounded,
    plan: McpCompositePrepareSchema,
    initialFingerprint: fingerprint,
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
    snapshot: McpCompositeSnapshotSchema,
    targets: z.array(McpCompositePageSchema).max(50),
    phases: z.array(phase).min(1).max(32),
    used: McpCompositeCostSchema,
    usageUnknown: z.boolean(),
    reviewPairs: z.array(fingerprint).max(3),
    actions: z
      .array(z.object({ requestId: z.uuid(), fingerprint }).strict())
      .max(128),
  })
  .strict()
  .superRefine(validateCompositeRecord)
  .superRefine(validateCompositeConsistency);
export function parseCompositeRecord(value: unknown): McpCompositeRecord {
  const record = McpCompositeRecordSchema.parse(value);
  if (Buffer.byteLength(JSON.stringify(record), "utf8") > MCP_COMPOSITE_BYTES)
    throw new Error("Composite metadata exceeds one MiB.");
  return record;
}
