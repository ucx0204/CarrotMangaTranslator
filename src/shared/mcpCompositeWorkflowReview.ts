import { z } from "zod/v4";
import {
  McpCompositeIdentifierSchema as id,
  McpCompositeFingerprintSchema as fingerprint,
  McpCompositeMutationSchema,
} from "./mcpCompositeWorkflow";

const revision = z.string().regex(/^page-v1:[a-f0-9]{16}$/);
/** Issued by the native renderer adapter, never accepted from host report input. */
export const McpCompositeRenderEvidenceSchema = z
  .object({
    id: z.uuid(),
    owner: id,
    compositeId: z.uuid(),
    phaseId: id,
    pass: z.number().int().min(1).max(3),
    kind: z.literal("rendered-page"),
    workId: id,
    chapterId: id,
    pageId: id,
    revision,
    reviewRevision: revision,
    sourceFingerprint: fingerprint,
    contextFingerprint: fingerprint,
    settingsFingerprint: fingerprint,
    fontFingerprint: fingerprint,
    fontEvidence: z
      .object({
        appManaged: z.literal("bytes-sha256"),
        systemFallback: z.literal("native-render-pixels-only"),
      })
      .strict(),
    sha256: fingerprint,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    pixelMapping: z
      .object({
        originX: z.number().finite(),
        originY: z.number().finite(),
        scaleX: z.number().positive(),
        scaleY: z.number().positive(),
      })
      .strict(),
    renderOptionsFingerprint: fingerprint,
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type McpCompositeRenderEvidence = z.infer<
  typeof McpCompositeRenderEvidenceSchema
>;
export const McpCompositeFindingSchema = z
  .object({
    chapterId: id,
    pageId: id,
    blockId: id.optional(),
    category: z.enum([
      "translation",
      "overflow",
      "typography",
      "lettering",
      "sound-effect",
      "other",
    ]),
    severity: z.enum(["blocking", "advisory"]),
    message: z.string().trim().min(1).max(1000),
  })
  .strict();
export const McpCompositeReviewReportSchema = McpCompositeMutationSchema.extend(
  {
    phaseId: id,
    pass: z.number().int().min(1).max(3),
    reviewerKind: z.literal("connected-ai"),
    verdictOrigin: z.literal("host-reported"),
    verdict: z.enum(["accepted", "needs-correction", "blocked"]),
    assessments: z
      .array(
        z.object({ chapterId: id, pageId: id, evidenceId: z.uuid() }).strict(),
      )
      .min(1)
      .max(50),
    findings: z.array(McpCompositeFindingSchema).max(250),
    findingsOverflow: z.boolean(),
  },
).strict();
export type McpCompositeReviewReport = z.infer<
  typeof McpCompositeReviewReportSchema
>;
