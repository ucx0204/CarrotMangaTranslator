import { z } from "zod";
import { finiteNumber, storeId, visualClusterId } from "./ipcSchemaPrimitives";
import {
  FONT_MATCHING_PALETTE_ROLES,
  FONT_MATCHING_SEMANTIC_ROLES,
  FONT_MATCHING_SOURCE_STYLE_AXES,
} from "./fontMatchingProfileTypes";

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

export const FontMatchingSemanticRoleSchema = z.enum([
  ...FONT_MATCHING_SEMANTIC_ROLES,
]);
export const FontMatchingPaletteRoleSchema = z.enum([
  ...FONT_MATCHING_PALETTE_ROLES,
]);
export const FontMatchingSourceStyleAxisSchema = z.enum([
  ...FONT_MATCHING_SOURCE_STYLE_AXES,
]);

const FontStyleSelectionV2Schema = z
  .object({
    fontId,
    fontWeight: z.number().int().min(100).max(900).optional(),
    italic: z.boolean().optional(),
    outlineWidthScale: finiteNumber.min(0).max(8).optional(),
  })
  .strict();

const TypographyAnchorV2Schema = z
  .object({
    primaryFontId: fontId,
    allowedFontIds: uniqueFontIds(1, 4),
    origin: z.enum(["learned", "manual", "migrated"]),
    evidenceCount: z.number().int().min(0).max(1_000_000),
    confidence: probability,
    replacementPolicy: z
      .object({
        minimumEvidenceCount: z.number().int().min(1).max(10_000),
        minimumScoreMargin: probability,
      })
      .strict(),
    updatedAt: timestamp,
  })
  .strict()
  .superRefine((anchor, context) => {
    if (!anchor.allowedFontIds.includes(anchor.primaryFontId)) {
      context.addIssue({
        code: "custom",
        path: ["allowedFontIds"],
        message: "allowedFontIds must include primaryFontId",
      });
    }
  });

const RoleFontPaletteV2Schema = z
  .object({
    role: FontMatchingPaletteRoleSchema,
    allowedFontIds: uniqueFontIds(2, 4),
    maxDistinctFonts: z.number().int().min(2).max(4),
    reuseVisualClusterFont: z.literal(true),
    evidenceCount: z.number().int().min(0).max(1_000_000),
    confidence: probability,
  })
  .strict()
  .superRefine((palette, context) => {
    if (palette.maxDistinctFonts > palette.allowedFontIds.length) {
      context.addIssue({
        code: "custom",
        path: ["maxDistinctFonts"],
        message: "maxDistinctFonts cannot exceed the palette size",
      });
    }
  });

const overrideScopeSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("block"),
      chapterId: storeId,
      pageId: storeId,
      blockId: storeId,
    })
    .strict(),
  z.object({ type: z.literal("visual_cluster"), visualClusterId }).strict(),
]);

const intentionalOverrideSchema = z
  .object({
    id: storeId,
    scope: overrideScopeSchema,
    role: FontMatchingSemanticRoleSchema,
    selection: FontStyleSelectionV2Schema,
    reasonCode,
    origin: z.enum(["model", "user", "adjudicated"]),
    confidence: probability,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

const userLockSchema = z
  .object({
    id: storeId,
    scope: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("role"),
          role: FontMatchingSemanticRoleSchema,
        })
        .strict(),
      z
        .object({
          type: z.literal("block"),
          chapterId: storeId,
          pageId: storeId,
          blockId: storeId,
        })
        .strict(),
    ]),
    selection: FontStyleSelectionV2Schema,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

const orientationPolicySchema = z
  .object({
    horizontalAllowedFontIds: uniqueFontIds().nullable(),
    verticalAllowedFontIds: uniqueFontIds().nullable(),
    verticalOnlyFontIds: uniqueFontIds(),
  })
  .strict()
  .superRefine((policy, context) => {
    const horizontal = new Set(policy.horizontalAllowedFontIds ?? []);
    if (policy.verticalOnlyFontIds.some((id) => horizontal.has(id))) {
      context.addIssue({
        code: "custom",
        path: ["horizontalAllowedFontIds"],
        message: "vertical-only fonts cannot be horizontally allowlisted",
      });
    }
  });

const genrePriorSchema = z
  .object({
    source: z.enum(["manual", "context_model"]),
    labels: z
      .array(
        z
          .object({ label: z.string().trim().min(1).max(100), probability })
          .strict(),
      )
      .max(30),
    styleBias: z.record(FontMatchingSourceStyleAxisSchema, boundedScore),
    maxScoreContribution: finiteNumber.min(0).max(0.1),
  })
  .strict();

const workTypographyProfileV2ObjectSchema = z
  .object({
    schemaVersion: z.literal(2),
    workId: storeId,
    dialogueAnchor: TypographyAnchorV2Schema.nullable(),
    narrationAnchor: TypographyAnchorV2Schema.nullable(),
    thoughtAnchor: TypographyAnchorV2Schema.nullable(),
    rolePalettes: z
      .array(RoleFontPaletteV2Schema)
      .max(FONT_MATCHING_PALETTE_ROLES.length),
    intentionalOverrides: z.array(intentionalOverrideSchema).max(100_000),
    userLocks: z.array(userLockSchema).max(100_000),
    orientationPolicy: orientationPolicySchema,
    consistencyPolicy: z
      .object({
        reuseBodyAnchors: z.literal(true),
        requireIntentionalOverrideForBodySwitch: z.literal(true),
        reuseVisualClusterFont: z.literal(true),
        maxAccentFontsPerRole: z.number().int().min(2).max(4),
      })
      .strict(),
    genrePrior: genrePriorSchema.nullable(),
    evidenceCount: z.number().int().min(0).max(10_000_000),
    confidence: probability,
    catalogVersion: versionId,
    modelVersion: versionId,
    rendererHash: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

export const WorkTypographyProfileV2Schema =
  workTypographyProfileV2ObjectSchema.superRefine(validateProfileCollections);

function validateProfileCollections(
  profile: z.infer<typeof workTypographyProfileV2ObjectSchema>,
  context: z.RefinementCtx,
): void {
  validateUnique(
    profile.rolePalettes.map((item) => item.role),
    "rolePalettes",
    context,
  );
  validateUnique(
    profile.intentionalOverrides.map((item) => item.id),
    "intentionalOverrides",
    context,
  );
  validateUnique(
    profile.intentionalOverrides.map((item) => scopeKey(item.scope)),
    "intentionalOverrides.scope",
    context,
  );
  validateUnique(
    profile.userLocks.map((item) => item.id),
    "userLocks",
    context,
  );
  const lockScopes = profile.userLocks.map((lock) => scopeKey(lock.scope));
  validateUnique(lockScopes, "userLocks", context);
  if (
    profile.intentionalOverrides.some(
      (item) => item.role === "unknown_needs_review",
    ) ||
    profile.userLocks.some(
      (lock) =>
        lock.scope.type === "role" &&
        lock.scope.role === "unknown_needs_review",
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["userLocks"],
      message: "unknown_needs_review cannot be persisted as a work policy",
    });
  }
  validatePaletteLimits(profile, context);
  validateRepeatedAnchors(profile, context);
  validateUnique(
    profile.genrePrior?.labels.map((label) => label.label) ?? [],
    "genrePrior.labels",
    context,
  );
}

function scopeKey(
  scope:
    | { type: "role"; role: string }
    | { type: "visual_cluster"; visualClusterId: string }
    | { type: "block"; chapterId: string; pageId: string; blockId: string },
): string {
  if (scope.type === "role") {
    return `role:${scope.role}`;
  }
  if (scope.type === "visual_cluster") {
    return `visual_cluster:${scope.visualClusterId}`;
  }
  return `block:${scope.chapterId}:${scope.pageId}:${scope.blockId}`;
}

function validatePaletteLimits(
  profile: z.infer<typeof workTypographyProfileV2ObjectSchema>,
  context: z.RefinementCtx,
): void {
  if (
    profile.rolePalettes.some(
      (palette) =>
        palette.maxDistinctFonts >
        profile.consistencyPolicy.maxAccentFontsPerRole,
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["rolePalettes"],
      message: "palette limits cannot exceed the work consistency policy",
    });
  }
}

function validateRepeatedAnchors(
  profile: z.infer<typeof workTypographyProfileV2ObjectSchema>,
  context: z.RefinementCtx,
): void {
  for (const key of ["narrationAnchor", "thoughtAnchor"] as const) {
    const anchor = profile[key];
    if (anchor?.origin === "learned" && anchor.evidenceCount < 2) {
      context.addIssue({
        code: "custom",
        path: [key, "evidenceCount"],
        message: "learned narration/thought anchors require repeated evidence",
      });
    }
  }
}

function validateUnique(
  values: string[],
  path: string,
  context: z.RefinementCtx,
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({
      code: "custom",
      path: [path],
      message: `${path} entries must be unique`,
    });
  }
}
