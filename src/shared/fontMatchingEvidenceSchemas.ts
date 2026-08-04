import { z } from "zod";
import { finiteNumber, storeId } from "./ipcSchemaPrimitives";
import {
  FONT_MATCHING_SEMANTIC_ROLES,
  FONT_MATCHING_SOURCE_STYLE_AXES,
} from "./fontMatchingProfileTypes";
import {
  FontMatchingSemanticRoleSchema,
  FontMatchingSourceStyleAxisSchema,
} from "./fontMatchingProfileSchemas";

const probability = finiteNumber.min(0).max(1);
const boundedScore = finiteNumber.min(-1).max(1);
const fontId = z.string().trim().min(1).max(200);
const versionId = z.string().trim().min(1).max(200);
const timestamp = z.string().datetime({ offset: true });
const reasonCode = z.string().trim().min(1).max(200);

function uniqueFontIds(minimum = 0, maximum = 15) {
  return z
    .array(fontId)
    .min(minimum)
    .max(maximum)
    .refine((values) => new Set(values).size === values.length, {
      message: "font ids must be unique",
    });
}

const FontMatchingSourceStyleV2Schema = z
  .object({
    serifness: probability.nullable(),
    weight: probability.nullable(),
    width: probability.nullable(),
    roundness: probability.nullable(),
    strokeContrast: probability.nullable(),
    handwritten: probability.nullable(),
    angularity: probability.nullable(),
    irregularity: probability.nullable(),
    slant: probability.nullable(),
    energy: probability.nullable(),
    unknownFields: z
      .array(FontMatchingSourceStyleAxisSchema)
      .max(FONT_MATCHING_SOURCE_STYLE_AXES.length),
  })
  .strict()
  .superRefine((style, context) => {
    const unknown = new Set(style.unknownFields);
    if (unknown.size !== style.unknownFields.length) {
      context.addIssue({
        code: "custom",
        message: "unknownFields must be unique",
      });
    }
    for (const axis of FONT_MATCHING_SOURCE_STYLE_AXES) {
      if ((style[axis] === null) !== unknown.has(axis)) {
        context.addIssue({
          code: "custom",
          path: [axis],
          message: "null style axes must match unknownFields",
        });
      }
    }
  });

const FontMatchingTreatmentV2Schema = z
  .object({
    orientation: z.enum(["horizontal", "vertical"]),
    outline: z.enum(["none", "single", "multiple", "unknown"]),
    shadow: z.enum(["none", "hard", "soft", "unknown"]),
    fill: z.enum(["solid", "gradient", "pattern", "unknown"]),
    distortion: z.enum(["none", "perspective", "curved", "warped", "unknown"]),
    polarity: z.enum(["normal", "inverse", "unknown"]),
    colorMode: z.enum(["monochrome", "color", "unknown"]),
  })
  .strict();

const rolePredictionSchema = z
  .object({
    primary: FontMatchingSemanticRoleSchema,
    confidence: probability,
    alternatives: z
      .array(
        z
          .object({
            role: FontMatchingSemanticRoleSchema,
            confidence: probability,
          })
          .strict(),
      )
      .max(FONT_MATCHING_SEMANTIC_ROLES.length - 1),
  })
  .strict()
  .superRefine((prediction, context) => {
    const roles = [
      prediction.primary,
      ...prediction.alternatives.map((item) => item.role),
    ];
    if (new Set(roles).size !== roles.length) {
      context.addIssue({
        code: "custom",
        message: "predicted roles must be unique",
      });
    }
  });

const RankedFontCandidateV2Schema = z
  .object({
    rank: z.number().int().min(1).max(1000),
    rawPixelRank: z.number().int().min(1).max(1000).optional(),
    rawPixelScore: probability.optional(),
    fontId,
    renderStatus: z.enum(["rendered", "unrenderable"]),
    unrenderableReason: z.string().trim().min(1).max(1000).nullable(),
    styleFit: boundedScore,
    roleFit: boundedScore,
    layoutFit: boundedScore.nullable(),
    glyphCoverage: probability.nullable(),
    workProfileFit: boundedScore,
    userPreferenceFit: boundedScore,
    genrePriorContribution: finiteNumber.min(-0.1).max(0.1),
    switchPenalty: finiteNumber.min(-1).max(0),
    totalScore: finiteNumber,
    confidence: probability,
    reasonCodes: z.array(reasonCode).max(50),
  })
  .strict()
  .superRefine((candidate, context) => {
    const hasReason = candidate.unrenderableReason !== null;
    if ((candidate.renderStatus === "unrenderable") !== hasReason) {
      context.addIssue({
        code: "custom",
        path: ["unrenderableReason"],
        message:
          "unrenderable candidates require a reason and rendered candidates forbid it",
      });
    }
  });

const topCandidateIds = uniqueFontIds(1, 3);
const decisionSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("apply"),
      selectedFontId: fontId,
      topCandidateFontIds: topCandidateIds,
      noneAcceptable: z.literal(false),
      abstainReason: z.null(),
      resolvedBy: z.enum([
        "block_user_lock",
        "work_role_user_lock",
        "work_profile",
        "v2_automatic",
      ]),
    })
    .strict(),
  z
    .object({
      mode: z.literal("suggest"),
      selectedFontId: z.null(),
      topCandidateFontIds: topCandidateIds,
      noneAcceptable: z.literal(false),
      abstainReason: z.null(),
      resolvedBy: z.literal("user_default_or_top3"),
    })
    .strict(),
  z
    .object({
      mode: z.literal("abstain"),
      selectedFontId: z.null(),
      topCandidateFontIds: uniqueFontIds(0, 3),
      noneAcceptable: z.boolean(),
      abstainReason: z.enum([
        "no_acceptable_candidate",
        "low_confidence",
        "unrenderable_translation",
        "role_unknown",
        "profile_conflict",
        "catalog_mismatch",
      ]),
      resolvedBy: z.literal("user_default_or_top3"),
    })
    .strict(),
]);

const fontMatchDecisionEvidenceV2ObjectSchema = z
  .object({
    schemaVersion: z.literal(2),
    workId: storeId,
    chapterId: storeId,
    pageId: storeId,
    blockId: storeId,
    role: rolePredictionSchema,
    sourceStyle: FontMatchingSourceStyleV2Schema,
    treatment: FontMatchingTreatmentV2Schema,
    rankedCandidates: z.array(RankedFontCandidateV2Schema).max(1000),
    decision: decisionSchema,
    catalogVersion: versionId,
    modelVersion: versionId,
    rendererHash: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: timestamp,
  })
  .strict();

export const FontMatchDecisionEvidenceV2Schema =
  fontMatchDecisionEvidenceV2ObjectSchema.superRefine(validateDecisionEvidence);

function validateDecisionEvidence(
  evidence: z.infer<typeof fontMatchDecisionEvidenceV2ObjectSchema>,
  context: z.RefinementCtx,
): void {
  const fonts = evidence.rankedCandidates.map((candidate) => candidate.fontId);
  const ranks = evidence.rankedCandidates.map((candidate) => candidate.rank);
  if (
    new Set(fonts).size !== fonts.length ||
    new Set(ranks).size !== ranks.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["rankedCandidates"],
      message: "candidate fonts and ranks must be unique",
    });
  }
  const sortedRanks = [...ranks].sort((left, right) => left - right);
  if (sortedRanks.some((rank, index) => rank !== index + 1)) {
    context.addIssue({
      code: "custom",
      path: ["rankedCandidates"],
      message: "candidate ranks must be contiguous from one",
    });
  }
  validateDecisionCandidateReferences(evidence, new Set(fonts), context);
  const isNoneReason =
    evidence.decision.abstainReason === "no_acceptable_candidate";
  if (evidence.decision.noneAcceptable !== isNoneReason) {
    context.addIssue({
      code: "custom",
      path: ["decision", "abstainReason"],
      message: "noneAcceptable and no_acceptable_candidate must agree",
    });
  }
  const isUnknownRole = evidence.role.primary === "unknown_needs_review";
  const isExplicitUserLock =
    evidence.decision.mode === "apply" &&
    (evidence.decision.resolvedBy === "block_user_lock" ||
      evidence.decision.resolvedBy === "work_role_user_lock");
  if (
    isUnknownRole &&
    evidence.decision.mode !== "abstain" &&
    !isExplicitUserLock
  ) {
    context.addIssue({
      code: "custom",
      path: ["decision", "abstainReason"],
      message:
        "unknown roles must abstain unless an explicit user lock applies",
    });
  }
  if (evidence.decision.abstainReason === "role_unknown" && !isUnknownRole) {
    context.addIssue({
      code: "custom",
      path: ["decision", "abstainReason"],
      message: "role_unknown requires an unknown role",
    });
  }
}

function validateDecisionCandidateReferences(
  evidence: z.infer<typeof fontMatchDecisionEvidenceV2ObjectSchema>,
  known: Set<string>,
  context: z.RefinementCtx,
): void {
  if (evidence.decision.resolvedBy !== "v2_automatic") {
    return;
  }
  const decisionFonts = [
    evidence.decision.selectedFontId,
    ...evidence.decision.topCandidateFontIds,
  ].filter((value): value is string => value !== null);
  if (decisionFonts.some((id) => !known.has(id))) {
    context.addIssue({
      code: "custom",
      path: ["decision"],
      message: "automatic decisions must reference ranked candidates",
    });
  }
}
